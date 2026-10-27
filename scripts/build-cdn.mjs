#!/usr/bin/env node
// build-cdn — 把设计系统的「运行期资产」发布成带版本号的不可变路径，供 cdn.autional.cn 托管。
//
// 为什么需要它（而不是让站点各自拷一份）：
//   ① Go 服务 demo 不是 Node 构建，装不了 npm，只能 <link href="https://cdn..."> 取预编译 CSS
//   ② favicon / logo 在此之前**完全没有交付通道**——ui/assets/ 只被文档引用，14 个站点是手工放置的
//   ③ 字体走同一个 URL 才能跨站命中缓存（14 个门户只下载一次，而不是 14 次）
//
// 输出布局（--out 指向 cdn 仓的工作区）：
//   <out>/ui/v<version>/manifest.json          每个文件的 path / bytes / sha384
//   <out>/ui/v<version>/tokens.css
//   <out>/ui/v<version>/primitives.css
//   <out>/ui/v<version>/fonts/*
//   <out>/ui/v<version>/icons/*                favicon 套件（含生成的 site.webmanifest）
//   <out>/ui/v<version>/logo/*
//   <out>/ui/latest.json                       当前版本指针（短 TTL）
//
// 版本化路径是硬要求：非版本化 + 长 TTL 会让配色改动卡在全站脏缓存里，且无法主动失效。
//
// 用法: node scripts/build-cdn.mjs [--out <dir>]

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, readdirSync, mkdtempSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, loadTokens, resolvedIn, parseHex } from './lib/tokens.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = resolve(outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, '..', 'cdn'));
const CDN_ORIGIN = 'https://cdn.autional.cn';

const T = loadTokens();

// 版本号 = tokens 包版本 + **内容指纹**。指纹不是装饰，是这条路径能不能自称 immutable 的前提。
//
// 背景：vercel.json 对 /ui/:version/:path* 发 "public, max-age=31536000, immutable"，
// 语义是「这个 URL 的字节一年内不会变，别再来问」。而旧实现里 VERSION 只取 tokens 包版本，
// tokens 包从发布至今一直是 0.1.0-rc —— CSS 内容改了、路径不动，同一个 immutable URL 被反复覆盖。
// 实测（cdn 仓 git 历史）：ui/v0.1.0-rc/ 下 manifest.json 改过 7 次、icons/favicon.svg 4 次、
// tokens.css 3 次（blob f1587991 → 7636b285 → f94393c0）。后果不是理论问题：
// favicon 黑块的修复（ef054c8）就发在同一个 URL 下，而浏览器已被承诺一年内不必回源。
//
// 指纹口径（check-cdn 用同一算法独立复算）：
//   sha256( 每个文件的 "<目录内相对路径>\0<sha384>" 按行排序后 join('\n') ) 取前 8 位十六进制
// 刻意**不含** icons/site.webmanifest 与 manifest.json 两个派生文件：
//   前者内含 ABS（依赖 BASE），后者就是清单本身 —— 纳入即循环。
// 排除它是安全的：site.webmanifest 的全部变量是 BASE 与 tokens 的 color.neutral-0，
// 后者一变 tokens.css 必变，指纹照样移动。
const VERSION_BASE = T.$meta.version;
const STAGE = mkdtempSync(join(OUT, '.cdnstage-'));
let VERSION, BASE, DEST, ABS;   // 产物字节确定后才赋值

