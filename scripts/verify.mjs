#!/usr/bin/env node
// verify — 一条命令跑完 ui/ 的全部校验，任一失败即退出码 1
// 用法: node scripts/verify.mjs
//
// 分工：
//   gen:check   产物是否与 tokens/tokens.json 一致（新鲜度）
//   lint-tokens SSOT 的值本身是否正确 / 有无冲突 / 是否满足对比度契约
//   token-lock  SSOT 是否被改动过（改动必须登记）
// 三者互补：只跑其中任何一个都会留下盲区。

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/tokens.mjs';

const STEPS = [
  { key: 'gen', label: '生成物一致性', cmd: ['node', 'scripts/generate.mjs', '--check'] },
  { key: 'errors', label: '错误语义契约一致性', cmd: ['node', 'scripts/gen-error-semantics.mjs', '--check'] },
  { key: 'lint', label: '令牌 lint', cmd: ['node', 'scripts/lint-tokens.mjs'] },
  { key: 'lock', label: '令牌快照锁', cmd: ['node', 'scripts/token-lock.mjs', '--check'] },
  { key: 'consumers', label: '消费者副本漂移', cmd: ['node', 'scripts/check-consumers.mjs'] },
  { key: 'assets', label: '字体资产台账 + 字体加载断言', cmd: ['node', 'scripts/check-assets.mjs'] },
  { key: 'typography', label: '排版令牌落地（发布 CSS + 消费方编译产物）', cmd: ['node', 'scripts/check-typography.mjs'] },
  { key: 'chart', label: '图表色板（非文本对比度 + 正常/红绿色盲可区分性）', cmd: ['node', 'scripts/check-chart-palette.mjs'] },
  { key: 'syntax', label: '语法色板（代码底对比度 + 正常/红绿色盲可区分性）', cmd: ['node', 'scripts/check-syntax-palette.mjs'] },
  { key: 'semantic-tones', label: '状态色语言（同一状态构造里不许混用语义令牌与品牌色阶）', cmd: ['node', 'scripts/check-semantic-tones.mjs'] },
  { key: 'cdn', label: 'CDN 资产契约（CORS / 不可变缓存 / manifest 字节一致）', cmd: ['node', 'scripts/check-cdn.mjs'] },
  { key: 'colors', label: '非设计系统色值（是否在重复发明已有令牌）', cmd: ['node', 'scripts/check-colors.mjs'] },
  { key: 'icons', label: '图标套件（声明完整 / 文件存在 / theme-color 单源 / 不漂移）', cmd: ['node', 'scripts/check-icons.mjs'] },
  { key: 'site-layers', label: '站点样式层（无层全局规则会反压 Tailwind 4 utility；含 5 站守卫副本漂移）', cmd: ['node', 'scripts/check-site-css-layers.mjs'] },
  { key: 'headers', label: '顶栏契约（高度令牌驱动 / position / 品牌标）', cmd: ['node', 'scripts/check-headers.mjs'] },
  { key: 'capabilities', label: '预设能力契约（模板用了需要插件的类，插件是否真的在）', cmd: ['node', 'scripts/check-preset-capabilities.mjs'] },
  { key: 'classnames', label: '类名可达性（裸色阶类名写了但生成不出来）', cmd: ['node', 'scripts/check-classnames.mjs'] },
  { key: 'publish', label: '发布一致性（npm 已发布内容是否仍等于当前 SSOT）', cmd: ['node', 'scripts/check-publish.mjs'] },
  { key: 'dep-policy', label: '依赖策略（@autional/* 精确声明 + 部署安装冻结）', cmd: ['node', 'scripts/check-dep-policy.mjs'] },
  { key: 'ds-classes', label: '设计系统组件类生成（导入的组件用到的类必须在产物 CSS 里）', cmd: ['node', 'scripts/check-ds-classes.mjs'] },
  { key: 'non-tenant', label: '业务路由名单（各 portal 注册的非租户首段 vs 自己的路由表）', cmd: ['node', 'scripts/check-non-tenant.mjs'] },
  { key: 'icon-vocabulary', label: '图标词汇（同一概念只许一种写法；棘轮）', cmd: ['node', 'scripts/check-icon-vocabulary.mjs'] },
  { key: 'antd-bridge', label: 'antd 组件级令牌生效（真实浏览器实测 + 阴性对照）', cmd: ['node', 'scripts/check-antd-bridge.mjs'] },
  { key: 'icon-sizing', label: '图标尺寸（每个 lucide 图标必须带显式尺寸；棘轮）', cmd: ['node', 'scripts/check-icon-sizing.mjs'] },
  { key: 'token-tiers', label: '令牌档位（圆角/阴影/间距只走档位：DS 硬零 + 站点棘轮）', cmd: ['node', 'scripts/check-token-tiers.mjs'] },
  { key: 'consistency', label: '跨 portal 视觉一致性（antd 主题 / 入口台账棘轮 / 硬编码色 / 组件库份数 / 令牌覆盖 / 分块策略）', cmd: ['node', 'scripts/check-consistency.mjs'] },
  { key: 'hook-naming', label: 'hooks 命名口径（文件名 kebab-case / hook 函数名 useXxx）', cmd: ['node', 'scripts/check-hook-naming.mjs'] },
  { key: 'typecheck', label: '类型检查（ui 工作区 + 四个在册门户）', cmd: ['node', 'scripts/check-typecheck.mjs'] },
  { key: 'shell', label: '外壳归属（四个在册门户的外壳必须归 AppShell）', cmd: ['node', 'scripts/check-shell.mjs'] },
  { key: 'lint', label: 'lint（error 必须为 0；warning 按台账棘轮）', cmd: ['node', 'scripts/check-lint.mjs'] },
  { key: 'visual', label: '站点视觉回归（无产物/无浏览器时自动跳过）', cmd: ['node', 'scripts/visual.mjs', 'check'] },
  { key: 'contrast', label: '对比度 AA（真实页面渲染出来的前景/背景）', cmd: ['node', 'scripts/check-contrast.mjs'] },
  { key: 'fixed-containment', label: '浮层包含块（position: fixed 的祖先不许建立包含块；静态 + 滚到底两轮）', cmd: ['node', 'scripts/check-fixed-containment.mjs'] }
];

