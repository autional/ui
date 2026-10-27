#!/usr/bin/env node
/**
 * check-site-css-layers —— 站点样式层守卫（Tailwind 4 专用）。
 *
 * 为什么（2026-10-27，两次真实事故）：
 *   ① wiki 整站内文退化成无样式纯文本 —— 容器类名漂移，三个月没人发现；
 *   ② CDN tokens.css 被摊平，`html/body/:focus-visible` 变成**无层**规则。
 * 两次同一个根因：**Tailwind 4 把 utility 放进原生 @layer，而无层规则永远赢，与特异度无关。**
 * 一条 `body { color: … }` 写在源码里，就能压死页面上所有 `text-*`；而且它看起来完全正常。
 *
 * 判据（只看**无层的全局规则**；类/属性/ID 选择器天然不会误伤）：
 *   一条规则算违规 ⇔ 它不在 @layer 里，且选择器里没有 .类 / #id / [属性]，
 *   且样式块不是「只声明 CSS 变量」（`--x: …` 不参与层叠竞争，:root 调色板因此合法）。
 *
 * 覆盖边界：扫**源码**（作者唯一的入口）。语料注入到构建产物的样式不在这里 ——
 * wiki 由 postbuild 的 check-styles S1/S2 单独守。构建产物是源码的函数，源码干净即可。
 *
 * 两种运行位置（脚本按**文件名**判断，内容逐字节相同）：
 *   · 站点内 `scripts/check-layers.mjs`（由 `--sync` 写入，挂在 postbuild）→ 扫本仓；
 *   · ui 仓 `scripts/check-site-css-layers.mjs`（verify 的一道闸门）→ 校验 5 个站的副本没漂移 + 全量扫一遍。
 * 一份实现两处跑：抄 5 份实现必然有 1 份会腐，所以副本由 `--sync` 生成、由本闸门逐字节比对。
 *
 * 用法:
 *   node scripts/check-site-css-layers.mjs           # 校验（副本漂移 + 全量扫描）
 *   node scripts/check-site-css-layers.mjs --sync    # 把副本写进各 TW4 站
 *   node scripts/check-layers.mjs                    # 站点内：只扫本仓
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SELF);
const REPO = dirname(SCRIPT_DIR);
const COPY_NAME = 'check-layers.mjs';
const FLEET = basename(SELF) === 'check-site-css-layers.mjs';
const SYNC = process.argv.includes('--sync');

// ── 解析 ────────────────────────────────────────────────────────────────────
// 注释换成等量换行而不是删掉 —— 否则后面的行号全错位。
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));

// 不进层叠竞争（或本身是容器）的 at-rule：整块跳过，不做判定。
const AT_SKIP = /^@(font-face|keyframes|property|page|charset|import|custom-media|custom-selector|apply|tailwind|theme|plugin|source|config|reference|namespace)\b/i;
// 容器型 at-rule：内部规则**仍是**无层的，递归进去照判。
const AT_WRAP = /^@(media|supports|container|scope|starting-style)\b/i;

function matchBrace(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d === 0) return i; }
  }
  return s.length;
}

/** 收集区域内所有样式规则：{ selector, body, layered, index }（index 相对传入的 css 文本）。 */
function collectRules(css, layered = false, out = []) {
  let i = 0;
  let selStart = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '{') {
      const raw = css.slice(selStart, i);
      // 行号要指向选择器本身：跳过规则之间累积的空白/换行。
      const lead = raw.length - raw.replace(/^\s+/, '').length;
      const prelude = raw.trim();
      if (prelude.startsWith('@')) {
        const end = matchBrace(css, i);
        if (/^@layer\b/i.test(prelude) && !prelude.endsWith(',')) {
          collectRules(css.slice(i + 1, end), true, out);       // @layer 块内：合法
        } else if (AT_WRAP.test(prelude)) {
          collectRules(css.slice(i + 1, end), layered, out);     // @media 等：层属性继承
        } else if (AT_SKIP.test(prelude)) {
          // 跳过
        } // 其余未知 at-rule 整块跳过（宁可漏判，不误伤）
        i = end + 1; selStart = i; continue;
      }
      const end = matchBrace(css, i);
      out.push({ selector: prelude, body: css.slice(i + 1, end), layered, index: selStart + lead });
      i = end + 1; selStart = i; continue;
    }
    if (c === ';') selStart = i + 1;
    i++;
  }
  return out;
}

