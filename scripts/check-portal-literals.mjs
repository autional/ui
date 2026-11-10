#!/usr/bin/env node
// check-portal-literals —— 门户清单回潮门（第 N 道）
//
// 背景：门户 code 过去被写了十几次（PORTAL_DEFAULTS / SLUG_PORTALS / 重定向白名单 /
// isPortalVisible 角色集 / DEFAULT_EXCLUDE / PORTAL_KEY_MAP + 6 个站点各一份 CONSOLE_PORTALS）。
// 现在唯一真源是 packages/shared/src/portal/registry.ts（`PORTALS`）。
//
// 本闸门扫 packages/*/src（跳过测试与 registry.ts），禁止再出现「≥2 个门户 code」的字面量数组 / Set：
//
//   const CONSOLE_PORTALS = new Set(['config', 'secret', 'admin', ...]);   ❌
//   const DEFAULT_EXCLUDE = ['auth', 'landing'];                          ❌
//
// 允许：
//   • registry.ts 自身（真源）
//   • 单门户字面量（getPortalUrl('admin') / code === 'config' 之类）
//   • 测试文件（oracle 断言需要原文拷贝）
//
// 已知边界（有意接受，别当它是形式化证明）：
//   • 只认「数组 / Set 字面量」；字符串拼接、模板串、`push('admin')`、对象键清单不在扫描面
//   • 只扫本仓 `packages/*/src`（站点仓在各自主仓，由各自的 CI 跑同名脚本）
// 因此它是「回潮早报警」，不是「不可能绕过」；绕过本身要写得刻意，评审时肉眼可见。
//
// 用法（**单文件自足**，可直接复制进站点仓，不依赖 scripts/lib/*）：
//   node scripts/check-portal-literals.mjs                 # 扫本仓（自动识别 packages/ / apps/ / src/）
//   node scripts/check-portal-literals.mjs --root <dir>    # 扫指定目录（站点仓：--root .）
//   node scripts/check-portal-literals.mjs --json
//
// 门户 code 的取法（按序回退）：
//   1. --codes <file> 指定
//   2. <root>/packages/shared/src/portal/registry.ts（ui 仓）
//   3. <root>/node_modules/@autional/shared/src/portal/registry.ts（站点仓，装了 shared 之后）
//   4. <root>/node_modules/@autional/shared/dist/portal/registry.js（将来若出 dist）

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 脚本所在仓根（不 import lib/tokens，保证单文件可复制）。 */
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = resolve(argValue('--root') ?? SCRIPT_ROOT);
/** 待扫目录：显式 --scan（逗号分隔）> 仓库里存在的 packages/apps/src。 */
const SCAN_DIRS = (() => {
	const explicit = argValue('--scan');
	if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean).map((d) => resolve(ROOT, d));
	const candidates = ['packages', 'apps', 'src'].filter((d) => existsSync(join(ROOT, d)));
	return candidates.length > 0 ? candidates.map((d) => join(ROOT, d)) : [ROOT];
})();
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', 'test', 'generated']);
const SKIP_FILE = /(\.test\.|\.spec\.|\.d\.ts$)/;

const REGISTRY_CANDIDATES = [
	argValue('--codes'),
	join(ROOT, 'packages', 'shared', 'src', 'portal', 'registry.ts'),
	join(ROOT, 'node_modules', '@autional', 'shared', 'src', 'portal', 'registry.ts'),
	join(ROOT, 'node_modules', '@autional', 'shared', 'dist', 'portal', 'registry.js'),
].filter(Boolean);

