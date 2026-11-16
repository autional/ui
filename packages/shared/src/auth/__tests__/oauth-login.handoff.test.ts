// @vitest-environment jsdom
// ============================================================
// F-008 回归锁：OAuth 交棒（state + PKCE verifier）跨浏览上下文兜底
//
// 症状：交棒只写 sessionStorage → 回调页落在**另一个浏览上下文**（PWA standalone 被系统
// 浏览器接管 / 新标签 / 安卓 Custom Tab）时 sessionStorage 为空 ⇒ `oauth.state_mismatch`，
// 回调页不换码。修法：同时写 localStorage 兜底（≤5min TTL、origin 绑定、读后双删）。
// 本文件锁死：兜底能救回登录，但**不放松** CSRF 比对（不匹配照样抛 state_mismatch）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
	mockPost,
	mockGet,
	mockLoginWithTokens,
	mockUpdateCurrentTenant,
	mockPersistCid,
	mockTrace,
	mockGeneratePKCE,
} = vi.hoisted(() => ({
	mockPost: vi.fn(),
	mockGet: vi.fn(),
	mockLoginWithTokens: vi.fn(),
	mockUpdateCurrentTenant: vi.fn(),
	mockPersistCid: vi.fn(),
	mockTrace: vi.fn(),
	mockGeneratePKCE: vi.fn(() => Promise.resolve({ verifier: 'verifier-1', challenge: 'challenge-1' })),
}));

vi.mock('../../api/client', () => ({ apiClient: { post: mockPost, get: mockGet } }));
vi.mock('../store', () => ({ loginWithTokens: mockLoginWithTokens }));
vi.mock('../service', () => ({ AuthService: { updateCurrentTenant: mockUpdateCurrentTenant } }));
vi.mock('../oauth-client-id-store', () => ({
	persistOAuthClientId: mockPersistCid,
	// 发起时已落 localStorage（跨上下文时 sessionStorage 里没有 client_id）
	getPersistedOAuthClientId: () => 'cid-1',
}));
vi.mock('../auth-trace', () => ({ traceRedirect: mockTrace }));
vi.mock('../pkce', () => ({ generatePKCE: () => mockGeneratePKCE() }));
vi.mock('../../config', () => ({ getPortalUrl: () => 'https://auth.example.com' }));

import { initiateOAuthLogin, handleOAuthCallback, OAuthCallbackError } from '../oauth-login';

const HANDOFF_KEY = 'oauth_handoff';
const ORIGIN = window.location.origin;
const TTL_MS = 5 * 60 * 1000;

function jwt(payload: Record<string, unknown>): string {
	return `h.${btoa(JSON.stringify(payload))}.s`;
}

type StoredRecord = {
	v?: number;
	state?: string;
	verifier?: string;
	origin?: string;
	exp?: number;
};

function readRecord(): StoredRecord | null {
	const raw = localStorage.getItem(HANDOFF_KEY);
	return raw ? (JSON.parse(raw) as StoredRecord) : null;
}

function writeRecord(rec: StoredRecord): void {
	localStorage.setItem(HANDOFF_KEY, JSON.stringify(rec));
}

function useCallbackUrl(params: { code?: string; state?: unknown }): void {
	const q = new URLSearchParams();
	if (params.code) q.set('code', params.code);
	if (params.state !== undefined) q.set('state', JSON.stringify(params.state));
	window.history.replaceState({}, '', `/?${q.toString()}`);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		throw new Error('expected rejection');
	} catch (e) {
		expect(e).toBeInstanceOf(OAuthCallbackError);
		return (e as OAuthCallbackError).code;
	}
}

function tokenBody(): URLSearchParams {
	expect(mockPost).toHaveBeenCalledTimes(1);
	return new URLSearchParams(String(mockPost.mock.calls[0][1]));
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	localStorage.clear();
	window.history.replaceState({}, '', '/');
	mockPost.mockResolvedValue({
		data: { access_token: jwt({ sub: 'u-1', email: 'u@example.com' }), refresh_token: 'rt-1' },
	});
	mockGet.mockResolvedValue({ data: {} });
});

describe('F-008 交棒写入（sessionStorage 快路径 + localStorage 兜底）', () => {
	it('发起时同时写两处：sessionStorage 保留 string，localStorage 记录带 exp(≤5min)+origin，无 token', async () => {
		await initiateOAuthLogin('cid-1', 'https://user.example.com/x');

		const csrf = sessionStorage.getItem('oauth_state');
		expect(csrf).toBeTruthy();
		expect(sessionStorage.getItem('oauth_pkce_verifier')).toBe('verifier-1');

		const rec = readRecord();
		expect(rec?.v).toBe(1);
		expect(rec?.state).toBe(csrf);
		expect(rec?.verifier).toBe('verifier-1');
		expect(rec?.origin).toBe(ORIGIN);
		// TTL ≤ 5 分钟（留 1s 余量吸收执行耗时）
		expect(Number(rec?.exp) - Date.now()).toBeLessThanOrEqual(TTL_MS);
		expect(Number(rec?.exp) - Date.now()).toBeGreaterThan(TTL_MS - 5000);
		// 值里不得含任何令牌字段
		expect(Object.keys(rec ?? {}).sort()).toEqual(['exp', 'origin', 'state', 'v', 'verifier']);
		expect(JSON.stringify(rec)).not.toMatch(/token|access_token|refresh_token/i);
	});
});

