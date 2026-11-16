// @vitest-environment jsdom
// AUTH-46② 回归锁：handleOAuthCallback 失败路径以 OAuthCallbackError 携带稳定 code
// （oauth.provider_error / oauth.missing_code / oauth.state_mismatch / oauth.pkce_cleared），
// 供回调页按 code 映射本地化文案——此前英文裸句（"Missing authorization code" 等）直接落用户屏。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../api/client', () => ({ apiClient: { post: mockPost, get: vi.fn() } }));
vi.mock('../store', () => ({ loginWithTokens: vi.fn() }));
vi.mock('../service', () => ({ AuthService: { updateCurrentTenant: vi.fn() } }));
vi.mock('../oauth-client-id-store', () => ({
	persistOAuthClientId: vi.fn(),
	getPersistedOAuthClientId: () => '',
}));
vi.mock('../auth-trace', () => ({ traceRedirect: vi.fn() }));
vi.mock('../../config', () => ({ getPortalUrl: () => 'https://auth.example.com' }));

import { handleOAuthCallback, OAuthCallbackError } from '../oauth-login';

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		throw new Error('expected rejection');
	} catch (e) {
		expect(e).toBeInstanceOf(OAuthCallbackError);
		return (e as OAuthCallbackError).code;
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
});

describe('handleOAuthCallback 错误 code（AUTH-46②）', () => {
	it('provider error 参数 → oauth.provider_error（description 作 message 保留）', async () => {
		window.history.replaceState({}, '', '/?error=access_denied&error_description=user+denied');
		const code = await codeOf(handleOAuthCallback());
		expect(code).toBe('oauth.provider_error');
	});

	it('无 code → oauth.missing_code', async () => {
		window.history.replaceState({}, '', '/?state=%7B%22csrf%22%3A%22a%22%7D');
		const code = await codeOf(handleOAuthCallback());
		expect(code).toBe('oauth.missing_code');
	});

	it('state csrf 不匹配 → oauth.state_mismatch', async () => {
		sessionStorage.setItem('oauth_state', 'csrf-A');
		sessionStorage.setItem('oauth_pkce_verifier', 'v-1');
		window.history.replaceState(
			{},
			'',
			'/?code=c1&state=' + encodeURIComponent(JSON.stringify({ csrf: 'csrf-B' })),
		);
		const code = await codeOf(handleOAuthCallback());
		expect(code).toBe('oauth.state_mismatch');
	});

	it('state 通过但 PKCE verifier 缺失（刷新清存储）→ oauth.pkce_cleared', async () => {
		sessionStorage.setItem('oauth_state', 'csrf-A');
		window.history.replaceState(
			{},
			'',
			'/?code=c1&state=' + encodeURIComponent(JSON.stringify({ csrf: 'csrf-A' })),
		);
		const code = await codeOf(handleOAuthCallback());
		expect(code).toBe('oauth.pkce_cleared');
	});
});
