import { describe, expect, it } from 'vitest';
import { FetchApiError, createFetchClient } from '@autional/shared/fetch';

/**
 * 子路径导出 `@autional/shared/fetch` 的意义：**不把整包 index 拉进站点**。
 *
 * 实测教训（2026-11-11，密钥中心迁移）：`import { createFetchClient } from '@autional/shared'`
 * 会连带初始化 130 个模块（axios/react-query/zustand/生成类型…），在 vitest 的
 * `vi.resetModules()` + 动态 import 场景下每个用例多花 5–20s，直接把 5s 超时的用例打红。
 * 只引这个子路径后，模块图只有本文件（零依赖）。
 */
describe('@autional/shared/fetch 子路径导出', () => {
	it('可从包名子路径导入 createFetchClient / FetchApiError', () => {
		expect(typeof createFetchClient).toBe('function');
		expect(typeof FetchApiError).toBe('function');
	});

	it('模块本身不引入运行时依赖（源码级断言）', async () => {
		const fs = await import('node:fs/promises');
		const url = new URL('../fetch-client.ts', import.meta.url);
		const src = await fs.readFile(url, 'utf8');
		const imports = src
			.split(/\r?\n/)
			.filter((line) => /^\s*import\s/.test(line) || /^\s*\} from\s+['"]/.test(line));
		expect(imports).toEqual([]);
	});
});
