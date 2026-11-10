import { describe, expect, it } from 'vitest';
import {
	ADMIN_PLANE_ROLES,
	PORTALS,
	PORTAL_CODES,
	getConsolePortalCodes,
	getLegacyEnvKey,
	getRouterPortalCodes,
	getSwitcherExcludedCodes,
	getSwitcherIncludedCodes,
	isConsolePortal,
	isPortalVisibleForAudience,
	isSlugScopedPortal,
} from '../registry';

/**
 * Oracle 等价测试：注册表派生值必须与「迁移前的字面量」逐项相等。
 * 只要有一项不等，就是行为变化（首页 URL / 路由 basename / 切换器清单 / 可见性）。
 * 下面每个常量都是迁移前源码里的原文拷贝，**不要**跟着实现改。
 */

/** 迁移前 `config/index.ts` 的 `PORTAL_DEFAULTS`（顺序 + host/base） */
const ORACLE_PORTAL_DEFAULTS: Record<string, { host: string; base: string }> = {
	auth: { host: 'auth', base: '' },
	admin: { host: 'admin', base: '' },
	developer: { host: 'developer', base: '' },
	user: { host: 'user', base: '' },
	security: { host: 'security', base: '' },
	status: { host: 'status', base: '' },
	landing: { host: '', base: '' },
	authenticator: { host: 'authenticator', base: '' },
	trust: { host: 'trust', base: '' },
	platform: { host: 'platform', base: '' },
	brand: { host: 'brand', base: '' },
	secret: { host: 'secret', base: '' },
	config: { host: 'config', base: '' },
};

/** 迁移前 `SLUG_PORTALS` */
const ORACLE_SLUG_PORTALS = ['auth', 'admin', 'user', 'security', 'authenticator', 'platform'];

/** 迁移前 `getAppPortalSlugs()` */
const ORACLE_APP_PORTAL_SLUGS = ['admin', 'developer', 'security', 'platform', 'status', 'trust'];

/** 迁移前 `usePortalCatalog` 的 `DEFAULT_EXCLUDE` */
const ORACLE_DEFAULT_EXCLUDE = ['auth', 'landing', 'authenticator'];

/** 迁移前 `isValidRedirect` 的门户白名单顺序 */
const ORACLE_REDIRECT_ORDER = [
	'auth',
	'admin',
	'developer',
	'user',
	'security',
	'status',
	'landing',
	'authenticator',
	'trust',
	'platform',
	'brand',
	'secret',
	'config',
];

/** 6 个站点各自的 `CONSOLE_PORTALS` 字面量（值完全一致） */
const ORACLE_CONSOLE_PORTALS = ['admin', 'config', 'secret', 'security', 'user', 'platform'];

/** 迁移前 `PORTAL_KEY_MAP` */
const ORACLE_LEGACY_ENV: Record<string, string> = {
	auth: 'VITE_AUTH_PAGES_URL',
	admin: 'VITE_ADMIN_CONSOLE_URL',
	developer: 'VITE_DEVELOPER_PORTAL_URL',
	user: 'VITE_END_USER_PORTAL_URL',
	security: 'VITE_SECURITY_DASHBOARD_URL',
	status: 'VITE_STATUS_PAGE_URL',
	landing: 'VITE_LANDING_SITE_URL',
	authenticator: 'VITE_AUTHENTICATOR_APP_URL',
	trust: 'VITE_TRUST_CENTER_URL',
	platform: 'VITE_PLATFORM_CONSOLE_URL',
};

/** 迁移前 `isPortalVisible` 的实现（作为 oracle） */
function oracleIsPortalVisible(
	code: string,
	ctx: { role: string | null; isPlatformMember: boolean },
): boolean {
	if (code === 'platform') return ctx.isPlatformMember;
	if (code === 'admin' || code === 'security' || code === 'secret' || code === 'config') {
		return ctx.role !== null && ['super_admin', 'admin', 'security_admin', 'user_manager'].includes(ctx.role);
	}
	return true;
}

