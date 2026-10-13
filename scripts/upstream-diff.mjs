#!/usr/bin/env node
// upstream-diff — 上游旧 web 仓 与舰队 packages/* 的差异报告
// 用法: AUTIONAL_UPSTREAM=<路径> node scripts/upstream-diff.mjs
//       （缺省找 D:\go\auth_ms_new\web；找不到就跳过并退出 0）
//
// 为什么需要它：packages/shared 这一类包**不是 npm 依赖**，而是「从上游拷一份」进每个站点。
// 上游旧 web 仓 仍在活跃开发（2026-09 仍在提交 entry-plane / generated API 重生成）。
// 实测当前状态：上游 68 个文件，39 个与舰队逐字节相同、29 个不同。也就是说上游的修复
// **不会自己流到舰队**，而舰队的修复也不会回流。这个脚本把「差在哪」变成一条命令。
//
// 为什么**不进 verify**：它依赖工作区外部的一个 git 仓库。闸门必须只看 ui/ 与 sites/，
// 否则 CI 里会因为「没有上游」而红——那是把环境问题伪装成代码问题。
//
// 这份报告刻意**只报告、不合并**：舰队在若干处已经**领先**上游（slug 修复、branding 合并、
// OAuthCallbackPage 收敛），盲目「同步上游」会把这些修复回退掉。谁领先、该怎么合，
// 必须人看。工具负责把差异摆出来，不负责替人决定。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/tokens.mjs';

const UPSTREAM = process.env.AUTIONAL_UPSTREAM || 'D:\\go\\auth_ms_new\\web';
const SITES = resolve(ROOT, '..', 'sites');
const PACKAGES = ['shared', 'ui', 'tailwind-preset', 'react'];
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.git']);

if (!existsSync(UPSTREAM)) {
	console.log('上游差异报告：找不到上游仓库 ' + UPSTREAM + '，跳过（设 AUTIONAL_UPSTREAM 指定路径）');
	process.exit(0);
}
if (!existsSync(SITES)) {
	console.log('上游差异报告：本次工作区没有 sites/，跳过');
	process.exit(0);
}

function walk(dir, out = []) {
	let entries;
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		if (SKIP.has(e.name)) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|css)$/.test(e.name)) out.push(p);
	}
	return out;
}
// 比对前把行尾归一化成 LF。
//
// 为什么必须归一化（实测踩过）：本机 core.autocrlf=true，工作区里同一份文件会因为
// 「最后写它的是哪个工具」而 LF / CRLF 混杂。第一版脚本直接比字节，于是把 brand 的
// 14 个 shared 文件 + 3 个 ui 文件报成「1/9 站点分叉」——查下去发现 git 索引里全是 LF
// （git ls-files --eol 显示 i/lf），.gitattributes 也三个仓库一致，纯粹是工作区噪声。
// 是**测量口径**错了，不是代码有问题。跨仓库比对不能假设行尾策略一致。
const sha = (p) => createHash('sha256').update(readFileSync(p, 'utf8').split('\r\n').join('\n')).digest('hex').slice(0, 12);