const onlyCustomProps = (body) => {
  const chunks = body.split(';').map((s) => s.trim()).filter(Boolean);
  return chunks.length > 0 && chunks.every((s) => /^--[\w-]+\s*:/.test(s));
};

/** 选择器是否被类/ID/属性约束（约束了就不可能压过 utility）。 */
const scoped = (sel) => /[.#[]/.test(sel.replace(/"[^"]*"|'[^']*'/g, ''));

/** 一条规则是否构成「无层全局规则」。 */
function isViolation(rule) {
  if (rule.layered) return false;
  if (onlyCustomProps(rule.body)) return false;
  return rule.selector.split(',').map((s) => s.trim()).filter(Boolean).some((s) => !scoped(s));
}

/** 扫一段 CSS 文本，返回违规列表 [{ selector, line }]。 */
function scanCss(css, lineBase = 1) {
  const clean = stripComments(css);
  const out = [];
  for (const r of collectRules(clean)) {
    if (!isViolation(r)) continue;
    const line = lineBase + (clean.slice(0, r.index).match(/\n/g) || []).length;
    out.push({ selector: r.selector.replace(/\s+/g, ' '), line });
  }
  return out;
}

// ── 自证：闸门自己不许静默坏掉（解析器改坏时最容易的表现是「0 违规」）────────────
const SELFTESTS = [
  ['无层 body 必须被抓到', 'body { color: red }', true],
  ['@layer 内同一条必须放行', '@layer base { body { color: red } }', false],
  ['只声明 CSS 变量必须放行', ':root { --x: 1px; --y: 2px }', false],
  ['类选择器必须放行', '.wiki-detail-content p { margin: 0 }', false],
  ['@media 里的裸元素必须被抓到', '@media (min-width: 40rem) { p { margin: 0 } }', true],
  ['属性选择器算有约束，必须放行', '[data-theme] p { margin: 0 }', false],
  ['@font-face / @keyframes 不参与判定', '@font-face { font-family: X } @keyframes k { from { opacity: 0 } }', false],
];
for (const [name, css, want] of SELFTESTS) {
  const got = scanCss(css).length > 0;
  if (got !== want) {
    console.error('[自证失败] ' + name + '（期望违规=' + want + '，实际=' + got + '）—— 解析器坏了，本闸门不可信');
    process.exit(1);
  }
}

// ── 扫站点源码 ──────────────────────────────────────────────────────────────
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', '.astro', 'build', 'coverage', '.turbo', '.vercel', 'public', '.cache', 'storybook-static']);
const STYLE_FILE = /\.(css|astro|html|md|mdx)$/i;

function walk(dir, out, depth) {
  if (depth > 8) return out;
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
}

/** 扫一个仓的 src/，返回 [{ file, line, selector }]。 */
function scanRepo(repo) {
  const src = join(repo, 'src');
  if (!existsSync(src)) return [];
  const found = [];
  for (const f of walk(src, [], 0)) {
    if (!STYLE_FILE.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    const rel = relative(repo, f).replace(/\\/g, '/');
    if (/\.css$/i.test(f)) {
      for (const v of scanCss(text)) found.push({ file: rel, ...v });
      continue;
    }
    // .astro / .html / .md / .mdx：只看 <style> 块，行号要补回原文件偏移
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(text))) {
      const base = 1 + (text.slice(0, m.index + m[0].indexOf(m[1])).match(/\n/g) || []).length;
      for (const v of scanCss(m[1], base)) found.push({ file: rel, ...v });
    }
  }
  return found;
}

