// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================
// P1-2 集成回归锁：真实 useAuthMachine + useBootstrap 链路
//  两个 bootstrap 查询都失败 → 机器曾永停 bootstrap → RequireAuth 渲染 null → 白屏。
//  本用例不 mock 状态机，只 mock「查询返回错误」，验证端到端落到错误页。
// ============================================================

vi.mock('../../auth/auth-queries', () => ({
	usePermissionsQuery: () => ({ data: undefined, isError: true, isError2: true }),
	useTenantsQuery: () => ({ data: undefined, isError: true }),
}));

vi.mock('../../generated/api', () => ({ profileAvatar: vi.fn().mockResolvedValue({}) }));

// 部分 mock：保留真实 scope 常量/判定（RequireAuth 的 scope 升级 effect 依赖它们）。
vi.mock('../../auth/oauth-login', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/oauth-login')>()),
	initiateOAuthLogin: vi.fn(),
}));

vi.mock('../../auth/tenant-route-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/tenant-route-middleware')>()),
	useTenantRoute: () => ({
		slug: 'acme-corp',
		tenantId: 't1',
		oauthClientId: null,
		loading: false,
		notFound: false,
		unknownSlug: false,
	}),
}));

import { RequireAuth } from '../RequireAuth';
import { useAuthStore } from '../../auth/store';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: React.ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('RequireAuth × useAuthMachine（bootstrap 失败链路）', () => {
	beforeEach(() => {
		document.documentElement.lang = 'zh-CN';
		window.localStorage.clear();
		useAuthStore.setState({
			user: { id: 'u-1', username: 'demo', email: 'demo@example.com', status: 'active' },
			accessToken: 'token-xyz',
			refreshToken: 'refresh-xyz',
			tenants: [],
			currentTenantId: 't1',
			permissions: [],
			isAuthenticated: true,
		});
	});

	afterEach(() => {
		cleanup();
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
	});

	it('权限/租户查询都失败 → 渲染「加载失败」而非空白，且不放行子路由', async () => {
		render(
			<RequireAuth>
				<div data-testid="protected">受保护内容</div>
			</RequireAuth>,
			{ wrapper },
		);

		expect(await screen.findByText('加载失败')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
		expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
	});
});
