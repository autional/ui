import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPortalUrl } from '../../config';
import { PORTALS, isSlugScopedPortal } from '../registry';

/**
 * 注册表 → `getPortalUrl()` 的接线测试：
 * 注册表里 `host` / `slugScoped` 改了却没生效（或写错字段），这里会红。
 */
describe('registry → getPortalUrl 接线', () => {
	beforeEach(() => {
		vi.stubGlobal('window', {
			location: {
				hostname: 'config.autional.cn',
				protocol: 'https:',
				origin: 'https://config.autional.cn',
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		['docs', 'https://docs.autional.cn'],
		['wiki', 'https://wiki.autional.cn'],
		['reference', 'https://reference.autional.cn'],
		['consent', 'https://consent.autional.cn'],
	])('此前漏登记的内容站 %s 现在能拼出子域 URL', (code, expected) => {
		expect(getPortalUrl(code)).toBe(expected);
	});

	it('landing 落根域（host 为空）', () => {
		expect(getPortalUrl('landing')).toBe('https://autional.cn');
	});

	it('租户段门户才吃 slug，其余忽略（防拼出 404 路由）', () => {
		for (const portal of PORTALS) {
			const url = getPortalUrl(portal.code, 'acme');
			if (isSlugScopedPortal(portal.code)) {
				expect(url.endsWith('/acme'), `${portal.code} 应拼租户段`).toBe(true);
			} else {
				expect(url.endsWith('/acme'), `${portal.code} 不应拼租户段`).toBe(false);
			}
		}
	});
});
