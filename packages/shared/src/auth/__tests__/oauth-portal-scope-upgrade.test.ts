import { describe, it, expect } from 'vitest';
import {
	OAUTH_LOGIN_SCOPES,
	PORTAL_LOGIN_SCOPES,
	scopesCover,
	tokenNeedsPortalScopeUpgrade,
} from '../oauth-login';

/**
 * 回归锁（2026-11-14）：用户门户「短信验证 → 验证并开启」403
 * `token scope does not allow this operation`。
 *
 * 根因：门户登录只申请基础档（read），而 MFA 写接口强制 `mfa:write`；服务端
 * `oauth_clients.scopes` 早已为全部首方门户 client 登记完整 scope，缺的只是「申请」。
 * 本文件钉住：① 门户档覆盖全部 enforced 写 scope；② 旧令牌（仅基础档）判定为需升级；
 * ③ 会话/模拟令牌不得被升级流程误伤。
 */

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 构造只含载荷的测试 JWT（签名段不验签，解码侧只读载荷）。 */
function makeJwt(payload: Record<string, unknown>): string {
	return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

/** OAuth 访问令牌载荷形态（service-oauth createJWTAccessToken：scope/client_id 在 custom 内）。 */
function oauthToken(scope: string, extra: Record<string, unknown> = {}): string {
	return makeJwt({
		sub: 'user-1',
		tenant_id: 'tenant-1',
		type: 'access',
		custom: { scope, client_id: '01AR0000000000000000000004', ...extra },
	});
}

describe('PORTAL_LOGIN_SCOPES（门户档）', () => {
	const base = OAUTH_LOGIN_SCOPES.split(' ').filter(Boolean);
	const portal = PORTAL_LOGIN_SCOPES.split(' ').filter(Boolean);

	it('保留基础档全部项（OIDC + read）', () => {
		for (const s of base) expect(portal).toContain(s);
	});

	it('覆盖服务端 enforced 的全部写 scope', () => {
		for (const s of ['write', 'mfa:write', 'oauth:write', 'billing:write', 'wallet:write', 'point:write', 'pay:write']) {
			expect(portal).toContain(s);
		}
	});

	it('无空项、无重复', () => {
		expect(PORTAL_LOGIN_SCOPES.trim()).toBe(PORTAL_LOGIN_SCOPES);
		expect(new Set(portal).size).toBe(portal.length);
		expect(portal.every(Boolean)).toBe(true);
	});
});

describe('scopesCover', () => {
	it('覆盖全部要求 → true；缺任一项 → false', () => {
		expect(scopesCover('read write', 'read')).toBe(true);
		expect(scopesCover('read write', 'read write')).toBe(true);
		expect(scopesCover('read', 'read write')).toBe(false);
	});

	it('`*` 通配覆盖一切（首方/session 令牌语义）', () => {
		expect(scopesCover('read *', 'mfa:write')).toBe(true);
	});

	it('空/缺省 granted 一律不覆盖', () => {
		expect(scopesCover('', 'read')).toBe(false);
		expect(scopesCover(null, 'read')).toBe(false);
		expect(scopesCover(undefined, 'read')).toBe(false);
	});
});

describe('tokenNeedsPortalScopeUpgrade', () => {
	it('无令牌 / 非 JWT → 不需要升级', () => {
		expect(tokenNeedsPortalScopeUpgrade(null)).toBe(false);
		expect(tokenNeedsPortalScopeUpgrade(undefined)).toBe(false);
		expect(tokenNeedsPortalScopeUpgrade('token-xyz')).toBe(false);
	});

	it('会话/SAML 直签令牌（无 OAuth client_id）→ 不参与升级', () => {
		const sessionToken = makeJwt({ sub: 'u', type: 'access', custom: { scope: 'read *' } });
		expect(tokenNeedsPortalScopeUpgrade(sessionToken)).toBe(false);
		// 无 custom 段的令牌同理
		expect(tokenNeedsPortalScopeUpgrade(makeJwt({ sub: 'u', type: 'access' }))).toBe(false);
	});

	it('OAuth 令牌仅基础档 → 需要升级（2026-11-14 事故形态）', () => {
		expect(tokenNeedsPortalScopeUpgrade(oauthToken(OAUTH_LOGIN_SCOPES))).toBe(true);
		// 空 scope 的 OAuth 令牌同样需要（写接口必 403）
		expect(tokenNeedsPortalScopeUpgrade(oauthToken(''))).toBe(true);
	});

	it('OAuth 令牌已是门户档 → 不需要升级（升级后条件自然转假，不循环）', () => {
		expect(tokenNeedsPortalScopeUpgrade(oauthToken(PORTAL_LOGIN_SCOPES))).toBe(false);
	});

	it('OAuth 令牌带 `*` 通配 → 不升级', () => {
		expect(tokenNeedsPortalScopeUpgrade(oauthToken('read *'))).toBe(false);
	});

	it('模拟会话（is_imp）→ 绝不升级（不得换成本人令牌）', () => {
		expect(tokenNeedsPortalScopeUpgrade(oauthToken(OAUTH_LOGIN_SCOPES, { is_imp: true }))).toBe(false);
	});
});