describe('F-008 交棒读取（回调页）', () => {
	it('同上下文：仅 sessionStorage 有值 → 兑换成功（既有行为不变）', async () => {
		sessionStorage.setItem('oauth_state', 'csrf-A');
		sessionStorage.setItem('oauth_pkce_verifier', 'verifier-1');
		sessionStorage.setItem('oauth_client_id', 'cid-1');
		useCallbackUrl({ code: 'c1', state: { csrf: 'csrf-A', redirect: '/dash' } });

		await handleOAuthCallback();

		const body = tokenBody();
		expect(body.get('code_verifier')).toBe('verifier-1');
		expect(body.get('client_id')).toBe('cid-1');
		expect(mockLoginWithTokens).toHaveBeenCalledTimes(1);
		expect(mockTrace.mock.calls.at(-1)?.[0]).toBe('/dash');
	});

	it('跨浏览上下文：sessionStorage 为空、localStorage 兜底未过期 → 兑换成功', async () => {
		// 先在本上下文发起（两处都写），再清掉 sessionStorage 模拟「另一个浏览上下文」
		await initiateOAuthLogin('cid-1', 'https://user.example.com/x');
		const csrf = String(readRecord()?.state);
		sessionStorage.clear();

		useCallbackUrl({ code: 'c1', state: { csrf } });
		await handleOAuthCallback();

		const body = tokenBody();
		expect(body.get('code_verifier')).toBe('verifier-1');
		// client_id 跨上下文来自 localStorage 持久值（发起时 persistOAuthClientId）
		expect(body.get('client_id')).toBe('cid-1');
		expect(mockLoginWithTokens).toHaveBeenCalledTimes(1);
	});

	it('兜底命中后两处都被清除（防重放）', async () => {
		writeRecord({ v: 1, state: 'csrf-A', verifier: 'verifier-1', origin: ORIGIN, exp: Date.now() + TTL_MS });
		useCallbackUrl({ code: 'c1', state: { csrf: 'csrf-A' } });

		await handleOAuthCallback();

		expect(sessionStorage.getItem('oauth_state')).toBeNull();
		expect(sessionStorage.getItem('oauth_pkce_verifier')).toBeNull();
		expect(localStorage.getItem(HANDOFF_KEY)).toBeNull();

		// 二次兑换（同一 state 再来一次）→ 已无交棒可用，按不匹配拒绝
		mockPost.mockClear();
		useCallbackUrl({ code: 'c2', state: { csrf: 'csrf-A' } });
		expect(await codeOf(handleOAuthCallback())).toBe('oauth.state_mismatch');
		expect(mockPost).not.toHaveBeenCalled();
	});

	it('localStorage 记录已过期 → oauth.state_mismatch（不放行）', async () => {
		writeRecord({
			v: 1,
			state: 'csrf-A',
			verifier: 'verifier-1',
			origin: ORIGIN,
			exp: Date.now() - 1000,
		});
		useCallbackUrl({ code: 'c1', state: { csrf: 'csrf-A' } });

		expect(await codeOf(handleOAuthCallback())).toBe('oauth.state_mismatch');
		expect(mockPost).not.toHaveBeenCalled();
	});

	it('origin 不匹配 → 不认（oauth.state_mismatch），且不动别人的记录', async () => {
		writeRecord({
			v: 1,
			state: 'csrf-A',
			verifier: 'verifier-1',
			origin: 'https://other.example.com',
			exp: Date.now() + TTL_MS,
		});
		useCallbackUrl({ code: 'c1', state: { csrf: 'csrf-A' } });

		expect(await codeOf(handleOAuthCallback())).toBe('oauth.state_mismatch');
		expect(mockPost).not.toHaveBeenCalled();
		expect(readRecord()?.origin).toBe('https://other.example.com');
	});

	it('兜底记录有效但回调 state 不匹配 → 仍抛 oauth.state_mismatch（CSRF 未放松）', async () => {
		writeRecord({ v: 1, state: 'csrf-A', verifier: 'verifier-1', origin: ORIGIN, exp: Date.now() + TTL_MS });
		useCallbackUrl({ code: 'c1', state: { csrf: 'csrf-B' } });

		expect(await codeOf(handleOAuthCallback())).toBe('oauth.state_mismatch');
		expect(mockPost).not.toHaveBeenCalled();
	});
});
