// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// OAuth 登录「可追加 scope」（2026-11-14）
//  - 缺省行为不变：不传 opts.scope ⇒ 申请 OAUTH_LOGIN_SCOPES
//  - withOAuthScopes('write') ⇒ URL 的 scope 含 write、无重复
//  - 空数组 / 空串 ⇒ 不改变基础 scope
// ============================================================

const { mockTrace, mockPersistCid } = vi.hoisted(() => ({
	mockTrace: vi.fn(),
	mockPersistCid: vi.fn(),
}));

vi.mock('../../api/client', () => ({ apiClient: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../store', () => ({ loginWithTokens: vi.fn() }));
vi.mock('../service', () => ({ AuthService: { updateCurrentTenant: vi.fn() } }));
vi.mock('../oauth-client-id-store', () => ({ persistOAuthClientId: mockPersistCid }));
vi.mock('../auth-trace', () => ({ traceRedirect: mockTrace }));
vi.mock('../pkce', () => ({
	generatePKCE: () => Promise.resolve({ verifier: 'v-1', challenge: 'c-1' }),
}));
vi.mock('../../config', () => ({ getPortalUrl: () => 'https://auth.example.com' }));

import { initiateOAuthLogin, OAUTH_LOGIN_SCOPES, withOAuthScopes } from '../oauth-login';

function scopeFromLastTrace(): string {
	expect(mockTrace).toHaveBeenCalledTimes(1);
	const url = new URL(mockTrace.mock.calls[0][0] as string);
	return url.searchParams.get('scope') || '';
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('withOAuthScopes', () => {
	it('不传额外项 ⇒ 与基础 scope 完全一致', () => {
		expect(withOAuthScopes()).toBe(OAUTH_LOGIN_SCOPES);
	});

	it('空数组 / 空串 / 纯空白 ⇒ 不改变基础 scope', () => {
		expect(withOAuthScopes('')).toBe(OAUTH_LOGIN_SCOPES);
		expect(withOAuthScopes('   ')).toBe(OAUTH_LOGIN_SCOPES);
		expect(withOAuthScopes(...[])).toBe(OAUTH_LOGIN_SCOPES);
	});

	it("追加 write ⇒ 基础项在前、write 在后", () => {
		expect(withOAuthScopes('write')).toBe(`${OAUTH_LOGIN_SCOPES} write`);
	});

	it('重复项去重（含基础里已有的项与多次传入）', () => {
		const once = withOAuthScopes('write', 'write', 'read', 'mfa:write');
		const scopes = once.split(' ').filter(Boolean);
		expect(new Set(scopes).size).toBe(scopes.length);
		expect(scopes.filter((s) => s === 'read')).toHaveLength(1);
		expect(scopes.filter((s) => s === 'write')).toHaveLength(1);
		expect(scopes).toContain('mfa:write');
	});

	it('多项一次传入按传入次序追加', () => {
		const scopes = withOAuthScopes('write', 'mfa:write').split(' ');
		expect(scopes.indexOf('write')).toBeLessThan(scopes.indexOf('mfa:write'));
	});
});

describe('initiateOAuthLogin 的 scope 传参', () => {
	it('不传 opts.scope ⇒ URL 里仍是最初的基础 scope（零波及）', async () => {
		await initiateOAuthLogin('cid-1');
		expect(scopeFromLastTrace()).toBe(OAUTH_LOGIN_SCOPES);
	});

	it('opts.scope = withOAuthScopes("write") ⇒ URL scope 含 write 且无重复', async () => {
		await initiateOAuthLogin('cid-1', undefined, { scope: withOAuthScopes('write') });
		const scopes = scopeFromLastTrace().split(' ').filter(Boolean);
		expect(scopes).toContain('write');
		expect(new Set(scopes).size).toBe(scopes.length);
	});

	it('opts.scope = 空串 ⇒ 回落到基础 scope', async () => {
		await initiateOAuthLogin('cid-1', undefined, { scope: '' });
		expect(scopeFromLastTrace()).toBe(OAUTH_LOGIN_SCOPES);
	});

	it('防重入自动重试也带住追加的 scope（否则重试会丢掉 write）', async () => {
		vi.useFakeTimers();
		sessionStorage.setItem('oauth_init_ts', String(Date.now()));

		await initiateOAuthLogin('cid-1', undefined, { scope: withOAuthScopes('write') });
		expect(mockTrace).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10200);
		const scopes = scopeFromLastTrace().split(' ');
		expect(scopes).toContain('write');
	});
});