describe('portal registry —— 与迁移前字面量等价', () => {
	it('host/base 与 PORTAL_DEFAULTS 逐项一致（前 13 项）', () => {
		for (const [code, expectEntry] of Object.entries(ORACLE_PORTAL_DEFAULTS)) {
			const def = PORTALS.find((p) => p.code === code);
			expect(def, `缺门户 ${code}`).toBeTruthy();
			expect({ host: def?.host, base: def?.base }).toEqual(expectEntry);
		}
	});

	it('portal code 顺序保持（前 13 项 = redirect 白名单原顺序）', () => {
		expect(PORTAL_CODES.slice(0, ORACLE_REDIRECT_ORDER.length)).toEqual(ORACLE_REDIRECT_ORDER);
	});

	it('新增 4 个内容站（此前漏登记）', () => {
		expect(PORTAL_CODES).toEqual(expect.arrayContaining(['docs', 'wiki', 'reference', 'consent']));
	});

	it('SLUG_PORTALS 等价（租户段门户集合）', () => {
		const derived = PORTALS.filter((p) => isSlugScopedPortal(p.code)).map((p) => p.code);
		expect(derived.sort()).toEqual([...ORACLE_SLUG_PORTALS].sort());
	});

	it('getAppPortalSlugs 等价（且保持原顺序）', () => {
		expect(getRouterPortalCodes()).toEqual(ORACLE_APP_PORTAL_SLUGS);
	});

	it('DEFAULT_EXCLUDE 等价（顺序也一致）', () => {
		expect(getSwitcherExcludedCodes()).toEqual(ORACLE_DEFAULT_EXCLUDE);
	});

	it('切换器清单 = 全部门户减 3 个排除项（逐项列出，别只做同义反复）', () => {
		expect(getSwitcherIncludedCodes().slice().sort()).toEqual(
			[
				'admin',
				'brand',
				'config',
				'consent',
				'developer',
				'docs',
				'platform',
				'reference',
				'secret',
				'security',
				'status',
				'trust',
				'user',
				'wiki',
			].sort(),
		);
		expect(getSwitcherIncludedCodes()).not.toContain('authenticator');
		expect(getSwitcherIncludedCodes()).not.toContain('auth');
		expect(getSwitcherIncludedCodes()).not.toContain('landing');
	});

	it('redirect 白名单顺序 = 注册表表序（前 13 = 迁移前原顺序）', () => {
		expect(PORTAL_CODES.slice(0, 13)).toEqual(ORACLE_REDIRECT_ORDER);
		expect(PORTAL_CODES).toEqual([...ORACLE_REDIRECT_ORDER, 'docs', 'wiki', 'reference', 'consent']);
	});

	it('控制台族 code 集合与 6 站 CONSOLE_PORTALS 字面量等价', () => {
		expect(getConsolePortalCodes().slice().sort()).toEqual([...ORACLE_CONSOLE_PORTALS].sort());
		expect(isConsolePortal('config')).toBe(true);
		expect(isConsolePortal('docs')).toBe(false);
	});

	it('旧 env 键映射等价', () => {
		for (const [code, key] of Object.entries(ORACLE_LEGACY_ENV)) {
			expect(getLegacyEnvKey(code)).toBe(key);
		}
		expect(getLegacyEnvKey('brand')).toBeUndefined();
	});

	it('可见性矩阵与迁移前实现逐格一致', () => {
		const roles = [null, 'member', 'guest', 'super_admin', 'admin', 'security_admin', 'user_manager', 'auditor'];
		const codes = [...ORACLE_REDIRECT_ORDER, 'docs', 'wiki', 'reference', 'consent', 'unknown-portal'];
		for (const code of codes) {
			for (const role of roles) {
				for (const isPlatformMember of [true, false]) {
					expect(
						isPortalVisibleForAudience(code, { role, isPlatformMember }),
						`code=${code} role=${String(role)} platform=${isPlatformMember}`,
					).toBe(oracleIsPortalVisible(code, { role, isPlatformMember }));
				}
			}
		}
	});

	it('管理面角色集与迁移前一致（4 个）', () => {
		expect([...ADMIN_PLANE_ROLES].sort()).toEqual(
			['admin', 'security_admin', 'super_admin', 'user_manager'].sort(),
		);
	});
});
