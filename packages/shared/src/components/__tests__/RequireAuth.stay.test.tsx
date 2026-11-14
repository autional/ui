// @vitest-environment jsdom
// ============================================================
// AUTH-03：未认证 + 用户点「停留」不得留空白死路——
//  ① 无 OAuth client（buildLoginUrl 链）：停留 → 恢复态（需要登录/前往登录）；点击再发起
//  ② 有 OAuth client（PKCE 链）：停留 → 恢复态；点击以 force 跳过 10s 防重入再发起
// ============================================================
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';

const { mockState, mockInitiate, mockTrace } = vi.hoisted(() => ({
	mockState: {
		machineStatus: 'ready' as string,
		tenantRoute: {
			slug: null as string | null,
			tenantId: null as string | null,
			oauthClientId: null as string | null,
			loading: false,
			notFound: false,
			unknownSlug: false,
		},
	},
	mockInitiate: vi.fn(),
	mockTrace: vi.fn(),
}));

vi.mock('../../auth/auth-machine', () => ({
	useAuthMachine: () => ({ status: mockState.machineStatus }),
}));

vi.mock('../../auth/tenant-route-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/tenant-route-middleware')>()),
	useTenantRoute: () => mockState.tenantRoute,
}));

// 部分 mock：保留真实 scope 常量/判定（RequireAuth 的 scope 升级 effect 依赖它们）。
vi.mock('../../auth/oauth-login', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/oauth-login')>()),
	initiateOAuthLogin: (...args: any[]) => mockInitiate(...args),
}));

vi.mock('../../auth/auth-trace', () => ({
	traceRedirect: (...args: any[]) => mockTrace(...args),
}));

vi.mock('../../auth/service', () => ({
	AuthService: {
		getAccessToken: () => null,
		getCurrentRole: () => 'admin',
		getPermissions: () => [],
	},
	setBootstrapLock: vi.fn(),
}));

import { RequireAuth } from '../RequireAuth';

function renderGuard() {
	return render(
		<RequireAuth>
			<div data-testid="protected">protected</div>
		</RequireAuth>,
	);
}

beforeEach(() => {
	mockState.machineStatus = 'ready';
	mockState.tenantRoute = {
		slug: null,
		tenantId: null,
		oauthClientId: null,
		loading: false,
		notFound: false,
		unknownSlug: false,
	};
	delete (window as any).__APP_CONFIG__;
	document.documentElement.lang = 'zh-CN';
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('RequireAuth「停留」恢复态（AUTH-03）', () => {
	it('无 OAuth client：停留 → 恢复态渲染，「前往登录」再发起（interstitial 重弹）', async () => {
		mockState.machineStatus = 'unauthenticated';
		renderGuard();

		// effect → setTimeout(0) → traceRedirect(interstitial)；未停留时仍是空白
		await waitFor(() => expect(mockTrace).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId('protected')).toBeNull();
		expect(screen.queryByText('需要登录')).toBeNull();

		const opts = mockTrace.mock.calls[0][1];
		expect(opts.kind).toBe('interstitial');
		expect(typeof opts.onStay).toBe('function');

		// 用户点「停留」→ onStay → 恢复态（不再空白）
		act(() => opts.onStay());
		expect(await screen.findByText('需要登录')).toBeInTheDocument();

		act(() => fireEvent.click(screen.getByRole('button', { name: '前往登录' })));
		await waitFor(() => expect(mockTrace).toHaveBeenCalledTimes(2));
	});

	it('有 OAuth client：停留 → 恢复态；「前往登录」以 force 跳过防重入重发起', async () => {
		(window as any).__APP_CONFIG__ = { VITE_OAUTH_CLIENT_ID: 'portal-cid' };
		mockState.machineStatus = 'unauthenticated';
		renderGuard();

		await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(1));
		const [cidArg, , opts] = mockInitiate.mock.calls[0];
		expect(cidArg).toBe('portal-cid');
		expect(opts.force).toBe(false);
		expect(typeof opts.onStay).toBe('function');

		act(() => opts.onStay());
		expect(await screen.findByText('需要登录')).toBeInTheDocument();

		act(() => fireEvent.click(screen.getByRole('button', { name: '前往登录' })));
		await waitFor(() => expect(mockInitiate).toHaveBeenCalledTimes(2));
		expect(mockInitiate.mock.calls[1][2]).toMatchObject({ force: true });
	});

	it('未停留时保持原语义：unauthenticated 渲染 null（无恢复态）', async () => {
		mockState.machineStatus = 'unauthenticated';
		renderGuard();

		await waitFor(() => expect(mockTrace).toHaveBeenCalledTimes(1));
		expect(screen.queryByText('需要登录')).toBeNull();
		expect(screen.queryByTestId('protected')).toBeNull();
	});
});
