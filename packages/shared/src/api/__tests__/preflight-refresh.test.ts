// @vitest-environment jsdom
// U352 回归锁：预判式刷新（token 已过期 → refreshToken）成功后，必须继续走完请求注入链
// （Authorization=新 token + X-Tenant-ID + X-Namespace + params snakeCase），
// 不得提前 return —— 旧实现在此行 `return config` 跳过后方全部注入。
//
// 断言口径：走真实拦截器（只替换 axios adapter，同 contract.test.ts 先例）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient } from '../client';
import { AuthService } from '../../auth/service';
import { useAuthStore } from '../../auth/store';
import { API_NAMESPACE } from '../../config';

interface Captured {
	url: string;
	headers: Record<string, unknown>;
	params?: Record<string, unknown>;
}

let captured: Captured[];
let originalAdapter: unknown;

function installCaptureAdapter() {
	originalAdapter = apiClient.defaults.adapter;
	apiClient.defaults.adapter = (async (config: any) => {
		const headers = config.headers?.toJSON ? config.headers.toJSON() : { ...config.headers };
		captured.push({
			url: String(config.url || ''),
			headers: headers as Record<string, unknown>,
			params: config.params,
		});
		return {
			data: { code: 0, message: 'success' },
			status: 200,
			statusText: 'OK',
			headers: {},
			config,
		};
	}) as any;
}

function expiredJwt(): string {
	const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }));
	return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

function liveJwt(): string {
	const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
	return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

describe('U352: 预刷新成功后注入链完整性', () => {
	beforeEach(() => {
		captured = [];
		installCaptureAdapter();
		useAuthStore.getState().clearAuth();
		useAuthStore.getState().setAuth(expiredJwt(), 'rt-old', {
			id: 'u-1',
			username: 'demo',
		} as any);
		useAuthStore.getState().setCurrentTenant('tenant-abc');
	});

	afterEach(() => {
		apiClient.defaults.adapter = originalAdapter as any;
		vi.restoreAllMocks();
		useAuthStore.getState().clearAuth();
	});

	it('刷新成功：Authorization=新 token 且租户/namespace/snake 注入不缺席', async () => {
		const refresh = vi.spyOn(AuthService, 'refreshToken').mockResolvedValue('FRESH-TOKEN');
		await apiClient.get('/secret/api/v1/admin/keys', { params: { pageSize: 5 } });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(captured).toHaveLength(1);
		expect(captured[0].headers['Authorization']).toBe('Bearer FRESH-TOKEN');
		expect(captured[0].headers['X-Tenant-ID']).toBe('tenant-abc');
		expect(captured[0].headers['X-Namespace']).toBe(API_NAMESPACE);
		expect(captured[0].params).toEqual({ page_size: 5 });
	});

	it('刷新失败（返回 null）：回落旧 token，注入链仍完整', async () => {
		const oldToken = useAuthStore.getState().accessToken!;
		vi.spyOn(AuthService, 'refreshToken').mockResolvedValue(null);
		await apiClient.get('/probe/y');
		expect(captured[0].headers['Authorization']).toBe(`Bearer ${oldToken}`);
		expect(captured[0].headers['X-Tenant-ID']).toBe('tenant-abc');
	});

	it('刷新抛错：吞错继续（不冒泡），仍携带旧 token 与租户头', async () => {
		vi.spyOn(AuthService, 'refreshToken').mockRejectedValue(new Error('network'));
		await apiClient.get('/probe/z');
		expect(String(captured[0].headers['Authorization'])).toMatch(/^Bearer /);
		expect(captured[0].headers['X-Tenant-ID']).toBe('tenant-abc');
	});
});

// 地址栏唯一权威（Wave 2）：无 token 的公开认证入口不得被 localStorage 残留租户污染。
describe('无 token 不注入 X-Tenant-ID', () => {
	beforeEach(() => {
		captured = [];
		installCaptureAdapter();
		useAuthStore.getState().clearAuth();
		useAuthStore.getState().setCurrentTenant('tenant-stale');
	});

	afterEach(() => {
		apiClient.defaults.adapter = originalAdapter as any;
		vi.restoreAllMocks();
		useAuthStore.getState().clearAuth();
	});

	it('无 token：残留租户不注入 header', async () => {
		await apiClient.get('/probe/public');
		expect(captured[0].headers['X-Tenant-ID']).toBeUndefined();
		expect(captured[0].headers['Authorization']).toBeUndefined();
	});

	it('调用方显式 X-Tenant-ID 原样保留（不注入也不清除）', async () => {
		await apiClient.get('/probe/public', { headers: { 'X-Tenant-ID': 'explicit-tenant' } });
		expect(captured[0].headers['X-Tenant-ID']).toBe('explicit-tenant');
	});

	it('有 token：仍注入当前租户（内部调用链回归）', async () => {
		useAuthStore.getState().setAuth(liveJwt(), 'rt-live', { id: 'u-1', username: 'demo' } as any);
		await apiClient.get('/probe/authed');
		expect(captured[0].headers['X-Tenant-ID']).toBe('tenant-stale');
		expect(String(captured[0].headers['Authorization'])).toMatch(/^Bearer /);
	});
});
