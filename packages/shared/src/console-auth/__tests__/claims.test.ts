import { describe, expect, it } from 'vitest';
import {
	expiresAtFromToken,
	mergeTokenClaims,
	pickClaimRoles,
	pickClaimString,
	sessionExpiryAt,
	userFromClaims,
} from '@autional/shared/console-auth';

/**
 * 这层是从配置中心/密钥中心的 `lib/auth.ts` 里**逐字**抽出来的：
 * 两站曾各写一份，任何一边改了回落顺序，顶栏显示就不一致。
 * 测试按「两站原本的行为」锁定，改这里等于改两站。
 */

/** 造一个 payload 可解的最小 JWT（不验签，只取声明）。 */
function jwt(payload: Record<string, unknown>): string {
	const b64 = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('pickClaimString', () => {
	it('取第一个非空字符串，并去首尾空白', () => {
		expect(pickClaimString({ a: '  x  ', b: 'y' }, 'a', 'b')).toBe('x');
	});

	it('跳过空串/空白/非字符串', () => {
		expect(pickClaimString({ a: '', b: '   ', c: 42, d: 'ok' }, 'a', 'b', 'c', 'd')).toBe('ok');
	});

	it('全都不命中返回空串', () => {
		expect(pickClaimString({}, 'zzz')).toBe('');
		expect(pickClaimString(null, 'zzz')).toBe('');
	});
});

describe('pickClaimRoles', () => {
	it('数组形式只保留字符串项', () => {
		expect(pickClaimRoles({ roles: ['admin', 1, 'ops'] })).toEqual(['admin', 'ops']);
	});

	it('字符串形式按逗号/空白拆分', () => {
		expect(pickClaimRoles({ role: 'admin, ops  viewer' })).toEqual(['admin', 'ops', 'viewer']);
	});

	it('认 authorities（不同签发方口径）', () => {
		expect(pickClaimRoles({ authorities: ['ROLE_A'] })).toEqual(['ROLE_A']);
	});

	it('无角色声明返回空数组', () => {
		expect(pickClaimRoles({})).toEqual([]);
		expect(pickClaimRoles(null)).toEqual([]);
	});
});

describe('userFromClaims', () => {
	it('声明齐全时逐字段映射', () => {
		const user = userFromClaims(
			{
				sub: 'u-1',
				name: '张三',
				email: 'z@example.com',
				tenant_id: 't-9',
				app_id: 'app-3',
				roles: ['admin'],
			},
			'兜底',
		);
		expect(user).toEqual({
			sub: 'u-1',
			name: '张三',
			email: 'z@example.com',
			tenantId: 't-9',
			appId: 'app-3',
			roles: ['admin'],
		});
	});

	it('展示名回落顺序：name → preferred_username → nickname → email', () => {
		expect(userFromClaims({ sub: 'u', preferred_username: 'pu' }, '兜底').name).toBe('pu');
		expect(userFromClaims({ sub: 'u', nickname: 'nick' }, '兜底').name).toBe('nick');
		expect(userFromClaims({ sub: 'u', email: 'e@x' }, '兜底').name).toBe('e@x');
	});

	it('无展示名时用 sub 尾 6 位（不能用兜底文案，否则顶栏出现「已 已登录用户」）', () => {
		expect(userFromClaims({ sub: 'abcdefghij' }, '已登录用户').name).toBe('…efghij');
	});

	it('连 sub 都没有才用调用方兜底', () => {
		expect(userFromClaims({}, '已登录用户').name).toBe('已登录用户');
	});

	it('租户/应用兼容驼峰与下划线', () => {
		const user = userFromClaims({ sub: 'u', tenantId: 't1', appId: 'a1' }, 'x');
		expect(user.tenantId).toBe('t1');
		expect(user.appId).toBe('a1');
	});
});

describe('expiresAtFromToken', () => {
	it('优先用 JWT exp（秒 → 毫秒）', () => {
		const exp = 1_900_000_000;
		expect(expiresAtFromToken(jwt({ exp }), 60)).toBe(exp * 1000);
	});

	it('无 exp 时用 expires_in', () => {
		const before = Date.now();
		const at = expiresAtFromToken(jwt({ sub: 'u' }), 120);
		expect(at).toBeGreaterThanOrEqual(before + 120_000 - 50);
		expect(at).toBeLessThanOrEqual(Date.now() + 120_000 + 50);
	});

	it('两者都缺时用调用方兜底（各站不同：配置中心 5 分钟 / 密钥中心 30 分钟）', () => {
		const before = Date.now();
		const at = expiresAtFromToken('', undefined, 30 * 60_000);
		expect(at).toBeGreaterThanOrEqual(before + 30 * 60_000 - 50);
	});

	it('坏的 token 不抛错，走兜底', () => {
		expect(() => expiresAtFromToken('not-a-jwt', 10)).not.toThrow();
	});
});

describe('sessionExpiryAt', () => {
	it('令牌带 exp 时以 exp 为准（覆盖旧存储的估算值）', () => {
		const exp = 1_900_000_000;
		expect(sessionExpiryAt(jwt({ exp }), 1)).toBe(exp * 1000);
	});

	it('令牌无 exp 时回落记录值', () => {
		expect(sessionExpiryAt(jwt({ sub: 'u' }), 12345)).toBe(12345);
	});
});

describe('mergeTokenClaims', () => {
	it('id_token 优先，access_token 补缺（tenant_id 只在 access 里也拿得到）', () => {
		const access = jwt({ sub: 'u1', tenant_id: 't-1', roles: ['admin'] });
		const id = jwt({ sub: 'u1', name: '张三', nonce: 'n-1' });
		expect(mergeTokenClaims(access, id)).toMatchObject({
			name: '张三',
			tenant_id: 't-1',
			nonce: 'n-1',
			roles: ['admin'],
		});
	});

	it('同名字段以 id_token 为准', () => {
		const access = jwt({ sub: 'u1', name: '来自 access' });
		const id = jwt({ sub: 'u1', name: '来自 id' });
		expect(mergeTokenClaims(access, id)?.name).toBe('来自 id');
	});

	it('只有一份令牌时用它', () => {
		const access = jwt({ sub: 'u1', tenant_id: 't-1' });
		expect(mergeTokenClaims(access, undefined)?.tenant_id).toBe('t-1');
		expect(mergeTokenClaims(undefined, access)?.tenant_id).toBe('t-1');
	});

	it('两份都缺 → null', () => {
		expect(mergeTokenClaims(undefined, undefined)).toBeNull();
	});

	it('坏令牌不抛错', () => {
		expect(() => mergeTokenClaims('bad', 'also-bad')).not.toThrow();
	});
});
