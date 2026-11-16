// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 回归（2026-10-03 线上四门户「未登录」）：oauth 服务的 id_token 只含 sub 等标准
// claim（无 email/username）。修复前 parseUserFromToken(id_token) 的真值结果短路了
// /auth/me 兜底，store 落残缺 user → UserMenu 显示「未登录」。
// 另：登录时固定调一次 OIDC userinfo（/oauth/api/v1/oauth/userinfo）合并展示名
// （nickname→name）+ picture；失败静默降级，不阻断登录。

const { mockPost, mockGet, mockLoginWithTokens, mockUpdateCurrentTenant, mockPersistCid, mockTrace } =
	vi.hoisted(() => ({
		mockPost: vi.fn(),
		mockGet: vi.fn(),
		mockLoginWithTokens: vi.fn(),
		mockUpdateCurrentTenant: vi.fn(),
		mockPersistCid: vi.fn(),
		mockTrace: vi.fn(),
	}));

vi.mock('../../api/client', () => ({ apiClient: { post: mockPost, get: mockGet } }));
vi.mock('../store', () => ({ loginWithTokens: mockLoginWithTokens }));
vi.mock('../service', () => ({ AuthService: { updateCurrentTenant: mockUpdateCurrentTenant } }));
vi.mock('../oauth-client-id-store', () => ({
	persistOAuthClientId: mockPersistCid,
	getPersistedOAuthClientId: () => '',
}));
vi.mock('../auth-trace', () => ({ traceRedirect: mockTrace }));
vi.mock('../../config', () => ({ getPortalUrl: () => 'https://auth.example.com' }));

import { handleOAuthCallback } from '../oauth-login';

function jwt(payload: Record<string, unknown>): string {
	return `h.${btoa(JSON.stringify(payload))}.s`;
}

const ACCESS_TOKEN = jwt({ sub: 'u-1', tenant_id: 'tenant-1' });
const ME_URL = '/identity/api/v1/auth/me';
const USERINFO_URL = '/oauth/api/v1/oauth/userinfo';
const ME_USER = {
	id: 'u-1',
	username: '',
	email: 'demo-admin@demo.localhost',
	status: 'active',
};

function getUserCalls(url: string) {
	return mockGet.mock.calls.filter((c) => String(c[0]) === url);
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	window.history.replaceState({}, '', '/?code=test-code');
	sessionStorage.setItem('oauth_pkce_verifier', 'verifier-1');
	sessionStorage.setItem('oauth_client_id', 'cid-1');
	mockPost.mockResolvedValue({
		data: { access_token: ACCESS_TOKEN, refresh_token: 'rt-1', id_token: jwt({ sub: 'u-1' }) },
	});
	// 默认：/auth/me 返回完整 user；userinfo 返回空（展示名缺省，走回落链）
	mockGet.mockImplementation((url: string) =>
		String(url) === USERINFO_URL
			? Promise.resolve({ data: {} })
			: Promise.resolve({ data: { ...ME_USER } }),
	);
});

