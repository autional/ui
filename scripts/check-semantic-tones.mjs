#!/usr/bin/env node
// check-semantic-tones —— 状态色语言闸门（verify 第 30 道）
// 用法: node scripts/check-semantic-tones.mjs [--json] [--selftest]
//
// 守的是什么：**同一个「状态映射」构造里，不许混用两种语言** ——
//   一边是语义令牌（success / warning / danger / info 及其 -soft / -text），
//   一边是品牌色阶里**有语义对应档**的那两族（amber ≈ warning、sky ≈ info）。
//
// 为什么需要它（第 63 轮补·三）：色阶迁移时反复看到同一个形态 ——
//   percent > 80 ? 'bg-danger' : percent > 60 ? 'bg-amber-500' : 'bg-success'
//   三档里两档走语义令牌、一档走品牌色阶：**同一个状态维度换了两种语言**，
//   于是「警告」这一档在 A 页是 warning-soft、在 B 页是 amber-50、在 C 页是 amber-900/30。
//   这不是配色偏好，是同一个概念在同一处自相矛盾 —— 与 L12（分类色）、L17（页头名）、
//   以及 Alert 拒绝 brand 档是同一类判断：**一个语义只该有一种长相**。
//
// 判据的边界（**刻意收窄**，避免把合法用法误判成债）：
//   · 只有当**同一个构造里两种语言并存**时才报 —— 整表用 amber、或整表用语义令牌都不报
//     （品牌色阶本身合法，见 DESIGN.md §3）；
//   · 只认两族品牌色阶：amber（有 warning 对应档）与 sky（有 info 对应档）。
//     primary 是品牌锚点、neutral 是中性色，它们**不构成**「语义位置」，不在判据内；
//   · 构造只有两种形态：**一个字符串字面量内**（三元链写在 className 模板里）与
//     **一个对象字面量内**（const statusColors = { healthy: '...', degraded: '...' }）。
//     JSX 大块里两个不同子元素各用一种语言不算同一个构造 —— 这也是刻意的不误报。
//
// 处置方向：把品牌色阶那一支换成对应语义令牌（bg-amber-500 -> bg-warning、
//   bg-amber-50/60 -> bg-warning-soft/60、text-amber-600 -> text-warning-text）。
//   Alert 的注释里早就写着这条：**amber 在语义上属于 warning**。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { ROOT, loadTokens } from './lib/tokens.mjs';
import { makeSkip, ARTIFACT_DIRS, TEST_RE, SRC_EXTS } from './lib/scan-scope.mjs';

const AS_JSON = process.argv.includes('--json');
const SELFTEST = process.argv.includes('--selftest');
const SITES = process.env.AUTIONAL_SITES_DIR || join(ROOT, '..', 'sites');
const BT = String.fromCharCode(96);

// ── 合法集合：从 SSOT 派生（不在这里抄一份）────────────────────────────────
const T = loadTokens();
const COLOR_KEYS = Object.keys(T.core.color).filter((k) => !k.startsWith('$'));
const SEMANTIC = COLOR_KEYS.filter((k) => /^(success|warning|danger|info)(-soft|-text)?$/.test(k));
const BRAND_FAMILIES = ['amber', 'sky'];

const UTILS = 'bg|text|border|ring|divide|from|to|via|fill|stroke|outline|decoration|placeholder|caret|accent|shadow';
const SEM_RE = new RegExp('(?<![' + '\\w' + '-])(?:' + UTILS + ')-(?:' + SEMANTIC.join('|') + ')(?![' + '\\w' + '-])', 'g');
const BRAND_RE = new RegExp('(?<![' + '\\w' + '-])(?:' + UTILS + ')-(?:' + BRAND_FAMILIES.join('|') + ')-(?:50|100|200|300|400|500|600|700|800|900|950)(?:/' + '\\d+)?(?![' + '\\w' + '-])', 'g');

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const lineOf = (s, i) => s.slice(0, i).split('\n').length;

function tones(text) {
  const sem = [...text.matchAll(SEM_RE)].map((m) => m[0]);
  const brand = [...text.matchAll(BRAND_RE)].map((m) => m[0]);
  return { sem: [...new Set(sem)], brand: [...new Set(brand)] };
}

function stringSpans(src) {
  const out = [];
  const re = new RegExp('([' + "'" + '"' + BT + '])((?:\\\\.|(?!\\1)[^\\\\' + '\\n' + '])*)\\1', 'g');
  let m;
  while ((m = re.exec(src))) out.push({ start: m.index, end: m.index + m[0].length, text: m[2] });
  return out;
}