// ── 源 → 目标 ───────────────────────────────────────────────────────────────
// 图标只保留一套。历史上并存两套（assets/favicon/png 与 assets/favicon_io），
// 二者内容不同、互有缺失：favicon_io 有 favicon.ico 与标准尺寸命名，favicon/png 有
// dark/light/mono 三个 512 变体。这里按用途取并集，而不是把两套都发出去——
// 发两套等于把「哪个才是对的」这个问题留给每个消费者。
const ICONS = [
  ['assets/favicon_io/favicon.ico', 'icons/favicon.ico'],
  ['assets/favicon_io/favicon-16x16.png', 'icons/favicon-16x16.png'],
  ['assets/favicon_io/favicon-32x32.png', 'icons/favicon-32x32.png'],
  ['assets/favicon/png/favicon-48x48.png', 'icons/favicon-48x48.png'],
  ['assets/favicon_io/apple-touch-icon.png', 'icons/apple-touch-icon.png'],
  ['assets/favicon_io/android-chrome-192x192.png', 'icons/android-chrome-192x192.png'],
  ['assets/favicon_io/android-chrome-512x512.png', 'icons/android-chrome-512x512.png'],
  ['assets/logo/favicon.svg', 'icons/favicon.svg'],
  ['assets/favicon/favicon-dark.svg', 'icons/favicon-dark.svg'],
  ['assets/favicon/favicon-light.svg', 'icons/favicon-light.svg'],
  ['assets/favicon/favicon-mono-black.svg', 'icons/favicon-mono-black.svg'],
  ['assets/favicon/favicon-mono-white.svg', 'icons/favicon-mono-white.svg'],
];
const LOGOS = [
  ['assets/logo/logo-mark.svg', 'logo/logo-mark.svg'],
  ['assets/logo/logo-mark.color.svg', 'logo/logo-mark.color.svg'],
  ['assets/logo/logo-mark.dark.svg', 'logo/logo-mark.dark.svg'],
  ['assets/logo/logo-mark.mono-black.svg', 'logo/logo-mark.mono-black.svg'],
  ['assets/logo/logo-mark.mono-white.svg', 'logo/logo-mark.mono-white.svg'],
];
const FONTS = [
  ['packages/tokens/fonts/inter-latin-wght-normal.woff2', 'fonts/inter-latin-wght-normal.woff2'],
  ['packages/tokens/fonts/LICENSE-Inter-OFL.txt', 'fonts/LICENSE-Inter-OFL.txt'],
];
const CSS = [
  ['packages/tokens/tokens.css', 'tokens.css'],
  ['packages/tokens/primitives.css', 'primitives.css'],
];
// profiles 是**按站点**覆盖调色板的样式表（docs / developer）。此前只经 npm 下发，
// 站点从 @import '@autional/tokens/profiles/x.css' 取；CDN 上没有它们，
// 于是「CDN 作为运行期唯一来源」这个前提不成立（少了它 Astro 站会变配色）。
const PROFILES = [
  ['packages/tokens/profiles/docs.css', 'profiles/docs.css'],
  ['packages/tokens/profiles/developer.css', 'profiles/developer.css'],
];

