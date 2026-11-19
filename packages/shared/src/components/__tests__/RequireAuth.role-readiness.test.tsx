// @vitest-environment jsdom
// ============================================================
// 2026-11-19 · RequireAuth「角色未就绪」不得穿透（fail-open 修复回归锁）
//
// 现象：`role === null` 时旧实现直接放行 children ——「没准备好」被当成「允许」。
// 口径（三态分开）：
//   a) 未就绪（租户数据在途 / 租户身份未对齐）⇒ 渲染 loadingFallback，
//      **children 一个都不渲染**，且**不得**渲染 fallback（未就绪 ≠ 无权限）；
//   b) 已就绪 + 无权限（角色不在白名单，或确定无角色）⇒ fallback（既有行为不回归）；
//   c) 已就绪 + 有权限 ⇒ 渲染 children。
//
// 本文件**不 mock 状态机**：跑真实 useAuthMachine + useBootstrap + 真实 auth store，
// 只桩化三个网络/路由依赖（auth-queries / tenant-route / profileAvatar），
// 因此验证的是「守卫对未知角色的真实裁决链」，而不是被桩死的常量。
// ============================================================
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockQueries, mockTenantRoute, mockProfileAvatar } = vi.hoisted(() => ({
	mockQueries: {
		perms: { data: undefined as unknown, isSuccess: false, isError: false },
		tenants: { data: undefined as unknown, isSuccess: false, isError: false },
	},
	mockTenantRoute: {
		slug: 'acme' as string | null,
		tenantId: 't1' as string | null,
		oauthClientId: null as string | null,
		loading: false,
		notFound: false,
		unknownSlug: false,
	},
	mockProfileAvatar: vi.fn(),
}));

vi.mock('../../auth/auth-queries', () => ({
	usePermissionsQuery: () => mockQueries.perms,
	useTenantsQuery: () => mockQueries.tenants,
}));

// U447：启动补读头像走生成客户端（动态 import）；拦截模块，避免打真实网络。
vi.mock('../../generated/api', () => ({ profileAvatar: mockProfileAvatar }));

vi.mock('../../auth/tenant-route-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/tenant-route-middleware')>()),
	useTenantRoute: () => mockTenantRoute,
}));

// 未登录分支不应在本文件触发；仍桩掉，避免误发起真实 OAuth。
vi.mock('../../auth/oauth-login', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/oauth-login')>()),
	initiateOAuthLogin: vi.fn(),
}));

import { RequireAuth } from '../RequireAuth';
import { useAuthStore } from '../../auth/store';

const ADMIN_ONLY = ['super_admin', 'admin'] as const;