/** 顶层的逗号分段 —— 用来判定这个花括号到底是不是对象字面量。
 *  第一版只数「里面有几个 key:」，于是**函数体**也被当成对象（函数体里总有几个嵌套的对象字面量），
 *  结果把整个组件的所有类名归成一个「状态构造」—— 实测报了 92 处，绝大多数是假阳性。
 *  判据必须落在**这一层**：每个顶层分段都得是 key: 形态；函数体 / JSX 表达式容器 / 块语句都不满足。 */
function topLevelSegments(inner) {
  const segs = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

const KEY_RE = /^\s*(?:\.\.\.|[A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:/;

function objectSpans(src) {
  const out = [];
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') stack.push(i);
    else if (c === '}') {
      const start = stack.pop();
      if (start === undefined) continue;
      const inner = src.slice(start + 1, i);
      const segs = topLevelSegments(inner).filter((s) => s.trim().length);
      if (segs.length < 2) continue;
      if (!segs.every((s) => KEY_RE.test(s))) continue;
      out.push({ start, end: i + 1, text: inner });
    }
  }
  return out;
}

/** 主判据：返回 [{kind, index, sem, brand}] */
export function scanText(text) {
  const src = stripComments(String(text));
  const strs = stringSpans(src);
  const objs = objectSpans(src);
  const out = [];

  // 形态一：一个字符串字面量内混用（三元链就写在 className 模板里）
  for (const s of strs) {
    const t = tones(s.text);
    if (t.sem.length && t.brand.length) out.push({ kind: 'string', index: s.start, end: s.end, sem: t.sem, brand: t.brand });
  }

  // 形态二：一个对象字面量内混用（状态表）
  for (const o of objs) {
    const inside = strs.filter((s) => s.start > o.start && s.end < o.end);
    const withColor = inside.filter((s) => tones(s.text).sem.length || tones(s.text).brand.length);
    if (withColor.length < 2) continue;
    const sem = [...new Set(withColor.flatMap((s) => tones(s.text).sem))];
    const brand = [...new Set(withColor.flatMap((s) => tones(s.text).brand))];
    if (sem.length && brand.length) out.push({ kind: 'object', index: o.start, end: o.end, sem, brand });
  }

  const seen = new Set();
  return out.filter((h) => {
    const key = h.kind + ':' + h.index;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── --selftest：双向对照 ────────────────────────────────────────────────────
function selftest() {
  const D = '$' + '{';
  const POS_STRING = 'className={' + BT + 'x ' + D + "a > 80 ? 'bg-danger' : a > 60 ? 'bg-amber-500' : 'bg-success'}" + BT + '}';
  const POS_OBJECT = "const c = {\n  healthy: 'bg-success-soft',\n  degraded: 'bg-amber-50',\n  unhealthy: 'bg-danger-soft',\n};";
  const NEG_ALL_BRAND = "const c = {\n  a: 'bg-amber-50',\n  b: 'bg-amber-100',\n};";
  const NEG_ALL_SEMANTIC = "const c = {\n  a: 'bg-success-soft',\n  b: 'bg-danger-soft',\n};";
  const NEG_PROSE = '// 这一段用的是 amber-500 与 success，只在注释里出现\nconst x = 1;';
  const NEG_SINGLE_ELEMENT = 'const one = ["bg-amber-50", "text-success-text"];';
  const cases = [
    ['正例·三元链混用', POS_STRING, 1],
    ['正例·状态表混用', POS_OBJECT, 1],
    ['反例·整表品牌色阶', NEG_ALL_BRAND, 0],
    ['反例·整表语义令牌', NEG_ALL_SEMANTIC, 0],
    ['反例·注释里的类名', NEG_PROSE, 0],
    ['反例·数组不是状态表', NEG_SINGLE_ELEMENT, 0],
  ];
  let bad = 0;
  for (const [name, text, expect] of cases) {
    const hits = scanText(text).length;
    const ok = hits === expect;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + ' -> ' + hits + ' 处（期望 ' + expect + '）');
    if (!ok) bad += 1;
  }
  // 哨兵：断言判据本身不是恒假
  const sentinel = scanText(POS_STRING).length;
  console.log('  哨兵：正例文本必须命中 -> ' + sentinel + '（应 >= 1）');
  if (sentinel < 1) bad += 1;
  console.log(bad === 0 ? 'selftest OK：6 组对照全部符合预期' : 'selftest FAILED：' + bad + ' 组不符合预期');
  process.exit(bad === 0 ? 0 : 1);
}


// ── 扫描 ────────────────────────────────────────────────────────────────
const SKIP = makeSkip(...ARTIFACT_DIRS);
function walk(dir, out = []) {
  let es = [];
  try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) { walk(p, out); continue; }
    if (!SRC_EXTS.has(extname(e.name))) continue;
    if (TEST_RE.test(p)) continue;
    out.push(p);
  }
  return out;
}

async function main() {
  const findings = [];
  const targets = [];
  // 站点树不在本机时（CI）只跑设计系统那一半 —— 与 check-typecheck / check-consumers 同一口径：
  // 门户这一层在 CI 里按定义不生效，发布前必须在本机跑过全量 verify（release.mjs 会挡）。
  // 缺这道护栏的后果实录：release.yml 首跑时本闸门在 CI 直接 ENOENT 崩掉，27/28 即红。
  const hasSites = existsSync(SITES);
  if (!hasSites && !AS_JSON) {
    console.log('check-semantic-tones：本次工作区没有 sites/ —— 站点这一层本闸门在 CI 里不生效；发布前必须在本机跑过全量 verify（release.mjs 会挡住）。设计系统（packages/）仍照扫。');
  }
  for (const site of (hasSites ? readdirSync(SITES).sort() : [])) {
    const dir = join(SITES, site);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    targets.push(site);
    for (const f of walk(dir)) {
      const text = readFileSync(f, 'utf8');
      for (const h of scanText(text)) {
        findings.push({
          site,
          file: relative(SITES, f).split('\\').join('/'),
          line: lineOf(stripComments(text), h.index),
          kind: h.kind,
          sem: h.sem,
          brand: h.brand
        });
      }
    }
  }
  for (const f of walk(join(ROOT, 'packages'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (/packages\/(tailwind-preset|tokens)\//.test(rel)) continue;
    const text = readFileSync(f, 'utf8');
    for (const h of scanText(text)) {
      findings.push({ site: '(design-system)', file: rel, line: lineOf(stripComments(text), h.index), kind: h.kind, sem: h.sem, brand: h.brand });
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ targets: targets.length, findings }, null, 2));
  } else {
    console.log('状态色语言闸门：' + targets.length + ' 个站点 + 设计系统');
    console.log('  判据：同一个状态构造（字符串内 / 对象字面量内）不许混用「语义令牌」与「品牌色阶（amber|sky）」');
    console.log('  语义令牌：' + SEMANTIC.join(' / '));
    console.log('  品牌色阶（有语义对应档的两族）：' + BRAND_FAMILIES.join(' / ') + '（primary / neutral 不在判据内）');
    console.log('');
    if (findings.length === 0) console.log('  0 处 —— 每个状态维度只用一种语言。');
    for (const h of findings) {
      console.log('  [' + h.kind + '] ' + h.site + ' · ' + h.file + ':' + h.line);
      console.log('        语义令牌：' + h.sem.join(' ') + '   品牌色阶：' + h.brand.join(' '));
    }
    console.log('');
    console.log(findings.length === 0
      ? '结论：状态色语言一致（' + targets.length + ' 站 + DS 全部 0 处）'
      : '结论：有 ' + findings.length + ' 处「同一个状态构造混用两种语言」—— 把品牌色阶那一支换成对应语义令牌（amber -> warning、sky -> info）');
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

// ── 主模块守卫 ──────────────────────────────────────────────────────────
// 迁移脚本要 import 本文件的 scanText（拿构造的 span）：一旦 import 就把整个舰队扫一遍
// 再 process.exit，迁移脚本会被它直接带走 —— 与 release.mjs 的教训同型（裸 import 一个
// 「有主流程的脚本」等于执行它）。所以主流程进函数 + 守卫，且守卫放在**文件末尾**
// （放在前面会撞 TDZ：SKIP / walk 还没初始化）。
// 判定走 lib/is-main.mjs（junction 安全）：经 .refs/ui 调用时 argv[1] 是 junction 路径、
// import.meta.url 是真实路径，直接比较会判成「被 import」→ 静默 exit 0（2026-11-14 实测两次）。
if (isMain(import.meta.url)) {
  if (SELFTEST) selftest();
  await main();
}
