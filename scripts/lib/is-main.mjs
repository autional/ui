import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 「本文件是否被直接执行」判定（junction 安全）。
 *
 * 为什么不能直接写 `import.meta.url === pathToFileURL(argv[1]).href`：
 * 本仓常经 `.refs/ui` junction 访问（→ D:/ws/deploy-sync/ui）。Node 会把
 * `import.meta.url` 解析成**真实路径**，而 `process.argv[1]` 仍是 junction 路径，
 * 两边不等 → 守卫判为「被 import」→ `main()` 静默不执行且进程 exit 0。
 * 2026-11-14 实测：两次发布「成功退出但什么都没发」，正是这个原因。
 *
 * 兜底：realpath 失败（路径不存在等）时退回原始比较，行为与旧写法一致。
 */
export function isMain(moduleUrl, argv1 = process.argv[1]) {
	if (!argv1) return false;
	try {
		return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
	} catch {
		return moduleUrl === pathToFileURL(argv1).href;
	}
}
