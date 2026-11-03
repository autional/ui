#!/usr/bin/env node
// check-palette — 色板落地自证（verify 新增一道）
//
// 为什么需要（2026-11-03 线上事故，实测代价 = 整站失色）：
//   tokens.css 的 `:root` 里有 4 条间距令牌用了**非法 CSS 标识符**（`--space-0.5` 等，
//   标识符不允许点号）。Tailwind 3 + postcss 宽容跳过这几条声明，而 Tailwind 4 的
//   Lightning CSS 解析失败后**丢弃整条 `:root` 规则** —— 整个色板随之消失。
//   构建全绿、所有既有闸门全绿，只有浏览器里少了颜色。
//
//   既有闸门看的是「源码/清单是否一致」，没有一道看「产物里色板还在不在」。
//   本闸门补这一格。
//
// 两条规则：
//   P1 源侧：tokens.css 里不得出现非法自定义属性名（否则迟早被某个优化器整条丢弃）
//   P2 产物侧：任何产物 CSS 若**引用**了 `var(--color-x)`，就必须在产物里**定义**基础色板
//      （以 `--color-primary-600:` 为哨兵）。缺失 = 色板被优化器丢弃或被提前 tree-shake。
//
// 产物不存在时跳过（与其它闸门一致：CI 里只 checkout ui/ 时正常跳过）。
//
// 用法: node scripts/check-palette.mjs [--json]

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ROOT } from './lib/tokens.mjs';

const AS_JSON = process.argv.includes('--json');
const SITES = process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
const SSOT = join(ROOT, 'packages', 'tokens', 'tokens.css');
const SENTINEL = '--color-primary-600';

const problems = [];
const infos = [];

// ── P1 源侧：非法自定义属性名 ──────────────────────────────────────────────
const IDENT_OK = /^--[A-Za-z0-9_-]+$/;
if (existsSync(SSOT)) {
  const css = readFileSync(SSOT, 'utf8');
  const names = [...new Set([...css.matchAll(/(--[A-Za-z0-9_.\-]+)\s*:/g)].map((m) => m[1]))];
  const bad = names.filter((n) => !IDENT_OK.test(n));
  if (bad.length) {
    problems.push('P1 令牌源里有非法 CSS 自定义属性名（将导致 Tailwind 4 / Lightning CSS 丢弃整条 :root）：' +
      bad.slice(0, 8).join(' ') + (bad.length > 8 ? ' …共 ' + bad.length + ' 个' : '') +
      ' —— 修 scripts/generate.mjs 的 varName 归一后重新生成');
  } else {
    infos.push('P1 令牌源自定义属性名全部合法（' + names.length + ' 个）');
  }
}

// ── P2 产物侧：引用了色板就必须有色板定义 ──────────────────────────────────
// 注意：**不要**跳过 dist/build/out —— 本闸门的判据就在构建产物里。
const SKIP = new Set(['node_modules', '.git', '.astro', '.next', 'coverage', '.turbo', 'storybook-static', '.vercel', '.cache', '.output']);

function collectCss(dir, out, depth = 0) {
  if (depth > 5) return out;
  let es;
  try { es = readdirSync(dir); } catch (e) { return out; }
  for (const name of es) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (e) { continue; }   // statSync 跟随 junction（.refs 下站点是链接）
    if (st.isDirectory()) { collectCss(p, out, depth + 1); continue; }
    // 只认构建产物里的样式：SPA 在 apps/<app>/dist/assets/*.css，Astro 在 dist/_astro/*.css
    const rel = p.replace(/\\/g, '/');
    if (name.endsWith('.css') && /\/(dist|build|out)\//.test(rel)) out.push(p);
  }
  return out;
}

const publicDirs = (() => {
  const p = join(ROOT, 'verification', 'consumer-targets.json');
  if (!existsSync(p)) return [];
  try { return Object.keys(JSON.parse(readFileSync(p, 'utf8')).publicDirs || {}).filter((k) => k[0] !== '$'); } catch (e) { return []; }
})();

let checked = 0;
let skipped = 0;
if (existsSync(SITES)) {
  for (const site of publicDirs.sort()) {
    const dir = join(SITES, site);
    if (!existsSync(dir)) continue;
    const files = collectCss(dir, [], 0);
    if (!files.length) { skipped++; continue; }
    const css = files.map((f) => { try { return readFileSync(f, 'utf8'); } catch (e) { return ''; } }).join('\n');
    const uses = /var\(--color-[\w-]+/.test(css);
    const defines = css.includes(SENTINEL + ':');
    if (uses && !defines) {
      const sample = relative(SITES, files[0]).replace(/\\/g, '/');
      problems.push('P2 ' + site + '：产物 CSS 引用了 var(--color-*) 却没有定义 ' + SENTINEL +
        ' —— 色板被丢弃/未打包（首次出现：' + sample + '）。' +
        '历史上这是非法自定义属性名让 Lightning CSS 丢弃整条 :root 导致的整站失色。');
    } else if (uses) {
      checked++;
    }
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ problems, infos, checked, skipped }, null, 2));
} else {
  console.log('色板落地闸门（源侧标识符 + 产物色板自证）');
  for (const i of infos) console.log('  [INFO ] ' + i);
  console.log('  [INFO ] 产物通过 ' + checked + ' 站；无产物跳过 ' + skipped + ' 站');
  for (const p of problems) console.log('  [ERROR] ' + p);
  console.log(problems.length ? '结论：色板落地有 ' + problems.length + ' 项不达标' : '结论：色板落地通过');
}
process.exit(problems.length ? 1 : 0);
