import { describe, expect, it } from 'vitest';
import {
	ADMIN_PLANE_ROLES,
	PORTALS,
	getConsolePortalCodes,
	getSwitcherExcludedCodes,
	isConsolePortal,
} from '@autional/shared/portal';

/**
 * 子路径导出 `@autional/shared/portal` 必须**自足**：
 * 注册表模块不 import 任何东西（无 axios / react-query / zustand / react），
 * 零运行时依赖的控制台（配置中心 / 密钥中心）才能只引这一小块。
 *
 * 这里用"包名自引用"走 package.json exports，验证发布后的解析路径真实可用。
 */
describe('@autional/shared/portal 子路径导出', () => {
	it('可从包名子路径导入（发布后两站这样引用）', () => {
		expect(Array.isArray(PORTALS)).toBe(true);
		expect(PORTALS.length).toBeGreaterThan(10);
	});

	it('提供控制台族与可见性所需的派生函数', () => {
		expect(getConsolePortalCodes().slice().sort()).toEqual(
			['admin', 'config', 'platform', 'secret', 'security', 'user'].sort(),
		);
		expect(isConsolePortal('config')).toBe(true);
		expect(isConsolePortal('docs')).toBe(false);
	});

	// 交接件（site-migration.md）两站要用这两个符号；改名而测试不红 ⇒ 两站上线才炸
	it('导出两站迁移所需的常量（ADMIN_PLANE_ROLES / getSwitcherExcludedCodes）', () => {
		expect([...ADMIN_PLANE_ROLES].sort()).toEqual(
			['admin', 'security_admin', 'super_admin', 'user_manager'].sort(),
		);
		expect(getSwitcherExcludedCodes()).toEqual(['auth', 'landing', 'authenticator']);
	});

	it('模块本身不引入任何运行时依赖（源码级断言）', async () => {
		const fs = await import('node:fs/promises');
		const url = new URL('../registry.ts', import.meta.url);
		const src = await fs.readFile(url, 'utf8');
		const importLines = src
			.split(/\r?\n/)
			.filter((line) => /^\s*import\s/.test(line) || /\bfrom\s+['"]/.test(line));
		expect(importLines).toEqual([]);
	});
});