// 命名空间归一化。为什么需要（第 43 轮实测）：舰队是上游旧 web 仓 的**换牌分叉**，
// 绝大多数文件只差 AuthMS→Autional / @authms→@autional。第一版报告把这类文件
// 也算成「上游与舰队之间真正的差」，于是 39 个里混进了 14 个**等价**文件，
// 真正需要人评估的 29 个被淹没。判据先把噪声去掉，人再看剩下的。
const canon = (p) => readFileSync(p, 'utf8').split('\r\n').join('\n')
  .replace(/@authms\//g, '@autional/')
  .replace(/\bAuthMS\b/g, 'Autional')
  .replace(/\bauthms\b/g, 'autional');

const sites = readdirSync(SITES).filter((s) => statSync(join(SITES, s)).isDirectory());
let totalFiles = 0;
let totalSame = 0;
const rows = [];

for (const pkg of PACKAGES) {
	const upDir = join(UPSTREAM, 'packages', pkg);
	if (!existsSync(upDir)) continue;
	const files = walk(upDir);
	console.log('');
	console.log('── packages/' + pkg + ' （上游 ' + files.length + ' 个文件）');
	totalFiles += files.length;
	// 三种状态要分开报，混在一起会给出误导性的数字：
	//   identical     全部持有站点的副本都与上游逐字节相同
	//   upstreamGap   全部持有站点都与上游不同 —— 这才是「上游有、舰队没有（或反之）」
	//   split         只有部分站点不同 —— 那是**舰队内部**不一致，与上游无关，另一类问题
	// 只按「有多少文件不同」报总数，会让这两类问题看起来是同一件事。
	const identical = [];
	const upstreamGap = [];
	const namespaceOnly = [];
	const split = [];
	let absent = 0;
	for (const f of files) {
		const rel = f.slice(upDir.length + 1).replace(/\\/g, '/');
		const upHash = sha(f);
		const diffSites = [];
		let present = 0;
		for (const s of sites) {
			const g = join(SITES, s, 'packages', pkg, rel);
			if (!existsSync(g)) continue;
			present++;
			if (sha(g) !== upHash) diffSites.push(s);
		}
		if (!present) absent++;
		else if (diffSites.length === 0) { identical.push(rel); totalSame++; }
		else if (diffSites.length === present) {
			// 全部持有站点都与上游不同 —— 再看归一化之后是否其实等价（只是换牌）
			const g = join(SITES, diffSites[0], 'packages', pkg, rel);
			if (canon(f) === canon(g)) namespaceOnly.push(rel);
			else upstreamGap.push(rel);
		}
		else split.push({ rel, diffSites, present });
	}
	if (absent === files.length && files.length) {
		console.log('   舰队里没有任何站点持有这个包 —— 若它已改为从 npm 消费（P4 之后 tailwind-preset 就是如此），这属正常。');
	}
	console.log('   与上游逐字节相同：' + identical.length +
		' / 仅命名空间差异（AuthMS→Autional，等价）：' + namespaceOnly.length +
		' / 归一化后仍有真差异：' + upstreamGap.length +
		' / 仅部分站点不同（舰队内部分叉）：' + split.length + ' / 无人持有：' + absent);
	if (namespaceOnly.length) {
		console.log('   · 仅命名空间差异的文件（等价，不需要评估）：' + namespaceOnly.length + ' 个');
	}
	if (upstreamGap.length) {
		console.log('   ↑ 归一化后**仍有真差异**的文件（需要人工评估）：');
		for (const rel of upstreamGap.slice(0, 30)) console.log('     ' + rel);
		if (upstreamGap.length > 30) console.log('     …另有 ' + (upstreamGap.length - 30) + ' 个');
	}
	if (split.length) {
		console.log('   ↑ 舰队内部分叉的文件（与上游无关，是站点之间不一致）：');
		for (const d of split.slice(0, 15)) console.log('     ' + d.rel.padEnd(52) + '与上游不同的站点 ' + d.diffSites.length + '/' + d.present);
		if (split.length > 15) console.log('     …另有 ' + (split.length - 15) + ' 个');
	}
	rows.push({ pkg, identical: identical.length, namespaceOnly: namespaceOnly.length, upstreamGap: upstreamGap.length, split: split.length, total: files.length });
}

console.log('');
// shell 保持 false：git 的参数不含需要 shell 展开的东西，而 shell:true 在 Node 24 会报
// DEP0190（参数未转义），把一条正常的报告变成一屏警告。
const log = spawnSync('git', ['log', '--oneline', '-8', '--', 'packages/shared', 'packages/ui', 'packages/tailwind-preset'], { cwd: UPSTREAM, encoding: 'utf8' });
if (log.status === 0 && log.stdout.trim()) {
	console.log('── 上游最近触碰这些包的提交（判断「有什么新东西进来了」）');
	for (const l of log.stdout.trim().split(/\r?\n/)) console.log('   ' + l);
} else {
	console.log('── 读不到上游 git 历史（非 git 工作区？）');
}

console.log('');
console.log('合计：上游 ' + totalFiles + ' 个文件，逐字节相同 ' + totalSame + ' 个。');
console.log('这份报告只摆差异，不合并：舰队在若干处已领先上游，直接「同步上游」会回退这些修复。');
