#!/usr/bin/env node
// publish-npm —— 发布 npm 的**单一入口**（本地 scripts/release.mjs 与 CI release.yml 共用）。
//
// 为什么单列出来：此前两条路各写各的 —— release.mjs 是「读注册表、只发未上架的版本」，
// 而 release.yml 是裸的 `pnpm -r publish`。两者在**已存在的版本**上处置正好相反：
// 后者会报冲突退出，于是「只改了 ui 一个包」的正常发版会被 tokens/preset/shared 的
// 旧版本号挡住（第 59 轮实测）。同一个动作两套实现必然漂开，所以抽成一个入口。
//
// 四步，任何一步失败都中止（宁可停在这里，也不要让半个交付面出门）：
//   ① 读注册表 → 只发「本地版本还没上过注册表」的包（逐包 --filter）
//   ② 读回注册表 —— CLI 的成功输出不等于注册表里有（重试 24 × 15s）
//   ③ latest 对齐到 tag（重试 8 × 30s；政策见计划文末「规则 2」）
//   ④ 发布后置门 check-publish（重试 6 × 30s）
//
// 第 57 轮实测的两个陷阱，都在这份脚本里被挡掉（别再靠人记）：
//   ① **pnpm 要 npm_config_registry 才认得 authToken**：本机 ~/.npmrc 的默认 registry 指向镜像站，
//      而凭据绑在 npmjs 上 —— 只给 --registry 参数不够，PUT 会 404。
//   ② **不要用 npm publish**：它会把版本「暂存」（CLI 打印成功、注册表读不到，重发报
//      E409 Cannot publish over previously staged version）。pnpm 才是能落地的那条路。
//
// 用法: node scripts/publish-npm.mjs [--tag rc]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { ROOT } from './lib/tokens.mjs';
import { REGISTRY } from './lib/dist-tags.mjs';

const argv = process.argv.slice(2);
const tagIdx = argv.indexOf('--tag');
const TAG = tagIdx >= 0 ? argv[tagIdx + 1] : 'rc';

