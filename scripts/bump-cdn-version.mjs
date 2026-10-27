#!/usr/bin/env node
// bump-cdn-version — 把 14 个站点的 CDN 版本指针切到当前版本目录。
// 用法:
//   node scripts/bump-cdn-version.mjs           # 只报告会改什么（默认，不写盘）
//   node scripts/bump-cdn-version.mjs --write   # 实际写入
//
// 为什么需要它：CDN 版本目录名带内容指纹（见 build-cdn.mjs），所以 tokens 一改、
// 目录名就变，而运行期资产的引用方是 14 个站点。手工改 14 个仓是这类改动最容易漏一部分的地方
// —— 而漏掉的那一站会静默地留在旧版本上（旧目录已被 build-cdn 清掉，它的 URL 会 404）。
// check-icons 的 I19（14 站版本必须相同）与 I24（必须是 latest.json 当前那版）是守门人，
// 本脚本是配套的施工工具。
//
// 版本指针有**两条通道，缺一不可**：
//   ① 字面 URL：https://cdn.autional.cn/ui/v<版本>/…
//   ② CDN_PIN 常量：scripts/env.mjs（9 个 SPA）/ src/lib/site-env.ts（5 个 Astro 站）。
//      B3 单源化之后，站点源码里**不再写死 CDN URL**（<head> 用 {{CDN_ASSET_BASE}} 占位符，
//      Astro 用 cdnAsset() 助手），版本只存在于这一个常量里。只改 ① 的脚本会对 14 个站
//      「报告无事可做」，而浏览器拿的是旧版本 —— 2026-10-27 那波就是手改的，正是本脚本的缺口。
//
// 编码：全程按 latin1 读写（**字节透明**）。docs / developer 的 site-env.ts 是 GBK 编码，
// 按 utf8 读再写会把中文注释变成 U+FFFD（不可逆）。替换内容全是 ASCII，latin1 往返逐字节无损。
//
// 站点名单以 consumer-targets.json 的 publicDirs 为准 —— 与 check-icons 同一份声明，
// 不再 readdirSync 工作区（那里还有 ui/ cdn/ 等非站点目录）。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ROOT } from './lib/tokens.mjs';
import { PIN_FILES, PIN_RE } from './lib/cdn-refs.mjs';

const WRITE = process.argv.includes('--write');
const SITES = process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
const CDN = process.env.AUTIONAL_CDN_DIR || resolve(ROOT, '..', 'cdn');

const latestPath = join(CDN, 'ui', 'latest.json');
if (!existsSync(latestPath)) {
  console.error('找不到 ' + latestPath + ' —— 先跑 node scripts/build-cdn.mjs');
  process.exit(1);
}
const WANT = JSON.parse(readFileSync(latestPath, 'utf8')).version;
if (!/^.+\.([0-9a-f]{8})$/.test(WANT)) {
  console.error('latest.json 的版本 ' + WANT + ' 里没有内容指纹 —— 先跑 build-cdn.mjs 重建');
  process.exit(1);
}

const CT = JSON.parse(readFileSync(join(ROOT, 'verification', 'consumer-targets.json'), 'utf8'));
const SITE_LIST = Object.keys(CT.publicDirs || {}).filter((k) => k[0] !== '$').sort();

// latin1 = 逐字节无损的读写通道（见文件头「编码」）。
const read = (f) => readFileSync(f, 'latin1');
const write = (f, s) => writeFileSync(f, Buffer.from(s, 'latin1'));

