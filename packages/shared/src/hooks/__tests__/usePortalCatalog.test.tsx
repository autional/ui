// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePortalCatalog, isPortalVisible, PLATFORM_TENANT_ID } from '../usePortalCatalog';
import { useAuthStore } from '../../auth/store';
import { apiClient } from '../../api/client';

/** 每测试独立 QueryClient（同一 wrapper 引用，避免缓存跨用例串扰） */
function makeWrapper() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return function Wrapper({ children }: { children: React.ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}

function resetAuthStore(): void {
	useAuthStore.setState({
		user: null,
		accessToken: null,
		refreshToken: null,
		tenants: [],
		currentTenantId: null,
		permissions: [],
		isAuthenticated: false,
	});
	window.localStorage.clear();
}

/**
 * 桩 apiClient.get（axios 层）。
 * 解析值形状 = 响应拦截器处理后的产物（unwrapped + camelCase）：
 * - {code,items} → {items,...}；{code,data} → data 本体
 */
let getMock: ReturnType<typeof vi.fn>;

const GET_URL = (call: number) => String(getMock.mock.calls[call]![0]);
const GET_CONFIG = (call: number) => getMock.mock.calls[call]![1] as { params: Record<string, string> };

describe('usePortalCatalog', () => {
	beforeEach(() => {
		resetAuthStore();
		useAuthStore.setState({ accessToken: 'test-token' });
		getMock = vi.fn();
		vi.spyOn(apiClient, 'get').mockImplementation(getMock as unknown as typeof apiClient.get);
	});

	afterEach(() => {
		cleanup();
		resetAuthStore();
		vi.restoreAllMocks();
	});

	it('self 端点：items 形状解析、默认排除 auth/landing/authenticator、order 升序、URL 按 slug 拼装', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'auth', name: 'Sign-in', order: 1 },
					{ code: 'user', name: '用户门户', order: 3 },
					{ code: 'admin', name: '管理控制台', order: 1 },
					{ code: 'landing', name: 'Home', order: 9 },
					{ code: 'authenticator', name: '验证器', order: 2 },
				],
			},
		});
		const { result } = renderHook(
			() => usePortalCatalog({ tenantId: 't1', slug: 'acme-corp', role: 'admin' }),
			{ wrapper: makeWrapper() },
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(getMock).toHaveBeenCalledTimes(1);
		expect(GET_URL(0)).toBe('/tenant/api/v1/tenants/t1/applications');
		expect(GET_CONFIG(0).params).toEqual({
			type: 'portal',
			is_platform: 'true',
			status: 'active',
		});

		// allPortals：可见集合、保持服务端顺序
		expect(result.current.allPortals.map((p) => p.code)).toEqual(['user', 'admin']);
		// portals：order 升序（admin=1, user=3）
		expect(result.current.portals.map((p) => p.code)).toEqual(['admin', 'user']);
		const admin = result.current.portals.find((p) => p.code === 'admin')!;
		expect(admin.url).toBe('http://admin.localhost/acme-corp');
		expect(result.current.isError).toBe(false);
	});

	it('data[] 数组形状容错（部分路径直出数组）', async () => {
		getMock.mockResolvedValue({ data: [{ code: 'user', name: '用户门户', order: 2 }] });
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(1));
		expect(result.current.portals[0]!.code).toBe('user');
	});

	it('业务失败（code!==0）→ isError 且不产出条目', async () => {
		getMock.mockResolvedValue({ data: { code: 40000503, message: 'plane forbidden' } });
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.portals).toEqual([]);
		expect(result.current.allPortals).toEqual([]);
	});

	it('请求异常（axios reject，如 403/网络失败）→ isError（平面错配可降级）', async () => {
		getMock.mockRejectedValue(new Error('Request failed with status code 403'));
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
	});

	it('tenantId / token / enabled 任一缺省 → 不发请求', async () => {
		renderHook(() => usePortalCatalog({ tenantId: null }), { wrapper: makeWrapper() });
		expect(getMock).not.toHaveBeenCalled();

		resetAuthStore();
		renderHook(() => usePortalCatalog({ tenantId: 't1' }), { wrapper: makeWrapper() });
		expect(getMock).not.toHaveBeenCalled();

		useAuthStore.setState({ accessToken: 'test-token' });
		renderHook(() => usePortalCatalog({ tenantId: 't1', enabled: false }), {
			wrapper: makeWrapper(),
		});
		expect(getMock).not.toHaveBeenCalled();
	});

	it('audience=admin → 管理面双入口路径（admin/security/platform 控制台）', async () => {
		getMock.mockResolvedValue({ data: { items: [] } });
		renderHook(() => usePortalCatalog({ tenantId: 't1', audience: 'admin' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
		expect(GET_URL(0)).toBe('/tenant/api/v1/admin/tenants/t1/applications');
	});

	it('exclude 自定义：仅过滤指定 code（不叠加默认排除）', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'admin', name: 'a', order: 1 },
					{ code: 'auth', name: 'b', order: 2 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', exclude: ['admin'] }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.allPortals).toHaveLength(1));
		expect(result.current.allPortals[0]!.code).toBe('auth');
	});

	it('非 slug 白名单门户（status）不拼租户段', async () => {
		getMock.mockResolvedValue({
			data: { items: [{ code: 'status', name: '状态页', order: 1 }] },
		});
		const { result } = renderHook(
			() => usePortalCatalog({ tenantId: 't1', slug: 'acme-corp' }),
			{ wrapper: makeWrapper() },
		);
		await waitFor(() => expect(result.current.portals).toHaveLength(1));
		expect(result.current.portals[0]!.url).toBe('http://status.localhost');
	});

	it('可见性（入口门禁镜像）：member 角色不可见 admin/security/platform，user/status 可见', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'admin', name: '管理控制台', order: 1 },
					{ code: 'security', name: '安全控制台', order: 2 },
					{ code: 'platform', name: '平台控制台', order: 3 },
					{ code: 'user', name: '用户门户', order: 4 },
					{ code: 'status', name: '状态页', order: 5 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(2));
		expect(result.current.portals.map((p) => p.code)).toEqual(['user', 'status']);
		// allPortals 与 portals 同一可见集合（偏好面板不再泄露不可进门户）
		expect(result.current.allPortals.map((p) => p.code)).toEqual(['user', 'status']);
	});

	it('可见性：管理面角色（非平台租户）可管理面门户但不可见 platform', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'admin', name: '管理控制台', order: 1 },
					{ code: 'security', name: '安全控制台', order: 2 },
					{ code: 'platform', name: '平台控制台', order: 3 },
					{ code: 'user', name: '用户门户', order: 4 },
				],
			},
		});
		const { result } = renderHook(
			() => usePortalCatalog({ tenantId: 't1', role: 'security_admin' }),
			{ wrapper: makeWrapper() },
		);
		await waitFor(() => expect(result.current.portals).toHaveLength(3));
		expect(result.current.portals.map((p) => p.code)).toEqual(['admin', 'security', 'user']);
	});

	it('可见性：平台租户成员可见 platform（store tenants 含平台租户 ID）', async () => {
		useAuthStore.setState({
			tenants: [{ id: PLATFORM_TENANT_ID, name: 'platform', role: 'super_admin' }],
			currentTenantId: PLATFORM_TENANT_ID,
		});
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'platform', name: '平台控制台', order: 1 },
					{ code: 'admin', name: '管理控制台', order: 2 },
					{ code: 'user', name: '用户门户', order: 3 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: PLATFORM_TENANT_ID }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(3));
		expect(result.current.portals.map((p) => p.code)).toEqual(['platform', 'admin', 'user']);
	});

	it('可见性：role 显式 null → 管理面门户不可见（按“无角色”过滤）', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'admin', name: '管理控制台', order: 1 },
					{ code: 'user', name: '用户门户', order: 2 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: null }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(1));
		expect(result.current.portals[0]!.code).toBe('user');
	});

	it('allowed_roles 叠加：存在且不含当前角色 → 隐藏（camelCase 键，apiClient 归一后形态）', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'status', name: '状态页', order: 1, config: { portal: { allowedRoles: ['admin'] } } },
					{ code: 'user', name: '用户门户', order: 2 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(1));
		expect(result.current.portals[0]!.code).toBe('user');
	});

	it('allowed_roles 叠加：snake 原始键兼容（后端透出前的直传形态）', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'status', name: '状态页', order: 1, config: { portal: { allowed_roles: ['admin'] } } },
					{ code: 'user', name: '用户门户', order: 2 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(1));
		expect(result.current.portals[0]!.code).toBe('user');
	});

	// 数据驱动可见性：服务端目录带 config.portal.audience 时**优先于**注册表
	// （ADR §9-1：后端把受众写进目录后，加/调门户不再需要前端发版）。
	it('目录自带 audience=admin → member 看不见（即使注册表里该 code 是 public）', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'user', name: '用户门户', order: 1, config: { portal: { audience: 'admin' } } },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.portals).toEqual([]);
	});

	it('目录自带 audience=public → member 也看得见（覆盖注册表的 admin 判定）', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'config', name: '配置中心', order: 1, config: { portal: { audience: 'public' } } },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(1));
		expect(result.current.portals[0]!.code).toBe('config');
	});

	it('目录自带 audience=platform → 非平台租户成员看不见', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'platform', name: '平台控制台', order: 1, config: { portal: { audience: 'platform' } } },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'super_admin' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.portals).toEqual([]);
	});

	it('目录 audience 是脏值（未知字符串）→ 回落注册表判定', async () => {
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'config', name: '配置中心', order: 1, config: { portal: { audience: 'root' } } },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		// 注册表里 config 属管理面 ⇒ member 不可见
		expect(result.current.portals).toEqual([]);
	});

	it('目录无 config → 完全按注册表（向后兼容旧后端）', async () => {
		getMock.mockResolvedValue({
			data: { items: [{ code: 'config', name: '配置中心', order: 1 }] },
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1', role: 'member' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.portals).toEqual([]);
	});

	it('role 缺省回退 store 当前角色（useCurrentRole），平台租户成员判定不依赖当前租户', async () => {
		useAuthStore.setState({
			tenants: [
				{ id: 't1', name: 'demo', role: 'super_admin' },
				{ id: PLATFORM_TENANT_ID, name: 'platform', role: 'admin' },
			],
			currentTenantId: 't1',
		});
		getMock.mockResolvedValue({
			data: {
				items: [
					{ code: 'admin', name: '管理控制台', order: 1 },
					{ code: 'platform', name: '平台控制台', order: 2 },
				],
			},
		});
		const { result } = renderHook(() => usePortalCatalog({ tenantId: 't1' }), {
			wrapper: makeWrapper(),
		});
		await waitFor(() => expect(result.current.portals).toHaveLength(2));
		// 当前租户 t1 role=super_admin → admin 可见；另一成员租户为平台租户 → platform 可见
		expect(result.current.portals.map((p) => p.code)).toEqual(['admin', 'platform']);
	});
});

describe('isPortalVisible', () => {
	it('secret / config 与 admin/security 同属管理面：member 不可见、管理面角色可见', () => {
		for (const code of ['secret', 'config']) {
			expect(isPortalVisible(code, { role: 'member', isPlatformMember: false })).toBe(false);
			expect(isPortalVisible(code, { role: null, isPlatformMember: false })).toBe(false);
			expect(isPortalVisible(code, { role: 'security_admin', isPlatformMember: false })).toBe(true);
			expect(isPortalVisible(code, { role: 'admin', isPlatformMember: false })).toBe(true);
		}
	});

	it('其余门户不受限（叠加原则）', () => {
		expect(isPortalVisible('brand', { role: null, isPlatformMember: false })).toBe(true);
		expect(isPortalVisible('status', { role: 'member', isPlatformMember: false })).toBe(true);
	});
});