// ── --except：发布流程需要一次「发之前」的全量校验 ──────────────────────────
// 闸门 publish 断言「npm 上已发布的版本 == 本地 SSOT」。发布**之前**它按定义必然为红
// —— 那正是发布要做的事。所以发版流程需要一个"除它以外全跑"的入口。
//
// 但一个通用的 --skip 开关迟早会长成绕闸门的后门。所以允许清单**写死在代码里**，
// 且只允许一个键；输出里显式打印 EXCLUDED 一行，汇总里也标注。
// publish 必须在发布之后补跑（release.yml 的后置步骤），不是可以不跑。
//
// 允许清单恰好两项，理由都是同一类：它们断言的是**交付面与 SSOT 同步**，
// 而发版流程要做的正是"让它们同步"，所以在同步之前它们按定义必然为红。
//   publish —— npm 上已发布的 == 本地 SSOT
//   cdn     —— cdn 工作区的产物 == 本地 SSOT
// 两项都在发布之后补跑（见 release.yml 的后置门）。其余各项在发布前必须全绿。
// （这里**不写死项数**：写死的数字会随着加闸门变成谎话，之前就烂过一次。）
const EXCEPT_ALLOWED = new Set(['publish', 'cdn']);
const exceptIdx = process.argv.indexOf('--except');
const EXCEPT = exceptIdx >= 0
  ? String(process.argv[exceptIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
  : [];
for (const k of EXCEPT) {
  if (!EXCEPT_ALLOWED.has(k)) {
    console.error('--except 只允许排除 ' + [...EXCEPT_ALLOWED].join(' / ') + '，收到：' + k);
    console.error('这不是"跳过闸门"的通用开关：闸门失败要修，不要豁免。');
    process.exit(2);
  }
}
const RUN = STEPS.filter((s) => !EXCEPT.includes(s.key));
if (EXCEPT.length) {
  console.log('⚠️  EXCLUDED：' + EXCEPT.join(', ') + ' —— 本次不跑，发布后必须补跑（见 .github/workflows/release.yml）');
}

const results = [];
for (const step of RUN) {
  console.log('');
  console.log('── ' + step.label + ' (' + step.cmd.slice(1).join(' ') + ') ' + '─'.repeat(Math.max(0, 40 - step.label.length)));
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  results.push({ step, status: r.status });
}

const failed = results.filter((r) => r.status !== 0);
console.log('');
console.log('════════ 汇总 ════════');
for (const r of results) console.log('  ' + (r.status === 0 ? 'PASS' : 'FAIL') + '  ' + r.step.label);
if (failed.length === 0) {
  console.log('结论：全部通过（' + results.length + ' 项' + (EXCEPT.length ? '；另有 ' + EXCEPT.length + ' 项被 EXCLUDED，未验' : '') + '）');
  process.exit(0);
}
console.log('结论：' + failed.length + '/' + results.length + ' 项失败：' + failed.map((r) => r.step.label).join(', '));
process.exit(1);
