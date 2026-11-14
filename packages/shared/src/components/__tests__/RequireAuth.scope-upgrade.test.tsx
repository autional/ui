// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

// ============================================================
// 2026-11-14 事故回归锁：用户门户「短信验证 → 验证并开启」
// 403 `token scope does not allow this operation`。
//
// 修复前：登录只申请基础档（read）⇒ MFA 等写接口全 403。
// 修复后：① 登录发起即申请门户档；② 已登录但令牌缺门户写 scope 时，挂载后
// 一次性静默重新授权（auth 侧有会话 + 既有同意 → 自动放行，用户只看到回跳）。
// 本文件钉住 ② 的触发面：OAuth 旧令牌触发；已升级/会话/模拟令牌不触发；每次
// 页面会话只尝试一次（失败不循环）。
// ============================================================

const { mockState } = vi.hoisted(() => ({
	mockState: {
		machineStatus: 'ready' as string,
		tenantRoute: {
			slug: 'platform' as string | null,
			tenantId: 't1' as string | null,
			oauthClientId: '01AR0000000000000000000004' as string | null,
			loading: false,
			notFound: false,
			unknownSlug: false,
		},
		token: null as string | null,
		initiate: vi.fn(),
	},
}));

vi.mock('../../auth/auth-machine', () => ({
	useAuthMachine: () => ({ status: mockState.machineStatus }),
}));

vi.mock('../../auth/tenant-route-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/tenant-route-middleware')>()),
	useTenantRoute: () => mockState.tenantRoute,
}));

// 部分 mock：保留真实 scope 常量与判定函数（升级 effect 的判据来源）。
vi.mock('../../auth/oauth-login', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/oauth-login')>()),
	initiateOAuthLogin: (...args: any[]) => mockState.initiate(...args),
}));

vi.mock('../../auth/service', () => ({
	AuthService: {
		getAccessToken: () => mockState.token,
		getCurrentRole: () => null,
		getPermissions: () => [],
	},
	setBootstrapLock: vi.fn(),
}));

import { RequireAuth } from '../RequireAuth';
import { OAUTH_LOGIN_SCOPES, PORTAL_LOGIN_SCOPES } from '../../auth/oauth-login';

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** OAuth 访问令牌（scope/client_id 在 custom 内，与 service-oauth 签发形态一致）。 */
function oauthToken(scope: string, custom: Record<string, unknown> = {}): string {
	const header = b64url({ alg: 'RS256', typ: 'JWT' });
	const payload = b64url({
		sub: 'user-1',
		tenant_id: 't1',
		type: 'access',
		custom: { scope, client_id: '01AR0000000000000000000004', ...custom },
	});
	return `${header}.${payload}.sig`;
}

function renderGuard() {
	return render(
		<RequireAuth>
			<div data-testid="protected">protected</div>
		</RequireAuth>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	window.sessionStorage.clear();
	mockState.machineStatus = 'ready';
	mockState.token = null;
	delete (window as any).__APP_CONFIG__;
});

afterEach(() => cleanup());

describe('RequireAuth 一次性 scope 升级', () => {
	it('OAuth 旧令牌（仅基础档）→ 静默发起门户档重新授权，子路由照常渲染', () => {
		mockState.token = oauthToken(OAUTH_LOGIN_SCOPES);

		renderGuard();

		expect(screen.getByTestId('protected')).toBeInTheDocument();
		expect(mockState.initiate).toHaveBeenCalledTimes(1);
		expect(mockState.initiate).toHaveBeenCalledWith(
			'01AR0000000000000000000004',
			undefined,
			{ scope: PORTAL_LOGIN_SCOPES, force: true, silent: true },
		);
	});

	it('每次页面会话只尝试一次（失败不循环）', () => {
		mockState.token = oauthToken(OAUTH_LOGIN_SCOPES);

		renderGuard();
		expect(mockState.initiate).toHaveBeenCalledTimes(1);
		cleanup();

		// 同 tab 二次挂载：升级标记已在 ⇒ 不再发起
		mockState.initiate.mockClear();
		renderGuard();
		expect(mockState.initiate).not.toHaveBeenCalled();
	});

	it('令牌已是门户档 → 不升级', () => {
		mockState.token = oauthToken(PORTAL_LOGIN_SCOPES);

		renderGuard();

		expect(mockState.initiate).not.toHaveBeenCalled();
	});

	it('会话直签令牌（无 OAuth client_id）→ 不升级', () => {
		const header = b64url({ alg: 'RS256', typ: 'JWT' });
		const payload = b64url({ sub: 'user-1', type: 'access', custom: { scope: 'read *' } });
		mockState.token = `${header}.${payload}.sig`;

		renderGuard();

		expect(mockState.initiate).not.toHaveBeenCalled();
	});

	it('模拟会话（is_imp）→ 不升级（不得换成本人令牌）', () => {
		mockState.token = oauthToken(OAUTH_LOGIN_SCOPES, { is_imp: true });

		renderGuard();

		expect(mockState.initiate).not.toHaveBeenCalled();
	});

	it('未登录态不触发升级（交由原有登录漏斗：force=false、非 silent）', () => {
		mockState.machineStatus = 'unauthenticated';
		mockState.token = oauthToken(OAUTH_LOGIN_SCOPES);

		renderGuard();

		const upgradeCalls = mockState.initiate.mock.calls.filter((c) => c[2]?.silent === true);
		expect(upgradeCalls).toHaveLength(0);
	});
});