function twMajor(repo) {
  const candidates = [join(repo, 'package.json')];
  const apps = join(repo, 'apps');
  if (existsSync(apps)) {
    for (const n of readdirSync(apps)) candidates.push(join(apps, n, 'package.json'));
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let j; try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { continue; }
    const v = String({ ...j.dependencies, ...j.devDependencies }.tailwindcss || '');
    const m = /(\d+)\./.exec(v.replace(/^[^\d]*/, ''));
    if (m) return Number(m[1]);
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const problems = [];
const notes = [];

const sitesRoot = process.env.AUTIONAL_SITES_DIR || resolve(REPO, '..', 'sites');
const CT_PATH = join(REPO, 'verification', 'consumer-targets.json');

let targets;
if (FLEET && !existsSync(sitesRoot)) {
  console.log('check-site-css-layers：本次工作区没有 sites/，跳过（CI 里同样跳过）');
  process.exit(0);
}
if (FLEET && !existsSync(CT_PATH)) {
  console.error('找不到 ' + CT_PATH + ' —— fleet 模式要靠它拿站点名单，不能静默退化成「扫 ui 自己」');
  process.exit(1);
}
if (FLEET && existsSync(CT_PATH)) {
  const CT = JSON.parse(readFileSync(CT_PATH, 'utf8'));
  const declared = Object.keys(CT.publicDirs || {}).filter((k) => k[0] !== '$').sort();
  targets = [];
  for (const site of declared) {
    const dir = join(sitesRoot, site);
    if (!existsSync(dir)) { notes.push('跳过 ' + site + '：目录不存在'); continue; }
    const major = twMajor(dir);
    if (major !== 4) { notes.push('跳过 ' + site + '：Tailwind ' + (major || '未声明') + '（无原生级联层，本判据不适用）'); continue; }
    targets.push({ site, dir });
  }
  console.log('样式层守卫：' + targets.length + ' 个 Tailwind 4 站点（' + targets.map((t) => t.site).join('/') + '）');

  // 副本一致性：一份实现两处跑的前提是「两处逐字节相同」。
  const canonical = readFileSync(SELF, 'utf8');
  for (const t of targets) {
    const copy = join(t.dir, 'scripts', COPY_NAME);
    if (SYNC) {
      writeFileSync(copy, canonical);
      console.log('  写入 ' + t.site + '/scripts/' + COPY_NAME);
      continue;
    }
    if (!existsSync(copy)) { problems.push('[C1] ' + t.site + '：没有 scripts/' + COPY_NAME + ' —— 站点构建时不会自检（先跑 --sync）'); continue; }
    if (readFileSync(copy, 'utf8') !== canonical) {
      problems.push('[C1] ' + t.site + '：scripts/' + COPY_NAME + ' 与 ui/scripts/check-site-css-layers.mjs 不一致 —— 副本会腐，跑 --sync 覆盖');
    }
  }
  if (SYNC) process.exit(0);
} else {
  // 站点内模式：只扫本仓。
  const major = twMajor(REPO);
  if (major !== 4) {
    console.log('[check-layers] Tailwind ' + (major || '未声明') + ' —— 无原生级联层，跳过');
    process.exit(0);
  }
  targets = [{ site: basename(REPO), dir: REPO }];
}

for (const t of targets) {
  const found = scanRepo(t.dir);
  for (const v of found) {
    problems.push('[' + t.site + '] ' + v.file + ':' + v.line + '  « ' + v.selector + ' »  —— 无层全局规则会压过 Tailwind 4 的 utility（与特异度无关）');
  }
  console.log('  ' + t.site.padEnd(12) + (found.length ? found.length + ' 处违规' : '干净'));
}

for (const n of notes) console.log('  · ' + n);
if (problems.length) {
  console.error('');
  for (const p of problems) console.error('  [ERROR] ' + p);
  console.error('');
  console.error('修法：把这条规则放进 @layer base { … }（或 @layer components），或改成类选择器。');
  console.error('原理：Tailwind 4 的 utility 在 @layer utilities 里，**无层规则永远赢**。');
  process.exit(1);
}
const scope = FLEET ? targets.length + ' 个站，副本一致' : '本仓';
console.log('[check-layers] PASS —— ' + scope + '，0 处无层全局规则');
