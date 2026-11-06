import { describe, it, expect } from 'vitest';
import { OAUTH_LOGIN_SCOPES } from '../oauth-login';

/**
 * 回归锁：登录申请的 scope 必须覆盖平台读接口强制的要求。
 *
 * 2026-11-06 事故：服务端给 18 个服务加了 RequireScopes("read")，而客户端仍申请
 * openid profile email offline_access ⇒ 登录成功但读接口 403（ops 控制台现场）。
 */
describe('OAUTH_LOGIN_SCOPES', () => {
	const scopes = OAUTH_LOGIN_SCOPES.split(' ').filter(Boolean);

	it('包含平台读接口强制的 read', () => {
		expect(scopes).toContain('read');
	});

	it('保留 OIDC / 刷新令牌必需项', () => {
		for (const s of ['openid', 'profile', 'email', 'offline_access']) {
			expect(scopes).toContain(s);
		}
	});

	it('无空项、无重复', () => {
		expect(OAUTH_LOGIN_SCOPES.trim()).toBe(OAUTH_LOGIN_SCOPES);
		expect(new Set(scopes).size).toBe(scopes.length);
	});
});
