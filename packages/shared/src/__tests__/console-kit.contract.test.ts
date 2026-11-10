// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAuthStore, getAccessToken, getAuthStorageMode, resetAuthStore, useAuthStore } from '../auth/store';
import { createFetchClient } from '../api/fetch-client';

/**
 * 「控制台套件」契约测试 —— 证明 Wave 2 三项增量**能组合成两站的接入形态**，
 * 而不是三个各自跑通的零件。
 *
 * 场景照配置中心的真实口径搭：
 *   - token 只落 sessionStorage（关标签即失效）
 *   - 请求带 X-App-ID / X-Tenant-ID
 *   - 401 → 静默续期 → 重试一次（页面无感）
 *   - 响应默认透传（不 unwrap、不转键），因为两站后端是 snake_case 直通
 */

const KEY = 'autional-auth-v1';
const USER = { id: 'usr_1', username: 'demo', email: 'demo@example.com', status: 'active' } as never;

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as unknown as Response;
}

describe('console kit 契约：auth(store) + fetch client 组合', () => {
	beforeEach(() => {
		window.localStorage.clear();
		window.sessionStorage.clear();
		resetAuthStore();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('配置中心形态：session 存储 + 作用域头 + 401 静默续期 + 透传响应', async () => {
		// 1) 应用入口：先选存储（在任何读取之前）
		configureAuthStore({ storage: 'session' });
		expect(getAuthStorageMode()).toBe('session');

		// 2) 登录落地：token 只进 sessionStorage
		useAuthStore.getState().setAuth('token-old', 'refresh-1', USER);
		useAuthStore.getState().setCurrentTenant('tenant-1');
		expect(window.sessionStorage.getItem(KEY)).toContain('token-old');
		expect(window.localStorage.getItem(KEY)).toBeNull();

		// 3) 请求层：token 从 shared 取，续期写回 shared store
		const seen: Array<Record<string, string>> = [];
		let round = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				seen.push(init.headers as Record<string, string>);
				round += 1;
				if (round === 1) return jsonResponse({ message: 'token expired' }, 401);
				return jsonResponse({ items: [{ key: 'a', value_type: 'string' }], total: 1 });
			}),
		);

		const client = createFetchClient({
			baseUrl: '/bff/config/api/v1/admin/config',
			getToken: () => getAccessToken(),
			getTenantId: () => useAuthStore.getState().currentTenantId,
			getHeaders: () => ({ 'X-App-ID': 'app-config' }),
			refresh: async () => {
				useAuthStore.getState().setTokens('token-new', 'refresh-1');
				return 'token-new';
			},
		});

		const result = await client.get<{ items: unknown[]; total: number }>('/items', {
			query: { page: 1, page_size: 20 },
		});

		// 4) 续期对页面无感：请求最终成功，且重试用的是新 token
		expect(round).toBe(2);
		expect(seen[0].Authorization).toBe('Bearer token-old');
		expect(seen[1].Authorization).toBe('Bearer token-new');
		expect(seen[0]['X-Tenant-ID']).toBe('tenant-1');
		expect(seen[0]['X-App-ID']).toBe('app-config');
		expect(useAuthStore.getState().accessToken).toBe('token-new');

		// 5) 响应原样透传（不做 camelCase / 不解信封）—— 页面读到的键仍是 snake
		expect(result).toEqual({ items: [{ key: 'a', value_type: 'string' }], total: 1 });
	});

	// 上一版这里只断言 `accessToken==='token-new'`，而写回是测试自己的回调干的（等于自己证自己）。
	// 这条用例把"续期不写回 store"也走一遍：fetch client 必须用 refresh() 的**返回值**重试。
	it('续期回调不写回 store 时，重试仍用 refresh 返回的 token（不依赖 store 已更新）', async () => {
		configureAuthStore({ storage: 'session' });
		useAuthStore.getState().setAuth('token-old', 'refresh', USER);

		const seen: Array<Record<string, string>> = [];
		let round = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				seen.push(init.headers as Record<string, string>);
				round += 1;
				return round === 1 ? jsonResponse({ message: 'expired' }, 401) : jsonResponse({ ok: true });
			}),
		);

		const client = createFetchClient({
			baseUrl: '/api',
			getToken: () => getAccessToken(),
			refresh: async () => 'token-refreshed', // 故意不写回 store
		});

		await expect(client.get('/x')).resolves.toEqual({ ok: true });
		expect(seen[1].Authorization).toBe('Bearer token-refreshed');
		expect(useAuthStore.getState().accessToken).toBe('token-old'); // store 未被偷偷改动
	});

	it('密钥中心形态：local 存储 + 持久化跨实例保持', () => {
		configureAuthStore({ storage: 'local' });
		useAuthStore.getState().setAuth('token-local', 'refresh', USER);

		expect(getAuthStorageMode()).toBe('local');
		expect(window.localStorage.getItem(KEY)).toContain('token-local');
		expect(window.sessionStorage.getItem(KEY)).toBeNull();
	});

	it('两种形态互不串味：同一进程先后建实例时 storage 各自独立', () => {
		configureAuthStore({ storage: 'session' });
		useAuthStore.getState().setAuth('only-session', 'r', USER);

		// 已建实例后再次 configure 不会换存储（避免"一半页面登出"），只告警
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		configureAuthStore({ storage: 'local' });
		expect(getAuthStorageMode()).toBe('session');
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();

		expect(window.localStorage.getItem(KEY)).toBeNull();
	});
});