const EXT = new Set(['.html', '.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.json', '.md', '.mdx', '.txt', '.yaml', '.yml', '.vue', '.svelte']);
const SKIP_DIR = /(^|[\\/])(node_modules|dist|\.git|\.astro|\.next|build|coverage)([\\/]|$)/;
// 只改 CDN 运行期资产路径。构建期代码走 npm，与这里无关。
const RE = /(https:\/\/cdn\.autional\.cn\/ui\/)v([^\/"'\s]+)(\/)/g;
// 版本段必须真的像个版本。文档注释里有一种**示例 URL**：`…/ui/v0.1.0-rc.<pin>/tokens.css`
// （三个 SPA 的 vite.harness.config.ts 各有一条），把它当版本替换掉就把说明改成了假话。
const VERSION_SEG = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$/;
// latest.json 的 version 不带前导 v（`0.1.0-rc.be30012d`），而站点里的 pin 字面量带（`'v0.1.0-rc.be30012d'`）。
const WANT_PIN = 'v' + WANT;

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

const urlReport = [];
const pinReport = [];
const conflicts = [];
const examples = [];
let totalHits = 0;
const staleVersions = new Set();

for (const site of SITE_LIST) {
  const root = join(SITES, site);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error('跳过 ' + site + '：目录不存在（' + root + '）');
    continue;
  }

  // ① 字面 URL
  const hits = [];
  for (const f of walk(root, [])) {
    const src = read(f);
    if (!src.includes('cdn.autional.cn/ui/')) continue;
    let n = 0;
    const next = src.replace(RE, (m, head, ver, tail) => {
      if (ver === WANT) return m;
      if (!VERSION_SEG.test(ver)) {
        if (examples.length < 5) examples.push(relative(root, f).replace(/\\/g, '/') + ' → v' + ver + '（示例/占位，未改）');
        return m;
      }
      n++;
      staleVersions.add(ver);
      return head + 'v' + WANT + tail;
    });
    if (n) hits.push({ f: relative(root, f).replace(/\\/g, '/'), n, next, src });
  }
  if (hits.length) urlReport.push({ site, hits, total: hits.reduce((a, h) => a + h.n, 0) });
  totalHits += hits.reduce((a, h) => a + h.n, 0);

  // ② CDN_PIN 常量（两个候选文件里若都有，必须同值 —— 否则版本有两个来源）
  const found = PIN_FILES
    .map((rel) => ({ rel, file: join(root, rel) }))
    .filter((x) => existsSync(x.file))
    .map((x) => {
      const m = read(x.file).match(PIN_RE);
      return m ? { ...x, value: m[3], next: read(x.file).replace(PIN_RE, (mm, pre, q) => pre + q + WANT_PIN + q) } : null;
    })
    .filter(Boolean);
  if (found.length > 1) {
    const vals = [...new Set(found.map((x) => x.value))];
    if (vals.length > 1) conflicts.push(site + '：' + found.map((x) => x.rel + '=' + x.value).join('  vs  '));
  }
  for (const x of found) {
    if (x.value !== WANT_PIN) pinReport.push({ site, rel: x.rel, from: x.value, file: x.file, next: x.next });
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log('CDN 当前版本：' + WANT);
console.log('');
console.log('  站点             CDN_PIN');
for (const site of SITE_LIST) {
  const root = join(SITES, site);
  if (!existsSync(root) || !statSync(root).isDirectory()) continue;
  let pin = '（无）';
  for (const rel of PIN_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const m = read(p).match(PIN_RE);
    if (m) { pin = m[3]; break; }
  }
  console.log('  ' + site.padEnd(15) + pin + (pin === WANT_PIN || pin === '（无）' ? '' : '   ← 待抬'));
}
console.log('');

if (!urlReport.length && !pinReport.length) {
  console.log('全部 ' + SITE_LIST.length + ' 个站点的字面 URL 与 CDN_PIN 都已指向 ' + WANT + '，无需改动。');
  process.exit(conflicts.length ? 1 : 0);
}
if (staleVersions.size) console.log('发现旧版本：' + [...staleVersions].join(', '));
for (const e of examples) console.log('  跳过 ' + e);
for (const r of urlReport) {
  console.log('  ' + r.site + '  字面 URL ' + r.total + ' 处 / ' + r.hits.length + ' 个文件');
  for (const h of r.hits) console.log('      ' + h.f + '  ×' + h.n);
}
for (const p of pinReport) console.log('  ' + p.site + '  CDN_PIN ' + p.from + ' → ' + WANT + '（' + p.rel + '）');
if (conflicts.length) {
  console.error('同一个站点有两个互相矛盾的 pin（版本有两个来源，先人工定夺）：');
  for (const c of conflicts) console.error('  ' + c);
  process.exit(1);
}

if (!WRITE) {
  console.log('\n（预演。加 --write 实际写入。）');
  process.exit(0);
}

// ── 写入 ────────────────────────────────────────────────────────────────────
let written = 0;
for (const r of urlReport) {
  for (const h of r.hits) {
    const p = join(SITES, r.site, h.f);
    write(p, h.next);
    if (read(p) === h.src) {
      console.error('自证失败：' + r.site + '/' + h.f + ' 写入后内容未变');
      process.exit(1);
    }
    written++;
  }
}
for (const p of pinReport) {
  const before = read(p.file);
  write(p.file, p.next);
  if (read(p.file) === before) {
    console.error('自证失败：' + p.site + '/' + p.rel + ' 写入后内容未变');
    process.exit(1);
  }
  written++;
}

// ── 自证：写完之后，全舰队不得再有旧版本（两条通道都查）──────────────────────
const leftovers = [];
for (const site of SITE_LIST) {
  const root = join(SITES, site);
  if (!existsSync(root) || !statSync(root).isDirectory()) continue;
  for (const f of walk(root, [])) {
    const src = read(f);
    for (const m of src.matchAll(/cdn\.autional\.cn\/ui\/v([^\/"'\s]+)\//g)) {
      if (m[1] !== WANT && VERSION_SEG.test(m[1])) leftovers.push(site + '/' + relative(root, f).replace(/\\/g, '/') + ' -> v' + m[1]);
    }
  }
  for (const rel of PIN_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const m = read(p).match(PIN_RE);
    if (m && m[3] !== WANT_PIN) leftovers.push(site + '/' + rel + ' -> CDN_PIN ' + m[3]);
  }
}
if (leftovers.length) {
  console.error('自证失败，仍有旧版本引用：');
  for (const l of leftovers) console.error('  ' + l);
  process.exit(1);
}
console.log('\n已写入 ' + written + ' 个文件；自证：全舰队 ' + SITE_LIST.length + ' 站的 URL 与 CDN_PIN 均为 ' + WANT + '。');