/** 从 registry 提取门户 code（避免本脚本自己维护第二份清单）。 */
function readPortalCodes() {
	const found = REGISTRY_CANDIDATES.find((p) => existsSync(p));
	if (!found) return { codes: [], registry: null };
	const src = readFileSync(found, 'utf8');
	const codes = [...src.matchAll(/code:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]);
	return { codes: [...new Set(codes)], registry: found };
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (SKIP_DIR.has(entry)) continue;
			walk(full, out);
		} else if (/\.(ts|tsx)$/.test(entry) && !SKIP_FILE.test(entry)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * 只在「数组字面量 / Set 字面量」上判定（`['a','b']` / `new Set([...])`）。
 * 单门户字面量（`code === 'admin'`、`getPortalUrl('admin')`、类型联合）不算清单，不报。
 */
/**
 * 去注释（保留字符串原样、保留换行以维持行号）。
 *
 * 不能用正则一把梭：`'https://…'` 里的 `//` 会把整行截断成"已剥离"，
 * `'src/*.ts'` 里的 `/*` 会开一个幽灵块注释吞掉后面的真代码 —— 两者都会造成**漏报**。
 * 所以走一次字符级状态机（code / line-comment / block-comment / string / template）。
 * 已知边界：正则字面量（如 `/\/\//`）按代码处理，若其中含 `//` 仍可能误判（本仓无此写法）。
 */
function stripComments(src) {
	let out = '';
	let state = 'code';
	for (let i = 0; i < src.length; i += 1) {
		const ch = src[i];
		const next = src[i + 1];
		if (state === 'code') {
			if (ch === '/' && next === '/') {
				state = 'line';
				i += 1;
				continue;
			}
			if (ch === '/' && next === '*') {
				state = 'block';
				i += 1;
				continue;
			}
			if (ch === "'" || ch === '"' || ch === '`') {
				state = ch;
				out += ch;
				continue;
			}
			out += ch;
			continue;
		}
		if (state === 'line') {
			if (ch === '\n') {
				state = 'code';
				out += '\n';
			}
			continue;
		}
		if (state === 'block') {
			if (ch === '*' && next === '/') {
				state = 'code';
				i += 1;
				continue;
			}
			if (ch === '\n') out += '\n';
			continue;
		}
		// 字符串 / 模板串内部：原样保留（含转义）
		if (ch === '\\') {
			out += ch + (next ?? '');
			i += 1;
			continue;
		}
		// 单/双引号字符串不跨行：遇到换行仍未闭合 ⇒ 说明前面把 JSX 撇号 / 正则引号当成了字符串起点。
		// 回到 code 态（fail-closed：宁可多剥注释，也不要因状态带偏而漏报或误报）。
		if (ch === '\n' && state !== '`') {
			state = 'code';
			out += ch;
			continue;
		}
		if (ch === state) state = 'code';
		out += ch;
	}
	return out;
}

function findViolations(file, codes) {
	const src = stripComments(readFileSync(file, 'utf8'));
	const violations = [];
	const blocks = [
		...src.matchAll(/new Set\(\s*\[[\s\S]{0,4000}?\]\s*\)/g),
		...src.matchAll(/\[[^[\]]{0,4000}\]/g),
	];
	for (const block of blocks) {
		const hits = codes.filter((code) => new RegExp(`['"]${code}['"]`).test(block[0]));
		if (hits.length < 2) continue;
		const upTo = (block.index ?? 0) + block[0].length;
		const line = src.slice(0, upTo).split(/\r?\n/).length;
		violations.push({
			line,
			codes: hits,
			text: block[0].replace(/\s+/g, ' ').slice(0, 120),
		});
	}
	// Set 字面量会同时命中内层数组 ⇒ 按 (行, code 集) 去重
	const seen = new Set();
	return violations.filter((v) => {
		const key = `${v.line}:${[...v.codes].sort().join(',')}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const { codes, registry } = readPortalCodes();
if (codes.length === 0) {
	console.error(
		'check-portal-literals：取不到门户 code 清单。已找过：\n  ' +
			REGISTRY_CANDIDATES.join('\n  ') +
			'\n（站点仓请先安装 @autional/shared，或用 --codes 指向 registry 文件）',
	);
	process.exit(1);
}

const registryAbs = registry ? resolve(registry) : null;
const files = SCAN_DIRS.flatMap((dir) => walk(dir)).filter((f) => resolve(f) !== registryAbs);
const results = [];
for (const file of files) {
	const violations = findViolations(file, codes);
	if (violations.length > 0) results.push({ file: relative(ROOT, file), violations });
}

if (process.argv.includes('--json')) {
	console.log(JSON.stringify({ codes, results }, null, 2));
} else if (results.length === 0) {
	console.log(`check-portal-literals：PASS（${files.length} 个文件，门户 code 字面量 0 处）`);
} else {
	console.error(`check-portal-literals：FAIL（${results.length} 个文件仍持有门户字面量清单）`);
	for (const { file, violations } of results) {
		for (const v of violations) {
			console.error(`  ${file}:${v.line}  [${v.codes.join(', ')}]  ${v.text}`);
		}
	}
	console.error('  修法：改用 @autional/shared[/portal] 的派生函数' +
		'（isConsolePortal / getConsolePortalCodes / getSwitcherExcludedCodes / ADMIN_PLANE_ROLES）');
}

process.exit(results.length === 0 ? 0 : 1);
