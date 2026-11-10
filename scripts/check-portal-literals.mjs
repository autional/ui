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

/**
 * shared 的注册表可能落在：ui 仓自身源码 / 站点仓根 node_modules（pnpm 提升）/
 * 站点仓 apps/<app>/node_modules（pnpm workspace 的常规位置）/ 将来若出 dist。
 */
function installedCandidates() {
	const out = [];
	const rel = join('@autional', 'shared');
	const variants = [join('src', 'portal', 'registry.ts'), join('dist', 'portal', 'registry.js')];
	const bundlers = [
		join(ROOT, 'node_modules'),
		...(existsSync(join(ROOT, 'apps')) ? readdirSync(join(ROOT, 'apps')).map((d) => join(ROOT, 'apps', d, 'node_modules')) : []),
		...(existsSync(join(ROOT, 'packages')) ? readdirSync(join(ROOT, 'packages')).map((d) => join(ROOT, 'packages', d, 'node_modules')) : []),
	];
	for (const base of bundlers) for (const v of variants) out.push(join(base, rel, v));
	return out;
}

const REGISTRY_CANDIDATES = [
	argValue('--codes'),
	join(ROOT, 'packages', 'shared', 'src', 'portal', 'registry.ts'),
	...installedCandidates(),
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

function findViolations(file, codes, exemptions) {
	const rawSrc = readFileSync(file, 'utf8');
	const src = stripComments(rawSrc); // 扫描用：注释已剥离
	const violations = [];
	const blocks = [
		...src.matchAll(/new Set\(\s*\[[\s\S]{0,4000}?\]\s*\)/g),
		...src.matchAll(/\[[^[\]]{0,4000}\]/g),
	];
	for (const block of blocks) {
		// 取块内所有字符串字面量：**全部**都是门户 code 才算「门户清单」。
		// 只要求「含 ≥2 个 code」会在站点仓大量误报（'status'/'secret'/'user'/'admin' 也是业务名词：
		// 服务名清单、用户菜单项都会命中）。全量匹配才能区分「门户清单」与「恰好撞词的业务枚举」。
		const strings = [...block[0].matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
		const hits = strings.filter((s) => codes.includes(s));
		if (hits.length < 2) continue;
		if (strings.some((s) => !codes.includes(s))) continue;
		const upTo = (block.index ?? 0) + block[0].length;
		const line = src.slice(0, upTo).split(/\r?\n/).length;
		// 显式豁免：块起始行前 4 行内写 `portal-literals-ok: <理由>`。
		// 只给「不是可见性策略、但确实要写死几条门户」的场景（如目录失败时的静态兜底）；
		// 与 eslint-disable 同性质：理由在代码里、评审可见，豁免数在输出里单独报。
		const allLines = rawSrc.split(/\r?\n/); // 豁免标记在注释里 ⇒ 必须查原文
		const startLine = src.slice(0, block.index ?? 0).split(/\r?\n/).length;
		const exempt = allLines
			.slice(Math.max(0, startLine - 4), startLine)
			.some((l) => /portal-literals-ok/.test(l));
		if (exempt) {
			exemptions.push({ line, codes: hits });
			continue;
		}
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
const exemptions = [];
for (const file of files) {
	const violations = findViolations(file, codes, exemptions);
	if (violations.length > 0) results.push({ file: relative(ROOT, file), violations });
}

/**
 * 站点面：ui 仓的 verify 在**舰队机器**上要连带扫 6 个站点仓，
 * 否则「各站自己扫」又会变成 6 份实现（正是本门要消灭的东西）。
 * 站点清单优先取 AUTIONAL_SITES_DIR，回退 <ui>/../sites；不存在就跳过（与其它闸门同约定：
 * 跳过必须在输出里看得见）。
 */
function scanSites() {
	const sitesDir =
		process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
	if (!existsSync(sitesDir)) return null;
	const out = [];
	for (const entry of readdirSync(sitesDir, { withFileTypes: true })) {
		const siteRoot = join(sitesDir, entry.name);
		// 舰队树里各站常是 junction / symlink ⇒ Dirent.isDirectory() 为 false，必须再 stat 一次
		const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(siteRoot).isDirectory());
		if (!isDir) continue;
		if (!existsSync(join(siteRoot, 'apps')) && !existsSync(join(siteRoot, 'src'))) continue;
		const siteCodes = readPortalCodesFor(siteRoot) ?? codes;
		const dirs = ['packages', 'apps', 'src']
			.filter((d) => existsSync(join(siteRoot, d)))
			.map((d) => join(siteRoot, d));
		const siteFiles = dirs.flatMap((d) => walk(d));
		const siteExemptions = [];
		const siteViolations = [];
		for (const file of siteFiles) {
			const v = findViolations(file, siteCodes, siteExemptions);
			if (v.length) siteViolations.push({ file: relative(siteRoot, file), violations: v });
		}
		out.push({
			site: entry.name,
			files: siteFiles.length,
			exemptions: siteExemptions.length,
			results: siteViolations,
		});
	}
	return out;
}

/** 站点自己的 shared 安装（pnpm workspace 常在 apps/<app>/node_modules）。 */
function readPortalCodesFor(siteRoot) {
	const candidates = [
		join(siteRoot, 'node_modules', '@autional', 'shared', 'src', 'portal', 'registry.ts'),
		...(existsSync(join(siteRoot, 'apps'))
			? readdirSync(join(siteRoot, 'apps')).map((d) =>
					join(siteRoot, 'apps', d, 'node_modules', '@autional', 'shared', 'src', 'portal', 'registry.ts'),
				)
			: []),
	];
	const found = candidates.find((p) => existsSync(p));
	if (!found) return null;
	const src = readFileSync(found, 'utf8');
	return [...new Set([...src.matchAll(/code:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]))];
}

const sites = scanSites();
const siteFailures = (sites ?? []).filter((s) => s.results.length > 0);

if (process.argv.includes('--json')) {
	console.log(JSON.stringify({ codes, results, exemptions, sites }, null, 2));
} else {
	if (results.length === 0) {
		console.log(
			`check-portal-literals：PASS（${files.length} 个文件，门户 code 字面量 0 处` +
				`${exemptions.length ? `；显式豁免 ${exemptions.length} 处` : ''}）`,
		);
	} else {
		console.error(`check-portal-literals：FAIL（${results.length} 个文件仍持有门户字面量清单）`);
		if (exemptions.length) console.error(`  （另有显式豁免 ${exemptions.length} 处）`);
		for (const { file, violations } of results) {
			for (const v of violations) {
				console.error(`  ${file}:${v.line}  [${v.codes.join(', ')}]  ${v.text}`);
			}
		}
		console.error('  修法：改用 @autional/shared[/portal] 的派生函数' +
			'（isConsolePortal / getConsolePortalCodes / getSwitcherExcludedCodes / ADMIN_PLANE_ROLES）');
	}

	if (sites === null) {
		console.log('check-portal-literals：站点面跳过（本机无 sites/；舰队机器上会连带扫 6 站）');
	} else {
		for (const s of sites) {
			const suffix = s.exemptions ? `；显式豁免 ${s.exemptions} 处` : '';
			if (s.results.length === 0) {
				console.log(`  [${s.site}] PASS（${s.files} 个文件，0 处${suffix}）`);
				continue;
			}
			console.error(`  [${s.site}] FAIL（${s.results.length} 个文件）${suffix}`);
			for (const { file, violations } of s.results) {
				for (const v of violations) {
					console.error(`    ${file}:${v.line}  [${v.codes.join(', ')}]  ${v.text}`);
				}
			}
		}
		console.log(
			`check-portal-literals：站点面 ${sites.length} 站，${siteFailures.length ? `${siteFailures.length} 站有清单` : '全部 0 处'}`,
		);
	}
}

process.exit(results.length === 0 && siteFailures.length === 0 ? 0 : 1);
