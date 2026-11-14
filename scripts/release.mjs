#!/usr/bin/env node
// release —— 一条命令发布**两个交付面**，让它们不可能因为「忘了做另一步」而漂开。
//
// 设计系统的产物有三个交付面，都由同一份 SSOT 派生：
//   ① npm 包（构建期代码）  ② CDN（运行期资产）  ③ 站点内 vendored 副本（回滚通道）
//
// 此前它们是**三个互不相干的手工动作**，而闸门只在你主动跑 verify 时才发现不一致。
// 实测过的两次：令牌改了半个多月而 CDN 是旧的（第 24 轮发现）；
// npm 与 SSOT 之间**根本没有检查**（第 41 轮补上第 16 道闸门）。
//
// 本脚本把顺序固定下来，并在每一步失败时中止：
//   1. pnpm verify            —— 全部闸门必须全绿，否则不发（不写死道数，写死了就会过期）
//   2. scripts/publish-npm.mjs —— 发布 npm 的**单一入口**（读回 / latest 对齐 / 一致性自证都在里面；
//                                 与 CI release.yml 共用同一个脚本 —— 此前「只发未上架」与
//                                 「裸 pnpm -r publish」两套实现已在「已存在版本」上漂开，第 59 轮实测）
//   3. pnpm build:cdn         —— 重建 CDN 产物到 ../cdn（版本目录名带内容指纹）
//   4. 提示提交 ../cdn + 跑 bump:cdn —— 不代你提交，那是对外发布动作
//
// 发布段（npm）的实测陷阱 —— pnpm 要 npm_config_registry 才认得 authToken；不要用 npm publish ——
// 见 scripts/publish-npm.mjs 的文件头：注释跟着实现走，这里不复述。
//
// **发布必须发生在舰队在场的机器上**：release.yml 在 CI 上跑不过自己的前置门，
// 因为 CI 里没有 sites/，门户那一层闸门按定义不生效 —— 在这里发布等于跳过它们。
//
// 用法: node scripts/release.mjs [--tag rc] [--skip-verify]

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { ROOT } from './lib/tokens.mjs';

const argv = process.argv.slice(2);
const tagIdx = argv.indexOf('--tag');
const TAG = tagIdx >= 0 ? argv[tagIdx + 1] : 'rc';
const SKIP_VERIFY = argv.includes('--skip-verify');

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
      console.error('中止：' + label + ' 失败。**没有继续往下发**——宁可停在这里，也不要让两个交付面分叉。');
      process.exit(1);
    }
  };

  // ── 前置：发布必须发生在**舰队在场**的机器上（第 57 轮实测的教训，写在这里而不是文档里）──
const SITES = process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
  if (!existsSync(SITES)) {
    console.error('拒绝发布：本机没有站点树（' + SITES + '）。');
    console.error('门户那一层闸门（类型检查等）只有舰队在场时才生效 —— 在这里发布等于跳过它们。');
    console.error('要么在舰队机器上跑本脚本，要么先在本机跑 node scripts/verify.mjs --except publish,cdn 再走 CI 发布。');
    process.exit(2);
  }

  // 发布前跑的是 `verify --except publish,cdn`：那两项断言「交付面已与 SSOT 同步」，
// 而在发布**之前**它们按定义必然为红 —— 让它们变绿正是本次要做的事（与 release.yml 同一口径）。
if (!SKIP_VERIFY) run('node', ['scripts/verify.mjs', '--except', 'publish,cdn'], '1/4 全部闸门（含舰队层；排除 publish/cdn）');
  else console.log('已跳过 verify（--skip-verify，仅用于明确知道后果时）');

  // 发布 npm 的**单一入口**（scripts/publish-npm.mjs）：读注册表筛未上架 → 逐包 publish →
  // 读回 → latest 对齐 → 一致性自证，全部逻辑与「processing 传播窗口」的实测注释都在那里。
  // 与 CI release.yml 共用同一个脚本 —— 此前两套实现在「已存在版本」上的处置是相反的（第 59 轮实测）。
  run('node', ['scripts/publish-npm.mjs', '--tag', TAG], '2/4 发布 npm（含读回 / latest 对齐 / 一致性自证）');

run('pnpm', ['build:cdn'], '3/4 重建 CDN 产物');

  const CDN = join(ROOT, '..', 'cdn');
  console.log('');
  console.log('npm 与 CDN 两个交付面都已产出。还差两步（刻意不代做）：');
  console.log('');
  console.log('① 提交 CDN（推送即触发 Vercel 生产部署）：');
  console.log('  cd ' + CDN);
  console.log('  git add -A && git commit -m "chore: 发布 v<版本>" && git push');
  console.log('');
  console.log('② 把两个区域全部站点的 <link> 切到新版本目录：');
  console.log('  cd ' + ROOT);
  console.log('  pnpm bump:cdn --write      # 预演先看会改什么；写完自证全舰队 0 处旧引用');
  console.log('  然后逐站提交（每站一个 chore(cdn) commit，与既有 chore(deps) 批次同构）');
  console.log('');
  console.log('为什么这两步不自动化：CDN 的 push 与站点提交都是对外发布动作，');
  console.log('而站点改动会改变渲染，按本仓惯例逐站构建 + 视觉回归后再接受。');
  console.log('忘了②会被闸门抓住：build-cdn 保留旧目录（KEEP=5），但站点若钉在被裁掉的那一个上就会 404，');
  console.log('check-assets 的 cdnDelivered() 断言「站点引用的版本在 CDN 工作区里存在」直接报红。');
  console.log('上线后再跑 node scripts/check-publish.mjs --live 与 check-cdn --live 回验。');
}

// 主模块守卫：**被 import 时不许执行**。
// 第 57 轮实测的教训：我用 node -e "import('./scripts/release.mjs')" 做语法自检，
// 结果它**真的开始发布流程了**（跑到 verify 才被管道关闭杀掉）。脚本不是模块，就别装作是。
// 判定走 lib/is-main.mjs：经 .refs/ui junction 调用时 argv[1] 是 junction 路径、
// import.meta.url 是真实路径，直接比较会判成「被 import」→ 静默 exit 0（2026-11-14 实测两次）。
if (isMain(import.meta.url)) await main();