export async function main() {
  const run = (cmd, args, label, env) => {
    console.log('');
    console.log('── ' + label + ' ' + '─'.repeat(Math.max(0, 52 - label.length)));
    try {
      execFileSync(cmd, args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, ...(env || {}) },
      });
    } catch (e) {
      console.error('');
      console.error('中止：' + label + ' 失败。**没有继续往下发**。');
      process.exit(1);
    }
  };

  // 工作区里的包清单（发布与读回都用它）—— **必须先定义再用**：
  // 第一次写这段时把它放在了读回段，于是 published 那几行落在 TDZ 里（syntax check 看不出来）。
  const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(ROOT, 'packages', e.name, 'package.json'))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')))
    .filter((j) => j.name && j.version);

  // 只发「本地版本还没上过注册表」的包。
  // 为什么不用 `pnpm -r publish`（第 59 轮实测）：它对**已存在的版本**会报冲突退出，
  // 于是「只改了 ui 一个包」的正常发版会被 tokens/preset/shared 的旧版本号挡住。
  // 先读一遍注册表，把要发的列出来；一个都没有就明说「无需发布」，而不是发一堆空版本。
  const published = new Set();
  for (const j of packages) {
    try {
      const r = await fetch(REGISTRY + j.name.replace('/', '%2f'), { cache: 'no-store' });
      const doc = await r.json();
      if (doc.versions && doc.versions[j.version]) published.add(j.name);
    } catch (e) { /* 读不到就当作要发，后面的读回会兜 */ }
  }
  const toPublish = packages.filter((j) => !published.has(j.name));
  console.log('');
  console.log('── ① 发布 npm（tag=' + TAG + '） ' + '─'.repeat(20));
  console.log('  待发：' + (toPublish.length ? toPublish.map((j) => j.name + '@' + j.version).join('、') : '（无：所有本地版本都已在注册表上）'));
  if (toPublish.length) {
    // `--filter` 每个包一个 —— 写成 `--filter "a b"` 时 pnpm 把 b 当成**脚本名**，
    // 报 "None of the selected packages has a \"b\" script"（第 59 轮实测）。
    // 顺序按依赖：tokens 在 preset 之前（后者的 workspace:* 会被改写成本地版本号）。
    const args = [];
    for (const j of toPublish) args.push('--filter', j.name);
    args.push('publish', '--access', 'public', '--tag', TAG, '--registry=' + REGISTRY, '--no-git-checks');
    run('pnpm', args, '  发布 ' + toPublish.length + ' 个包：' + toPublish.map((j) => j.name).join('、'), { npm_config_registry: REGISTRY });
  }

  // ── 读回：CLI 的成功输出不等于注册表里有 ──────────────────────────────────
  const missing = [];
  console.log('');
  console.log('── ② 读回注册表（CLI 说成功不算数） ' + '─'.repeat(12));
  for (const j of packages) {
    let ok = false;
    // 窗口被实测推动过两次：80s 不够（第 59 轮）；3 分钟也不够（run 37772600336 ——
    // tokens@0.1.0-rc.17 在 11:52:59 报 MISS，11:53:06 registry 就已可见，差 7 秒）。
    // 「读不到」与「发歪了」处置完全不同，所以宁可多等 —— 24 × 15s = 6 分钟。
    for (let i = 0; i < 24 && !ok; i++) {
      try {
        const r = await fetch(REGISTRY + j.name.replace('/', '%2f'), { cache: 'no-store' });
        const doc = await r.json();
        ok = !!(doc.versions && doc.versions[j.version]);
      } catch (e) { /* 传播窗口内读不到是正常的 */ }
      if (!ok) await new Promise((res) => setTimeout(res, 15000));
    }
    console.log('  ' + (ok ? '[OK]  ' : '[MISS]') + ' ' + j.name + '@' + j.version);
    if (!ok) missing.push(j.name + '@' + j.version);
  }
  if (missing.length) {
    console.error('');
    console.error('中止：以下版本发布后读不到：' + missing.join('、'));
    console.error('先别继续，也不要重发同一个版本号 —— 用 registry 直读复核，必要时换一个版本号再发。');
    process.exit(1);
  }

  // ⚠️ 顺序：**先对齐 dist-tags，再跑一致性门**。
  // 第 61 轮实测：check-publish 会断言 `latest == rc`，而在对齐之前那一项按定义必然是红的
  // （`@autional/ui：latest=0.1.0-rc.44 而 rc=0.1.0-rc.45`）—— 它把「还没轮到的那一步」
  // 报成了「发歪了」，于是整条发布链在这里假红中止。判据的顺序也是判据的一部分。
  // ⚠️ 这一步同样**必须带重试**，原因和下面那道门一模一样：刚发布的包在 npm 上有几分钟的
  // 「processing」传播窗口，读 dist-tags 会读到旧 doc。第 62 轮实测：发布刚结束就对齐，
  // 自证报「@autional/tailwind-preset：latest=0.1.0-rc.7 而 rc=0.1.0-rc.8」并中止，
  // 而几分钟后**原样重跑**的输出是六个包全 OK「无需对齐」—— 也就是说第 61 轮修好的「顺序」
  // 问题之后，这里还藏着第二个同型问题：**把「还没传播完」报成了「发歪了」**。
  console.log('');
  console.log('── ③ latest 对齐到 ' + TAG + '（带传播等待） ' + '─'.repeat(10));
  {
    let aligned = false;
    for (let i = 1; i <= 8 && !aligned; i++) {
      try {
        execFileSync('node', ['scripts/align-dist-tags.mjs', '--write'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
        aligned = true;
      } catch (e) {
        console.log('  （第 ' + i + '/8 次未对齐 —— 刚发布的包可能还在 processing，等 30s 再读）');
        await new Promise((res) => setTimeout(res, 30000));
      }
    }
    if (!aligned) {
      console.error('');
      console.error('中止：连续 8 次读到的 dist-tags 都没对齐到 ' + TAG + '。**这时才该怀疑「真没对齐」**——先人工跑 pnpm dist-tags:align 复核，别重发同一个版本号。');
      process.exit(1);
    }
  }

  // 发布后补跑 publish 一致性 —— 它现在有真实语义了（此前按定义为红）。
  // ⚠️ 必须**带重试**，理由与上面 ③ 完全相同（第 59 轮实测）：刚发布的包在 npm 上有几分钟的
  // 「processing」传播窗口，紧接着跑 check-publish 会因为读到旧的 packument 而报「内容不一致」——
  // 那看起来像「发歪了」，其实是还没传播完。两种情况的处置完全不同，所以这里要等它。
  console.log('');
  console.log('── ④ 发布后置门：npm 与 SSOT 一致（带传播等待） ' + '─'.repeat(10));
  {
    let ok = false;
    for (let i = 1; i <= 6 && !ok; i++) {
      try {
        execFileSync('node', ['scripts/check-publish.mjs'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
        ok = true;
      } catch (e) {
        console.log('  （第 ' + i + '/6 次不一致 —— 刚发布的包可能还在 processing，等 30s 再读）');
        await new Promise((res) => setTimeout(res, 30000));
      }
    }
    if (!ok) {
      console.error('');
      console.error('中止：发布后置门连续 6 次不一致。**这时才该怀疑「发歪了」**——先人工核对再决定，别重发同一个版本号。');
      process.exit(1);
    }
  }
}

// 主模块守卫：**被 import 时不许执行**（与 release.mjs 同一条教训：
// 拿 node -e "import('./scripts/x.mjs')" 做语法自检时，它真的开始跑流程了）。
// 判定走 lib/is-main.mjs：经 .refs/ui junction 调用时 argv[1] 是 junction 路径、
// import.meta.url 是真实路径，直接比较会判成「被 import」→ 静默 exit 0（2026-11-14 实测两次）。
if (isMain(import.meta.url)) await main();