// ── 摊平 @layer ─────────────────────────────────────────────────────────────
// 为什么做：primitives.css 的顶层是 @layer base { … } / @layer components { … }。
// 若原样托管，浏览器会按**原生 CSS 级联层**处理，而原生层内的规则**输给任何未分层规则且
// 与特异性无关** —— 站点自己未分层的 preflight 会盖掉层内的 .brand-button。摊平后至少
// 「层内 vs 层外」的优先级不再反向（层内顺序原样保留：base 先、components 后）。
//
// ⚠️ **但摊平并不等于等价，所以 14 个门户不从这个文件加载 primitives。**
// Tailwind 处理 @layer base/components 时不是就地摊平，而是把内容**按层重新定位**：
// base 段落会落到 preflight **之后**。CDN 作为普通外部样式表加载时，整个文件排在站点
// bundle 之前，于是 base 段落落到 preflight **之前**，preflight 的
// body { line-height: inherit } 反过来盖掉 primitives 的 body { line-height: var(--line-height-body-md) }。
// 实测（轮次 42）：developer-home 3.025% / docs 3.035% / wiki 4.478% 的整页偏移；
// 把 primitives 放回 bundler @import 后三站均为 **0.000%**。
//
// 结论（已固化成闸门 check-icons I22）：**含 Tailwind @layer 语义的样式表不能当运行期
// 外部样式表用**，必须由消费方的构建器处理。CDN 上这份 primitives.css 是留给
// 非 Tailwind 消费方（Go demo 等）的尽力版本，门户不走它。
//
// tokens.css 是例外（2026-10-27）：它不只有 :root 变量，还带一段 @layer base
// （html / body / :focus-visible）。摊平会让这三条变成**无层规则**，而 Tailwind 4 的
// utility 在原生 @layer 里 —— 无层永远赢（与特异度无关）。实测 docs.autional.cn：
// body 的计算色被 tokens 抢走（.text-neutral-900 失效），`focus-visible:outline-none`
// 探针的 outline-style 仍为 solid，DESIGN.md 的焦点环逃生口失效。因此 tokens.css
// **保留 @layer base 原样托管**；带层后它与 preflight 的先后只影响同值规则
// （同为 Inter 字体栈、同为 margin 0），不产生视觉差。profile 是纯 :root 变量，
// 摊平与否等价，继续摊平。
function flattenLayers(css) {
  const re = /@layer\s+[a-zA-Z0-9_,\s-]+\s*\{/;
  let out = css;
  for (let guard = 0; guard < 16; guard++) {
    const m = re.exec(out);
    if (!m) break;
    const start = m.index;
    const open = start + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(open + 1, end) + out.slice(end + 1);
  }
  return out;
}

// ── 生成 site.webmanifest（工厂函数：BASE 要等指纹算完才知道，所以推迟到这里）─────
// 不从 favicon_io 直接拷：那份用的是相对路径，放到 CDN 上就成了死链。
// 这里按 CDN 绝对路径重新生成。
//
// **刻意不写 theme_color。** 它是一个**每站不同**的值：DESIGN.md §13 规定
// 「theme_color 必须等于 PWA chrome 所在的表面色」——品牌面 #003153、浅色内容站 #ffffff、
// authenticator（暗色优先）#0a0a0a。一份 14 站共用的文件不可能同时正确，
// 而写死其中一个就是对另外三个站说谎。实测踩过：把 <link rel="manifest"> 指向 CDN 之后，
// authenticator 的页面 meta 是 #0a0a0a、manifest 却是 #003153 —— 同一个值两个来源且互相矛盾。
// 正确分层：**共享文件只放共享字段**，theme_color 的唯一来源是各站 <head> 的
// <meta name="theme-color">（其值登记在 verification/consumer-targets.json，
// 由 check-icons I11 断言一致）。
const R = resolvedIn(T, {});
const bg = R['color.neutral-0'] || '#ffffff';
const buildWebmanifest = () => ({
  name: 'Autional',
  short_name: 'Autional',
  icons: [
    { src: ABS + '/icons/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: ABS + '/icons/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }
  ],
  background_color: bg,
  display: 'standalone'
});

// ── 构建（先写进暂存目录，算完指纹再改名到最终版本目录）──────────────────────
const entries = [];
const missing = [];

// manifest 里的 sha384 是对**即将被托管的精确字节**计算的，所以必须先确定字节，再算哈希。
// 这一步不是洁癖，是踩过的坑：ui/assets/ 下的 SVG 是 CRLF，本脚本原样拷过来并按 CRLF 算哈希，
// 而 git（core.autocrlf）与 Vercel 侧都是 LF —— 结果 22 个文件里 10 个 SVG 的 SRI 全部失配，
// 且失配是**静默**的：只有主动下载回来自校验才会发现。
// 因此文本产物在这里统一归一化为 LF，让产物与平台、与 git 配置解耦。
const TEXT_EXT = new Set(['.css', '.json', '.svg', '.txt', '.webmanifest', '.html', '.map', '.js', '.mjs', '.ts']);

function emit(srcRel, destRel, transform) {
  const src = join(ROOT, srcRel);
  if (!existsSync(src)) { missing.push(srcRel); return; }
  const dest = join(STAGE, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  const ext = destRel.slice(destRel.lastIndexOf('.'));
  let buf;
  if (transform) {
    buf = Buffer.from(transform(readFileSync(src, 'utf8')), 'utf8');
  } else if (TEXT_EXT.has(ext)) {
    buf = Buffer.from(readFileSync(src, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  } else {
    buf = readFileSync(src);
  }
  writeFileSync(dest, buf);
  entries.push({
    destRel: destRel.split('\\').join('/'),
    bytes: buf.length,
    sha384: 'sha384-' + createHash('sha384').update(buf).digest('base64')
  });
}

// 自我断言：摊平必须真的发生。第一版把正则在字符串里多转义了一层，写进文件的是匹配
// 字面反斜杠的 /@layer\\s+/，于是什么都没摊平——而 check-cdn 仍然全绿，
// 因为 manifest 与产物是一起生成的，闸门看不出「变换是空操作」。
// 「脚本报成功」必须等于「我要的结果发生了」，所以这里直接断言。
function emitCss(srcRel, destRel) {
  const src = join(ROOT, srcRel);
  if (!existsSync(src)) { missing.push(srcRel); return; }
  const raw = readFileSync(src, 'utf8');
  const flat = flattenLayers(raw);
  if (/@layer/.test(raw) && /@layer/.test(flat)) {
    console.error('摊平失败：' + srcRel + ' 仍含 @layer —— 变换没生效，拒绝产出语义不同的样式表');
    process.exit(1);
  }
  emit(srcRel, destRel, () => flat);
}
// tokens.css 保留 @layer base（见上方说明）：emit 原样产出，其余 CSS 继续摊平。
const KEEP_LAYERS = new Set(['packages/tokens/tokens.css']);
for (const [s, d] of CSS) {
  if (KEEP_LAYERS.has(s)) emit(s, d);
  else emitCss(s, d);
}
for (const [s, d] of PROFILES) emitCss(s, d);
for (const [s, d] of FONTS) emit(s, d);
for (const [s, d] of ICONS) emit(s, d);
for (const [s, d] of LOGOS) emit(s, d);
// icons/site.webmanifest 刻意放在指纹之后 emit —— 它内含 BASE，先算指纹就会循环。

if (missing.length) {
  console.error('缺少源文件，构建中止（宁可失败也不发一份不完整的资产包）：');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}

// ── 定版本：内容指纹 → 版本目录名 ───────────────────────────────────────────
const fingerprint = (list) => createHash('sha256')
  .update(list.map((e) => e.destRel + '\u0000' + e.sha384).sort().join('\n'))
  .digest('hex').slice(0, 8);

const FP = fingerprint(entries);
VERSION = VERSION_BASE + '.' + FP;
BASE = '/ui/v' + VERSION;
DEST = join(OUT, 'ui', 'v' + VERSION);
ABS = CDN_ORIGIN + BASE;

// site.webmanifest 此时才能生成（ABS 已知）
emit('assets/favicon_io/site.webmanifest', 'icons/site.webmanifest', () => JSON.stringify(buildWebmanifest(), null, 2) + '\n');
if (missing.length) {
  console.error('site.webmanifest 生成失败，构建中止：' + missing.join(', '));
  process.exit(1);
}

// ── 落盘：同名目录只可能是同一份内容，直接替换；旧版本目录**保留**（有上限）──────
//
// 为什么保留而不是清掉（第一版是清掉的，错了）：immutable 只保证"客户端不再回源"，
// 不保证"客户端手里的 HTML 也是新的"。一个还拿着上一版 HTML 的浏览器会去取
// /ui/v<旧版本>.<旧指纹>/tokens.css —— 目录被清掉它就是 404、页面无样式。
// 实测踩过：清掉旧目录后，本机 14 个站点的 **dist 产物**（引用旧路径）全部失效，
// 字体断言、对比度、视觉回归三道闸门一起变红。
// 保留旧目录不会削弱不可变性：目录名带内容指纹，旧目录永远不可能被原地覆盖，
// 而"旧 URL 继续返回它当初承诺的字节"正是 immutable 该有的样子。
//
// 上限 KEEP 只是防无限增长（每个约 330 KB）。清单里的 generatedAt 让保留顺序是确定的，
// 不依赖文件 mtime（新 clone 出来的 mtime 都一样，排序会退化）。
const KEEP = 5;
const uiRoot = join(OUT, 'ui');
mkdirSync(uiRoot, { recursive: true });
const removed = [];
const kept = [];
for (const name of readdirSync(uiRoot)) {
  if (!name.startsWith('v')) continue;
  const p = join(uiRoot, name);
  const mf = join(p, 'manifest.json');
  if (existsSync(mf) === false) { rmSync(p, { recursive: true, force: true }); removed.push(name + '(无清单，不完整)'); continue; }
  const fpOk = /^v.+.[0-9a-f]{8}$/.test(name);
  if (!fpOk) { rmSync(p, { recursive: true, force: true }); removed.push(name + '(名字无内容指纹，无法自称 immutable)'); continue; }
  let at = '';
  try { at = JSON.parse(readFileSync(mf, 'utf8')).generatedAt || ''; } catch {}
  kept.push({ name, at });
}
kept.sort((a, b) => (a.at < b.at ? 1 : -1));           // 新的在前
// ⚠️ 预算是「本次构建后总数 ≤ KEEP」，不是写死的 **KEEP - 1**：`kept` 只含**盘上已有**的目录 ——
// 新增时（同名目录不在盘上）新目录还没落盘，裁到 KEEP-1；而内容未变时（同名目录已在盘上）
// 本次**不新增**，仍按 KEEP-1 裁就会白删一个有效旧目录。第 63 轮实测：无变化的 build:cdn 把最旧一档
// （25 个文件）删掉，git 里出现删除 —— release.yml 的「无变化就跳过提交」守卫随之失效，这批删除
// 会被自动提交推上 cdn main；而被删的正是「路径不可变」要留给旧 HTML 的兜底目录。
// （第 62 轮实测的是同一条预算的另一头：新增时写成 KEEP 会「保留 5 + 新增 1」= 6，撞 check-cdn 上限。）
// 保留策略由闸门定义、构建脚本服从；反过来（改闸门去迁就脚本）就是把政策改小。
const willAdd = !existsSync(DEST);
const excess = Math.max(0, kept.length + (willAdd ? 1 : 0) - KEEP);
for (const old of kept.slice(kept.length - excess)) {
  if (old.name === 'v' + VERSION) continue;
  rmSync(join(uiRoot, old.name), { recursive: true, force: true });
  removed.push(old.name + '(超出保留上限 ' + KEEP + ')');
}
// 自证：对着**盘面**断言「本次构建后总数 ≤ KEEP」。第 62/63 两轮实测是同一个静默漂移的两端
// （脚本打印「保留 5 个」而实际 6 个 / 打印「保留 5 个」而盘上剩 4 个，两次脚本都绿着）——
// 「脚本报成功」必须等于「政策真的成立」，所以这里不打印预算、直接数。
{
  const after = readdirSync(uiRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('v')).length;
  if (after + (willAdd ? 1 : 0) > KEEP) {
    console.error('保留策略自证失败：裁剪后盘上 ' + after + ' 个版本目录' + (willAdd ? ' + 本次新增 1 个' : '') + '，超出上限 ' + KEEP + ' —— 预算算错了，拒绝按错的结果继续落盘');
    process.exit(1);
  }
}
// 清单必须在**决定是否落盘之前**写好，并放进暂存目录。
// 原因：指纹未变时整份产物（含 manifest.json）都不该被重写 ——
// 之前 manifest 是在落盘之后写的，于是「内容没变也重写一次」，
// cdn 仓会出现一个只有 generatedAt 的 diff（实测踩到：改一个**不在 CDN 上**的文件、
// 重跑一次 build:cdn，cdn 仓就脏了），release.yml 的「无变化就跳过提交」守卫也永远失效。
for (const e of entries) e.path = BASE + '/' + e.destRel;
entries.sort((a, b) => (a.path < b.path ? -1 : 1));
const manifest = {
  $note: 'CDN 资产清单。sha384 用于 <link>/<script> 的 integrity 属性与 SRI 校验。路径一律不可变：内容变了必须换版本号。',
  // 保留顺序的依据（旧版本目录按此排序裁剪）。**刻意不在内容指纹的输入里** ——
  // 它在 manifest.json 内，而 manifest.json 已因含 BASE 被排除，加了它就会循环。
  generatedAt: new Date().toISOString(),
  version: VERSION,
  base: BASE,
  origin: CDN_ORIGIN,
  generatedFrom: 'autional/ui',
  files: entries
};
writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (existsSync(DEST)) {
  // 目录名带内容指纹 ⇒ 同名必然同内容 ⇒ 逐字节相同 ⇒ **整份丢弃暂存，不动现有目录**。
  // generatedAt 因此记录的是「这份内容第一次出现的时间」，而不是最后一次构建时间 ——
  // 这正是保留排序想要的语义。
  rmSync(STAGE, { recursive: true, force: true });
  console.log('  内容未变（指纹 ' + FP + ' 相同），保留现有版本目录，不重写任何一个字节');
} else {
  renameSync(STAGE, DEST);
}
if (removed.length) console.log('  移除版本目录：' + removed.join(', '));
console.log('  保留版本目录：' + [('v' + VERSION)].concat(kept.filter((k) => k.name !== 'v' + VERSION).slice(0, KEEP - 1).map((k) => k.name)).join(', '));

mkdirSync(join(OUT, 'ui'), { recursive: true });
writeFileSync(join(OUT, 'ui', 'latest.json'), JSON.stringify({
  $note: '当前版本指针。TTL 短（300s），因为它是可变的；所有 v<version>/ 下的路径才是不可变的。',
  version: VERSION,
  base: BASE
}, null, 2) + '\n');

// ── 人可读的目录页 ──────────────────────────────────────────────────────────
// cdn.autional.cn 的裸根应该是一个能用的落点，而不是 404 或文件列表。
// 它同时是 Go 服务 demo 与各类「非 Node 构建」消费方的接入说明。
const rows = entries.map((e) => {
  const rel = e.path.replace(BASE + '/', '');
  return '<tr><td><a href="' + e.path + '">' + rel + '</a></td><td class="n">' + e.bytes +
         '</td><td class="h">' + e.sha384.slice(0, 22) + '…</td></tr>';
}).join('\n');

const SNIPPETS = [
  ['预编译令牌 CSS（Go demo / 任何非 Node 构建的消费方）',
   '<link rel="stylesheet" href="' + ABS + '/tokens.css">'],
  ['字体：**不要 preload**。tokens.css 里的 @font-face 已经引用它，浏览器自己会取。',
   '/* 实测（2026-09）：给 9 个 SPA 站点加这条 preload 后，admin-console 的视觉回归从\n' +
   '   基线 1063px / 0.082% 变成 5412px / 0.418%（SSIM 0.9791），重跑三次逐位相同——\n' +
   '   是确定性差异，不是网络抖动。它换不来可证明的收益，所以不写进接入片段。 */'],
  ['站点图标套件（5 条 link，含 32x32 与 apple-touch）',
   '<link rel="icon" href="' + ABS + '/icons/favicon.ico" sizes="any">\n' +
   '<link rel="icon" type="image/png" sizes="32x32" href="' + ABS + '/icons/favicon-32x32.png">\n' +
   '<link rel="icon" type="image/png" sizes="16x16" href="' + ABS + '/icons/favicon-16x16.png">\n' +
   '<link rel="apple-touch-icon" sizes="180x180" href="' + ABS + '/icons/apple-touch-icon.png">\n' +
   '<link rel="icon" type="image/svg+xml" href="' + ABS + '/icons/favicon.svg">\n' +
   '<link rel="manifest" href="' + ABS + '/icons/site.webmanifest">'],
  ['构建期代码（Node / Vite / Astro）—— 走 npm，不要走 CDN',
   'pnpm add @autional/tokens @autional/tailwind-preset\n' +
   "import '@autional/tokens/tokens.css'"]
];
const snippetHtml = SNIPPETS.map(([t, code]) =>
  '<h3>' + t + '</h3><pre><code>' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></pre>').join('\n');

const html = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  // noindex 须由生成器承载（e47e864 语义）—— 缺这行 build:cdn 回写目录页时会静默抹掉
  '<meta name="robots" content="noindex, nofollow">',
  '<title>Autional CDN — 设计系统运行期资产</title>',
  '<style>',
  'body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1e293b}',
  'h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:6px}',
  'h3{font-size:14px;margin:18px 0 6px;color:#334155}',
  'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}',
  'pre{background:#f7fafd;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;overflow-x:auto}',
  'table{border-collapse:collapse;width:100%;font-size:13px}',
  'th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #eef2f6}',
  '.n,.h{text-align:right;color:#64748b;font-family:ui-monospace,monospace;font-size:12px}',
  'a{color:#004565}',
  '.warn{background:#fffcf0;border:1px solid #ffefb3;border-radius:6px;padding:10px 12px;margin:16px 0}',
  '</style></head><body>',
  '<h1>Autional CDN</h1>',
  '<p>设计系统的<strong>运行期资产</strong>。构建期代码（令牌 JS、Tailwind preset、antd 主题桥、React 组件）请走 npm，不要走这里。</p>',
  '<div class="warn"><strong>路径不可变。</strong>内容一旦变化就换版本号——<code>' + BASE + '/</code> 下的文件永久缓存，不保证会被刷新。需要跟随最新版时读 <a href="/ui/latest.json"><code>/ui/latest.json</code></a>（短 TTL）。</div>',
  '<p>当前版本 <strong>' + VERSION + '</strong> · 共 ' + entries.length + ' 个文件</p>',
  '<h2>接入片段</h2>',
  snippetHtml,
  '<h2>清单</h2>',
  '<p><a href="' + ABS + '/manifest.json">manifest.json</a> — 每个文件的字节数与 sha384，可用于 SRI 与完整性校验。</p>',
  '<table><thead><tr><th>路径</th><th class="n">字节</th><th class="h">sha384</th></tr></thead><tbody>',
  rows,
  '</tbody></table>',
  '<p style="margin-top:32px;color:#8896a6;font-size:12px">由 <code>autional/ui</code> 的 <code>scripts/build-cdn.mjs</code> 生成，请勿手工编辑。</p>',
  '</body></html>'
].join('\n') + '\n';
writeFileSync(join(OUT, 'index.html'), html);

const total = entries.reduce((n, e) => n + e.bytes, 0);
console.log('CDN 构建完成');
console.log('  输出   ' + OUT);
console.log('  版本   ' + VERSION + '  (' + BASE + ')');
console.log('  文件   ' + entries.length + ' 个 / ' + (total / 1024).toFixed(1) + ' KB');
console.log('  入口   ' + ABS + '/tokens.css');
console.log('  字体   ' + ABS + '/fonts/inter-latin-wght-normal.woff2');
console.log('  图标   ' + ABS + '/icons/favicon.svg');
console.log('  site.webmanifest 刻意不含 theme_color（每站不同值，唯一来源是各站 <meta>，由 check-icons I11 断言）');