describe('handleOAuthCallback 用户信息解析（id_token 缺身份字段回归）', () => {
	it('id_token 只含 sub → 继续调 /auth/me，落完整 user（不再显示未登录）', async () => {
		await handleOAuthCallback();

		const meCalls = getUserCalls(ME_URL);
		expect(meCalls).toHaveLength(1);
		expect(meCalls[0][1]).toMatchObject({
			headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
		});
		expect(mockLoginWithTokens).toHaveBeenCalledTimes(1);
		const user = mockLoginWithTokens.mock.calls[0][2];
		expect(user.email).toBe('demo-admin@demo.localhost');
		expect(user.id).toBe('u-1');
	});

	it('id_token 含 email → 直接采信，不调 /auth/me（既有偏好保持）', async () => {
		mockPost.mockResolvedValue({
			data: {
				access_token: ACCESS_TOKEN,
				refresh_token: 'rt-1',
				id_token: jwt({ sub: 'u-1', email: 'a@b.c' }),
			},
		});

		await handleOAuthCallback();

		expect(getUserCalls(ME_URL)).toHaveLength(0);
		expect(mockLoginWithTokens.mock.calls[0][2].email).toBe('a@b.c');
	});

	it('id_token 缺字段且 /auth/me 失败 → access_token JWT 兜底（id 可用）', async () => {
		mockGet.mockImplementation((url: string) =>
			String(url) === ME_URL
				? Promise.reject(new Error('me down'))
				: Promise.resolve({ data: {} }),
		);

		await handleOAuthCallback();

		expect(mockLoginWithTokens).toHaveBeenCalledTimes(1);
		expect(mockLoginWithTokens.mock.calls[0][2].id).toBe('u-1');
	});

	it('id_token 缺失 → 同样落 /auth/me', async () => {
		mockPost.mockResolvedValue({
			data: { access_token: ACCESS_TOKEN, refresh_token: 'rt-1' },
		});

		await handleOAuthCallback();

		expect(getUserCalls(ME_URL)).toHaveLength(1);
		expect(mockLoginWithTokens.mock.calls[0][2].email).toBe('demo-admin@demo.localhost');
	});
});

describe('handleOAuthCallback userinfo 展示名合并', () => {
	it('每次登录固定调一次 userinfo，带显式 Bearer（拦截器尚无 token）', async () => {
		await handleOAuthCallback();

		const calls = getUserCalls(USERINFO_URL);
		expect(calls).toHaveLength(1);
		expect(calls[0][1]).toMatchObject({
			headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
		});
	});

	it('id_token 含 email（短路 /auth/me）时 userinfo 仍调用——id_token 永不含展示名', async () => {
		mockPost.mockResolvedValue({
			data: {
				access_token: ACCESS_TOKEN,
				refresh_token: 'rt-1',
				id_token: jwt({ sub: 'u-1', email: 'a@b.c' }),
			},
		});
		mockGet.mockImplementation(() => Promise.resolve({ data: { name: 'Demo Admin' } }));

		await handleOAuthCallback();

		expect(mockLoginWithTokens.mock.calls[0][2].displayName).toBe('Demo Admin');
	});

	it('nickname 合入 displayName（优先于 name，含 trim）', async () => {
		mockGet.mockImplementation((url: string) =>
			String(url) === USERINFO_URL
				? Promise.resolve({ data: { nickname: '  Demo Admin  ', name: 'Demo A. Admin' } })
				: Promise.resolve({ data: { ...ME_USER } }),
		);

		await handleOAuthCallback();

		expect(mockLoginWithTokens.mock.calls[0][2].displayName).toBe('Demo Admin');
	});

	it('无 nickname 时回落 name；picture 合入 avatarUrl', async () => {
		mockGet.mockImplementation((url: string) =>
			String(url) === USERINFO_URL
				? Promise.resolve({ data: { name: 'Demo Admin', picture: 'https://x/p.png' } })
				: Promise.resolve({ data: { ...ME_USER } }),
		);

		await handleOAuthCallback();

		const user = mockLoginWithTokens.mock.calls[0][2];
		expect(user.displayName).toBe('Demo Admin');
		expect(user.avatarUrl).toBe('https://x/p.png');
	});

	it('userinfo 失败 → 登录继续，displayName 缺省（消费侧回落 username/email）', async () => {
		mockGet.mockImplementation((url: string) =>
			String(url) === USERINFO_URL
				? Promise.reject(new Error('userinfo down'))
				: Promise.resolve({ data: { ...ME_USER } }),
		);

		await handleOAuthCallback();

		expect(mockLoginWithTokens).toHaveBeenCalledTimes(1);
		const user = mockLoginWithTokens.mock.calls[0][2];
		expect(user.displayName).toBeUndefined();
		expect(user.email).toBe('demo-admin@demo.localhost');
	});
});