const childRenders = vi.fn();
function Protected() {
	// 渲染期计数：children 只要被渲染过一帧就会被记为已调用（比 queryByTestId 更严）
	childRenders();
	return <div data-testid="protected">protected</div>;
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function guard() {
	return (
		<RequireAuth
			allowedRoles={ADMIN_ONLY}
			loadingFallback={<div data-testid="loading">loading</div>}
			fallback={<div data-testid="forbidden">forbidden</div>}
		>
			<Protected />
		</RequireAuth>
	);
}

/** 已登录 + 当前租户 t1，但角色尚未写入（复现「缺 currentTenantId/角色未写入」）。 */
function seedSessionWithoutRole(): void {
	useAuthStore.setState({
		user: { id: 'u-1', username: 'tester', email: 't@example.com', status: 'active' } as never,
		accessToken: 'token-xyz',
		refreshToken: 'refresh-xyz',
		tenants: [],
		currentTenantId: 't1',
		permissions: [],
		isAuthenticated: true,
	});
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

describe('RequireAuth 角色就绪判定（fail-open 修复）', () => {
	beforeEach(() => {
		childRenders.mockReset();
		mockProfileAvatar.mockReset();
		mockProfileAvatar.mockResolvedValue({});
		mockTenantRoute.slug = 'acme';
		mockTenantRoute.tenantId = 't1';
		mockTenantRoute.loading = false;
		mockTenantRoute.notFound = false;
		mockTenantRoute.unknownSlug = false;
		// 权限已到（启动态 ready），租户名单仍在途 ⇒ role 无法解析
		mockQueries.perms = { data: ['user:read'], isSuccess: true, isError: false };
		mockQueries.tenants = { data: undefined, isSuccess: false, isError: false };
		resetAuthStore();
		queryClient.clear();
		document.documentElement.lang = 'zh-CN';
	});

	afterEach(() => {
		cleanup();
		queryClient.clear();
		resetAuthStore();
	});

	// ---------- a) 未就绪 ----------
	it('a) 未就绪（租户名单在途）⇒ 不渲染 children，渲染 loading，且不判拒绝', async () => {
		seedSessionWithoutRole();

		render(guard(), { wrapper });

		expect(await screen.findByTestId('loading')).toBeInTheDocument();
		// 让状态机/启动 effect 全部跑完（TOKEN_FOUND → authenticated → ready）
		await act(async () => {
			await Promise.resolve();
		});

		expect(childRenders).not.toHaveBeenCalled();
		expect(screen.queryByTestId('protected')).toBeNull();
		// 「未就绪」不是「无权限」：不得提前渲染 fallback（站点接 ForbiddenRedirect 会误跳 403）
		expect(screen.queryByTestId('forbidden')).toBeNull();
	});

	it('a2) 未就绪 → 名单到达后自动放行（不是永久 loading）', async () => {
		seedSessionWithoutRole();

		const { rerender } = render(guard(), { wrapper });
		expect(await screen.findByTestId('loading')).toBeInTheDocument();
		expect(childRenders).not.toHaveBeenCalled();

		// 租户名单到达：t1 的角色是 admin（在白名单内）
		mockQueries.tenants = {
			data: [{ id: 't1', name: 'Acme', role: 'admin' }],
			isSuccess: true,
			isError: false,
		};
		rerender(guard());

		await waitFor(() => expect(screen.getByTestId('protected')).toBeInTheDocument());
		expect(screen.queryByTestId('loading')).toBeNull();
	});

	// ---------- b) 就绪但无权限 ----------
	it('b1) 就绪 + 角色不在白名单 ⇒ 渲染 fallback（既有行为不回归）', async () => {
		seedSessionWithoutRole();
		useAuthStore.setState({ tenants: [{ id: 't1', name: 'Acme', role: 'member' }] });
		mockQueries.tenants = {
			data: [{ id: 't1', name: 'Acme', role: 'member' }],
			isSuccess: true,
			isError: false,
		};

		render(guard(), { wrapper });

		expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
		expect(screen.queryByTestId('protected')).toBeNull();
		expect(childRenders).not.toHaveBeenCalled();
	});

	it('b2) 就绪但确定无角色（名单空）⇒ fail-closed 拒绝（不得穿透）', async () => {
		seedSessionWithoutRole();
		mockQueries.tenants = { data: [], isSuccess: true, isError: false };

		render(guard(), { wrapper });

		expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
		expect(childRenders).not.toHaveBeenCalled();
		expect(screen.queryByTestId('protected')).toBeNull();
	});

	it('b3) 就绪无角色但持 "*" ⇒ 放行（单豁免口径不变）', async () => {
		seedSessionWithoutRole();
		useAuthStore.setState({ permissions: ['*'] });
		mockQueries.perms = { data: ['*'], isSuccess: true, isError: false };
		mockQueries.tenants = { data: [], isSuccess: true, isError: false };

		render(guard(), { wrapper });

		await waitFor(() => expect(screen.getByTestId('protected')).toBeInTheDocument());
		expect(screen.queryByTestId('forbidden')).toBeNull();
	});

	// ---------- c) 就绪且有权限 ----------
	it('c) 就绪 + 角色在白名单 ⇒ 渲染 children', async () => {
		seedSessionWithoutRole();
		useAuthStore.setState({ tenants: [{ id: 't1', name: 'Acme', role: 'admin' }] });
		mockQueries.tenants = {
			data: [{ id: 't1', name: 'Acme', role: 'admin' }],
			isSuccess: true,
			isError: false,
		};

		render(guard(), { wrapper });

		await waitFor(() => expect(screen.getByTestId('protected')).toBeInTheDocument());
		expect(screen.queryByTestId('forbidden')).toBeNull();
	});

	// ---------- 跨租户：不得用别的租户角色裁决 ----------
	it('d) 路由租户与当前租户不一致（切换中）⇒ 等待，不用旧租户角色放行/拒绝', async () => {
		seedSessionWithoutRole();
		// store 里是 t1 的 admin，但 URL 指向 t2 —— t1 的角色不得为 t2 授权
		useAuthStore.setState({ tenants: [{ id: 't1', name: 'Acme', role: 'admin' }] });
		mockQueries.tenants = {
			data: [{ id: 't1', name: 'Acme', role: 'admin' }],
			isSuccess: true,
			isError: false,
		};
		mockTenantRoute.tenantId = 't2';

		render(guard(), { wrapper });

		expect(await screen.findByTestId('loading')).toBeInTheDocument();
		expect(childRenders).not.toHaveBeenCalled();
		expect(screen.queryByTestId('forbidden')).toBeNull();
	});
});
