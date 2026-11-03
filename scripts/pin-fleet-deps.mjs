#!/usr/bin/env node
// pin-fleet-deps — 把 14 个站点的**依赖侧**对齐到舰队政策。两件事，都是同一个问题的两半：
//
//   ① 版本声明精确化：  "@autional/ui": "^0.1.0-rc.2"  →  "0.1.0-rc.2"
//   ② 部署安装冻结：    vercel.json 的 "pnpm install"     →  "pnpm install --frozen-lockfile"
//
// 为什么必须两件一起做（2026-10-03 实测，不是推断）：
//
//   14 个站里有 13 个的 vercel.json 写的是 "pnpm install"（**非 frozen**），只有 web 用了
//   --frozen-lockfile。而站点声明的是 caret —— 于是：
//
//     · 任何一次 @autional/ui 发布（例如 rc.3）会**立即进入 13 个站的下一次生产构建**，
//       而没有任何站点 commit；
//     · 计划里写的「逐站切外壳」不成立 —— 它们同一时刻一起变；
//     · 「单站 revert」也不成立 —— 撤回 package.json 也拦不住，因为区间仍是 ^0.1.0-rc.2。
//
//   只做 ① 不够：package.json 精确了，但非 frozen 的 install 仍可能因 lockfile 与
//   package.json 漂移而装到别的东西。只做 ② 不够：lockfile 冻结了，但 package.json 里
//   写的是区间，"声明的版本"与"实际装的版本"仍然是两个来源。
//
//   这条与舰队反复踩过的坑同型：**同一个值不该有两个来源**（theme_color、CDN 版本、
//   tokens.json 的 schema 版本 vs npm 包版本，都是这一条）。
//
// 用法:
//   node scripts/pin-fleet-deps.mjs            # 只报告（默认）
//   node scripts/pin-fleet-deps.mjs --write    # 实际写入

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ROOT } from './lib/tokens.mjs';
import { PACKAGES, REGISTRY } from './lib/dist-tags.mjs';

const WRITE = process.argv.includes('--write');
// --check：只判定不改写；有漂移即 exit 1（发版波/CI 用）
const CHECK = process.argv.includes('--check');
const SITES = process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
const FROZEN = 'pnpm install --frozen-lockfile';

// 舰队当前版本 = 每个包的 rc tag（rc 是舰队通道；dist-tag 政策由闸门 14 守着）
const fleet = new Map();
for (const p of PACKAGES) {
  try {
    const r = await fetch(REGISTRY + '-/package/' + p.replace('/', '%2f') + '/dist-tags', { cache: 'no-store' });
    const j = await r.json();
    if (j.rc) fleet.set(p, j.rc);
  } catch (e) { /* 离线时后面会报出来 */ }
}

const pkgJsonPaths = (siteDir) => {
  const out = [join(siteDir, 'package.json')];
  const apps = join(siteDir, 'apps');
  if (existsSync(apps)) for (const a of readdirSync(apps)) {
    const p = join(apps, a, 'package.json');
    if (existsSync(p)) out.push(p);
  }
  return out.filter(existsSync);
};

const plan = [];
let siteCount = 0;
for (const site of existsSync(SITES) ? readdirSync(SITES).sort() : []) {
  const siteDir = join(SITES, site);
  if (!statSync(siteDir).isDirectory()) continue;
  siteCount++;

  const depChanges = [];
  for (const pj of pkgJsonPaths(siteDir)) {
    const raw = readFileSync(pj, 'utf8');
    const j = JSON.parse(raw);
    let touched = false;
    for (const sec of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!j[sec]) continue;
      for (const [name, spec] of Object.entries(j[sec])) {
        if (name.indexOf('@autional/') !== 0) continue;
        const want = fleet.get(name);
        if (!want) { depChanges.push({ pj, name, from: spec, to: null, why: 'rc tag 读不到（离线？）' }); continue; }
        if (spec === want) continue;
        // 政策是「精确**且**等于舰队当前版本」，所以两种情况都要对齐：
        //   · caret/tilde          → 精确（包声明只有一个来源）
        //   · 精确但落后于 rc tag   → 对齐（实测踩到：admin 精确停在 ui rc.2 而 rc 通道已是 rc.3；
        //                            而 caret 的站在下一次安装时本来就会拿到 rc.3 —— 即「声明与实际不一致」）
        if (/^[\^~]/.test(spec)) { j[sec][name] = want; depChanges.push({ pj, name, from: spec, to: want, why: 'caret/tilde → 精确' }); touched = true; }
        else if (spec !== want) { j[sec][name] = want; depChanges.push({ pj, name, from: spec, to: want, why: '精确但落后 → 对齐舰队当前版本' }); touched = true; }
      }
    }
    if (touched) plan.push({ site, kind: 'deps', file: pj, changes: depChanges, next: JSON.stringify(j, null, 2) + '\n', before: raw });
  }

  const vjPath = join(siteDir, 'vercel.json');
  if (existsSync(vjPath)) {
    const raw = readFileSync(vjPath, 'utf8');
    const j = JSON.parse(raw);
    if (j.installCommand && j.installCommand.indexOf('--frozen-lockfile') < 0) {
      const fromIc = j.installCommand;   // 先取原值再改，否则打印出来的 from 是改完的值
      j.installCommand = FROZEN;
      plan.push({ site, kind: 'freeze', file: vjPath, changes: [{ name: 'installCommand', from: fromIc, to: FROZEN, why: '非 frozen 安装 → 冻结' }], next: JSON.stringify(j, null, 2) + '\n', before: raw });
    }
  }
}

console.log('舰队当前版本（rc 通道）：');
for (const [k, v] of fleet) console.log('  ' + k.padEnd(28) + v);
console.log('');
if (!existsSync(SITES)) { console.log('pin-fleet-deps：没有 sites/（' + SITES + '），跳过。'); process.exit(0); }
if (!fleet.size) { console.log('舰队版本读不到（离线？）—— 无法判定，跳过。'); process.exit(0); }
if (!plan.length) { console.log(siteCount + ' 个站已全部符合政策，无需改动。'); process.exit(0); }

for (const p of plan) {
  console.log(p.site + '  [' + p.kind + ']  ' + relative(SITES, p.file).replace(/\\/g, '/'));
  for (const c of p.changes) {
    console.log('    ' + (c.name || '?') + '  ' + (c.from || '(无)') + '  ->  ' + (c.to === null ? '（读不到版本）' : c.to) + '   〔' + c.why + '〕');
  }
}
console.log('');
console.log('合计 ' + plan.length + ' 个文件待改（' + plan.filter((p) => p.kind === 'deps').length + ' 个依赖声明 / ' + plan.filter((p) => p.kind === 'freeze').length + ' 个部署配置）');

if (CHECK) {
  console.log('');
  console.log('[FAIL] 舰队依赖/部署配置与 rc 通道不一致（' + plan.length + ' 个文件）—— 跑 node scripts/pin-fleet-deps.mjs --write 后逐站提交。');
  process.exit(1);
}
if (!WRITE) { console.log('\n（预演。加 --write 实际写入。）'); process.exit(0); }

let n = 0;
for (const p of plan) {
  if (p.changes.some((c) => c.to === null)) { console.log('跳过 ' + p.file + '：有读不到版本的依赖，先解决网络'); continue; }
  writeFileSync(p.file, p.next);
  if (readFileSync(p.file, 'utf8') !== p.next) { console.error('自证失败：' + p.file + ' 写入后内容不符'); process.exit(1); }
  n++;
}
console.log('\n已写入 ' + n + ' 个文件。');
