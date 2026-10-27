#!/usr/bin/env node
// 图标套件闸门（verify 第 12 道）
//
// 守的是「浏览器标签页上那一眼」——用户最先看到、也最容易各站不一致的东西。
// 实测（2026-09-29）修复前的状态：
//   14 站里只有 3 站（developer/docs/web）有完整图标组；
//   8 个 SPA 站只声明 1 个 link；user 声明 0 个；authenticator 声明 0 个；
//   status 的 /favicon-32x32.png 返回的是 SPA fallback（text/html 947B）——
//   文件根本不存在，被前端路由掩盖，肉眼与普通抓取都看不出来。
//
// 断言（2026-09 轮次 42 起，运行期资产改由 cdn.autional.cn 交付）：
//   ① 每站声明 standard 图标组（>=4 个 rel=icon + apple-touch + manifest）
//   ② 这些 <link> 的 href 必须是 **CDN 的 canonical 形态**（I15），
//      且 CDN 上真有这个文件（I16）、字节与 ui/assets 的权威一致（I17）。
//      ②是这一轮换轨的核心：过去断言的是「站点 public/ 的拷贝与权威逐字节一致」，
//      而站点的 <link> 现在指向 CDN —— 拷贝再一致也不代表浏览器拿到的是那一份。
//      **闸门必须看着交付路径本身，而不是看着一个已经不被使用的副本。**
//   ③ theme-color 是**字面量**：它由浏览器消费、不经过 CSS，写 var() 等于没写
//   ④ 共享清单不得携带每站不同的字段（theme_color）：同一个值不该有两个来源（I18）
//   ⑤ 14 个站点引用的 CDN 版本必须完全相同（I19）—— 版本漂了就不是「同一个来源」
//      且必须是 **cdn/ui/latest.json 当前发布的那一版**（I24）。
//      I24 是第 63 轮真实踩出来的：14 个站**一致地**停在上一版，I19 照样绿，
//      而那一轮新增的运行期变量（color.bg-code / layout.modal-offset / layout.hero-offset）
//      只存在于新版 tokens.css 里 ⇒ 浏览器拿不到：站点上的 bg-code 是透明底、两处视口偏移是 0。
//      **「一致」不等于「当前」**——一个共同的旧来源仍然是旧来源。
//   ⑥ 样式表 <link> 同样是 CDN canonical 形态（I21），且**只能 link 位置无关的那些**（I22）、
//      必须 link tokens.css 且 profile 与 consumer-targets.json 声明一致（I23）。
//      I22 是本轮真实踩出来的：primitives.css 含 Tailwind @layer 片段，直链会让 base 段落
//      掉到 preflight 之前，实测三站整页偏移 3–4.5%，而当时所有闸门全绿。
//   ⑦ **站点名单以 consumer-targets.json 的 publicDirs 为准**（2026-10-27）。
//      过去用 readdirSync(SITES) 枚举「站点」，而工作区里还有 ui/ cdn/ armenian/ cyrillic/ 这些
//      非站点目录 ⇒ 每次全量跑都稳定产出 4 条 I0 假红。一个永远带 ERROR 的闸门，
//      真红就会被当成噪音跳过。声明了但目录不存在才是真问题（I0）。
//   ⑧ manifest 有**两种合法交付方式**（I26–I28）。4 个 PWA 站（auth / authenticator / brand / status）
//      的 manifest 由 vite-plugin-pwa 在构建期生成 manifest.webmanifest 并注入 <link>：
//      源 HTML 里没有 <link rel="manifest">、public/ 里也没有回滚副本 —— I4/I8 对它们问的是错问题。
//      但「插件负责」不等于「不用验」：闸门改为断言插件配置里真有图标、真有 theme_color，
//      且图标文件真的在 public/（I28）。**换一条交付路径不等于放弃断言。**
//
// 离线：CDN 侧的内容从同级 ../cdn 仓库的工作区读，不联网。
// 「CDN 能否连上」不在这里断言：网络可用性不是本项目的判据（用户已定调）。
//
// 用法: node scripts/check-icons.mjs [--json]

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
// B3 单源化：运行期资产的链接改成了 {{CDN_ASSET_BASE}} 占位符（构建期注入）。
// 扫描期还原成 canonical 基址，让 I7/I15/I20/I21/I23 这些既有规则继续管用；
// 同时新增 I25 守「占位符真的被注入了」（没注入 = 把字面量发给浏览器，比写死旧版本更糟）。
import { expandPlaceholders, injectionProblems } from './lib/cdn-refs.mjs';
import { createHash } from 'node:crypto';
import { ROOT, loadTokens, resolvedIn } from './lib/tokens.mjs';
import { makeSkip } from './lib/scan-scope.mjs';

const AS_JSON = process.argv.includes('--json');
const SITES = process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
const CONFIG = join(ROOT, 'verification', 'consumer-targets.json');

const REQUIRED_ICON = 4;   // ico + 32 + 16 + svg
// 运行期资产的 CDN 落点（同级仓库）。只读文件系统，不联网。
const CDN_DIR = process.env.AUTIONAL_CDN_DIR || resolve(ROOT, '..', 'cdn');
const CDN_URL_RE = /^https:\/\/cdn\.autional\.cn\/ui\/(v[^/]+)\/(icons\/([^/?#]+))\s*$/;
const problems = [];
const warns = [];
const info = [];
const rows = [];
const cdnVersions = new Map();   // version -> [site]

if (!existsSync(SITES)) {
  console.log('check-icons：本次工作区没有 sites/，跳过（CI 里同样跳过）');
  process.exit(0);
}

const CT = JSON.parse(readFileSync(CONFIG, 'utf8'));
const publicDirs = CT.publicDirs || {};
const RUNTIME_SHEETS = Object.fromEntries(Object.entries(CT.runtimeSheets || {}).filter(([k]) => k[0] !== '$'));
const PROFILE_BY_SITE = {};
for (const b of (CT.profiles || [])) if (b.site) PROFILE_BY_SITE[b.site] = b.profile || null;
const THEME_COLORS = CT.themeColors || {};
// manifest 交付方式。未登记的站点 = static（页面 <head> 里显式 <link>，指向 CDN 的共享清单）。
const MANIFEST_DECL = Object.fromEntries(Object.entries(CT.manifests || {}).filter(([k]) => k[0] !== '$'));
const ICON_SOURCES = (CT.iconSources || {}).files || [];
// 与 sync-consumers 用同一份声明，这样「theme-color 的唯一来源」是 consumer-targets.json，
// 而不是散在 14 个站点的 HTML 里。页面 <meta> 是手写的，由本闸门断言它与声明一致。
const RES = resolvedIn(loadTokens(), {});
const declaredThemeColor = (site) => {
  const raw = THEME_COLORS[site] || THEME_COLORS.default || null;
  if (!raw) return null;
  const m = /^\{([^}]+)\}$/.exec(raw);
  return m ? (RES[m[1]] || null) : raw;
};
// ── PWA 站的 manifest：插件生成，但断言不降级（I26–I28）────────────────────────
// 配置是 TS，不执行它 —— 只读文本：找 VitePWA(...) 的 manifest 对象，断言三件事：
//   ① 真有 manifest 块（没有就不会注入 <link rel="manifest">）；
//   ② theme_color 与 consumer-targets.json 声明的一致（安装后标题栏就是它，装前是 <meta> —— 两个来源必须同值）；
//   ③ 图标文件真的在 public/（src 可能是 `${BASE}android-chrome-192x192.png`，取 basename 判存在）。
// ③ 不是形式主义：status 的 /favicon-32x32.png 曾经实际返回 SPA fallback 的 text/html，肉眼看不出来。
function manifestObject(src) {
  const at = src.search(/\bmanifest\s*:\s*\{/);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

function checkPwaManifest(site, dir, decl, pubDir, pubRel, declared) {
  const relCfg = decl.config || '';
  const cfgPath = join(dir, relCfg);
  if (!relCfg || !existsSync(cfgPath)) {
    problems.push('I26 ' + site + '：consumer-targets.json 声明本站的 manifest 由 vite-plugin-pwa 交付，但配置 ' +
      (relCfg || '（未填 config）') + ' 不存在 —— 清单没有交付方，安装入口会 404');
    return;
  }
  const src = readFileSync(cfgPath, 'utf8');
  if (!/VitePWA\s*\(/.test(src)) {
    problems.push('I26 ' + site + '：' + relCfg + ' 里没有 VitePWA(...) —— 声明了插件交付但插件不在，产物不会有 <link rel="manifest">');
    return;
  }
  const block = manifestObject(src);
  if (!block) {
    problems.push('I26 ' + site + '：' + relCfg + ' 的 VitePWA(...) 里没有 manifest: { ... } —— 插件不会生成清单');
    return;
  }
  const tc = (block.match(/theme_color\s*:\s*['"]([^'"]+)['"]/) || [])[1] || null;
  if (!tc) problems.push('I27 ' + site + '：PWA manifest 没有 theme_color —— 安装后标题栏回落到浏览器默认色（页面 meta 是 ' + (declared || '（未声明）') + '）');
  else if (declared && tc !== declared) problems.push('I27 ' + site + '：PWA manifest 的 theme_color=' + tc + ' 与 consumer-targets.json 声明的 ' + declared + ' 不一致 —— 安装前后的标题栏会是两种颜色');
  const sizes = [...block.matchAll(/sizes\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const need of ['192x192', '512x512']) {
    if (!sizes.includes(need)) problems.push('I28 ' + site + '：PWA manifest 缺 ' + need + ' 图标（安卓安装必需）');
  }
  const srcs = [...block.matchAll(/\bsrc\s*:\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]);
  for (const s of srcs) {
    const base = s.split('/').pop().replace(/\$\{[^}]*\}/g, '');
    if (!base) continue;
    if (!existsSync(join(pubDir, base))) problems.push('I28 ' + site + '：manifest 图标 ' + s + ' 对应的 ' + base + ' 不在 ' + pubRel + '/ —— 安装时会拿到 404');
  }
}

const SKIPDIR = makeSkip('public');
function walk(d, out, depth) {
  if (depth > 4) return out;
  let es; try { es = readdirSync(d, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    if (SKIPDIR.has(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (['.astro', '.html'].includes(extname(e.name))) out.push(p);
  }
  return out;
}

// 站点名单的唯一出处 = consumer-targets.json 的 publicDirs：**声明的才算站点**。
// 用 readdirSync 枚举的后果（2026-10-27 实测）：工作区里还有 ui/ cdn/ armenian/ cyrillic/，
// 每次全量跑都稳定产出 4 条 I0 假红 —— 一个永远带 ERROR 的闸门，真红就会被当成噪音。
const DECLARED = Object.keys(publicDirs).filter((k) => k[0] !== '$').sort();
const PRESENT = readdirSync(SITES).filter((n) => { try { return statSync(join(SITES, n)).isDirectory(); } catch (e) { return false; } });
const IGNORED = PRESENT.filter((n) => DECLARED.indexOf(n) < 0).sort();
if (IGNORED.length) warns.push('未登记、按非站点跳过：' + IGNORED.join(', ') + '（要纳入检查就登记到 consumer-targets.json 的 publicDirs）');

for (const site of DECLARED) {
  if (PRESENT.indexOf(site) < 0) { problems.push('I0 ' + site + '：consumer-targets.json 的 publicDirs 登记了该站点，但目录不存在（' + join(SITES, site) + '）'); continue; }
  const dir = join(SITES, site);
  const pubRel = publicDirs[site];
  const pubDir = join(dir, pubRel);

  // 找声明图标的 head 文件
  const candidates = walk(dir, [], 0).filter((f) => /rel=["']?(?:shortcut )?icon["']?/i.test(readFileSync(f, 'utf8')));
  if (!candidates.length) { problems.push('I1 ' + site + '：没有任何文件声明 rel="icon"'); continue; }
  const headFile = candidates[0];
  const rawHead = readFileSync(headFile, 'utf8');
  const text = expandPlaceholders(rawHead, join(SITES, site)).text;
  const rel = relative(SITES, headFile).replace(/\\/g, '/');
  for (const p of injectionProblems(site, join(SITES, site), candidates)) problems.push(p);

  const icons = [...text.matchAll(/<link\b[^>]*\brel=["']?(?:shortcut )?icon["']?[^>]*>/gi)].map((m) => m[0]);
  const apple = /rel=["']?apple-touch-icon["']?/i.test(text);
  const manifest = /rel=["']?manifest["']?/i.test(text);
  // manifest 的交付方式：static（默认，<head> 显式 <link>）或 vite-plugin-pwa（构建期生成并注入）。
  const pwa = MANIFEST_DECL[site] && MANIFEST_DECL[site].delivery === 'vite-plugin-pwa' ? MANIFEST_DECL[site] : null;
  const tcMatch = text.match(/<meta\s+name=["']theme-color["'][^>]*content=["']([^"']*)["']/i);
  const tc = tcMatch ? tcMatch[1] : null;

  if (icons.length < REQUIRED_ICON) problems.push('I2 ' + site + '：只声明了 ' + icons.length + ' 个 rel="icon"，应有 >= ' + REQUIRED_ICON + '（' + rel + '）');
  if (!apple) problems.push('I3 ' + site + '：没有 apple-touch-icon（' + rel + '）');
  if (!manifest && !pwa) problems.push('I4 ' + site + '：没有 manifest 链接（' + rel + '）');
  if (!tc) problems.push('I5 ' + site + '：没有 theme-color（' + rel + '）');
  else if (/var\(/.test(tc)) problems.push('I6 ' + site + '：theme-color 是 var()（' + tc + '）——该值由浏览器消费、不经过 CSS，写 var() 等于没写');

  // 图标 / apple-touch / manifest 的 href
  const hrefs = [...text.matchAll(/<link\b[^>]*\brel=["']?(?:shortcut )?icon["']?[^>]*\bhref=["']([^"']+)["']/gi)]
    .concat([...text.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']?(?:shortcut )?icon["']?/gi)])
    .map((m) => m[1]);
  const appleHref = (text.match(/<link\b[^>]*rel=["']?apple-touch-icon["']?[^>]*href=["']([^"']+)["']/i) || [])[1];
  if (appleHref) hrefs.push(appleHref);
  const manifestHref = (text.match(/<link\b[^>]*rel=["']?manifest["']?[^>]*href=["']([^"']+)["']/i) || [])[1]
                    || (text.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']?manifest["']?/i) || [])[1];
  if (manifestHref) hrefs.push(manifestHref);

  // 两类来源分开处理：CDN 的现交付路径，与 public/ 的回滚副本。
  const missingFiles = [];
  const cdnRefs = [];
  for (const h of new Set(hrefs)) {
    const isExternal = /^https?:/i.test(h);
    if (isExternal) {
      const m = CDN_URL_RE.exec(h);
      if (!m) { problems.push('I15 ' + site + '：图标类 <link> 指向了非 canonical 的外部地址 ' + h +
        ' —— 运行期资产必须来自 https://cdn.autional.cn/ui/<版本>/icons/<文件>（' + rel + '）'); continue; }
      cdnRefs.push({ href: h, version: m[1], rel: m[2], name: m[3] });
      continue;
    }
    const clean = h.split('?')[0].split('#')[0];
    if (!clean.startsWith('/')) { missingFiles.push(h + '(非绝对路径)'); continue; }
    if (!existsSync(join(pubDir, clean.slice(1)))) missingFiles.push(h);
  }
  if (missingFiles.length) problems.push('I7 ' + site + '：引用的文件在 ' + pubRel + '/ 里不存在 → ' + missingFiles.join(', ') + '（浏览器会拿到 SPA fallback 的 text/html，肉眼看不出来）');

  // ── I16/I17 CDN 侧真的有、且与权威逐字节一致 ──────────────────────────────
  // 只断言 URL 形态等于什么都没断言：URL 可以写得完全正确而没有对应文件，
  // 也可以有一个内容已经过期的文件。所以要把 CDN 工作区里的字节也读出来比。
  if (cdnRefs.length) {
    const versions = new Set(cdnRefs.map((r) => r.version));
    for (const v of versions) {
      if (!cdnVersions.has(v)) cdnVersions.set(v, []);
      cdnVersions.get(v).push(site);
    }
    for (const r of cdnRefs) {
      const onDisk = join(CDN_DIR, 'ui', r.version, r.rel);
      if (!existsSync(onDisk)) {
        problems.push('I16 ' + site + '：' + r.href + ' 在 CDN 产物里不存在（' +
          join('cdn', 'ui', r.version, r.rel).replace(/\\/g, '/') + '）—— 浏览器会拿到 404' +
          (existsSync(CDN_DIR) ? '' : '；CDN 工作区 ' + CDN_DIR + ' 也不存在'));
        continue;
      }
      const src = ICON_SOURCES.find((s) => s.to === r.name);
      if (!src) continue;                       // site.webmanifest 是生成物，没有 ui/assets 对应源
      const authPath = join(ROOT, src.from);
      if (!existsSync(authPath)) continue;      // 权威缺失已由 I12 报出
      const a = createHash('sha256').update(readFileSync(authPath)).digest('hex').slice(0, 12);
      const b = createHash('sha256').update(readFileSync(onDisk)).digest('hex').slice(0, 12);
      if (a !== b) problems.push('I17 ' + site + '：CDN 上的 ' + r.name + '（' + b + '）与权威 ui/' + src.from +
        '（' + a + '）不一致 —— 浏览器取的正是 CDN 那一份，重新发布：pnpm build:cdn');
    }
  }
  // 站点仍然直连本地图标 = 没有真的换轨（回滚通道是显式动作，不该是默认形态）
  const localIconRefs = [...new Set(hrefs)].filter((h) => !/^https?:/i.test(h));
  if (localIconRefs.length) {
    problems.push('I20 ' + site + '：仍有 ' + localIconRefs.length + ' 个图标类 <link> 指向本站相对路径（' +
      localIconRefs.slice(0, 3).join(', ') + '）—— 运行期资产已改为 CDN 单一来源，' +
      pubRel + '/ 里的副本只是回滚通道。');
  }

  // 回滚副本 site.webmanifest（public/）：它不参与运行期交付，但回滚时必须自洽。
  // PWA 站例外：manifest 由 vite-plugin-pwa 构建期生成，回滚通道里没有这一项，改验插件配置（I26–I28）。
  const wmPath = join(pubDir, 'site.webmanifest');
  let wmTc = null;
  if (pwa) {
    checkPwaManifest(site, dir, pwa, pubDir, pubRel, declaredThemeColor(site));
  } else if (!existsSync(wmPath)) problems.push('I8 ' + site + '：' + pubRel + '/site.webmanifest 不存在（回滚通道需要它）');
  else {
    try { wmTc = JSON.parse(readFileSync(wmPath, 'utf8')).theme_color || null; } catch (e) { problems.push('I9 ' + site + '：site.webmanifest 不是合法 JSON'); }
    if (wmTc && tc && wmTc !== tc) problems.push('I10 ' + site + '：回滚副本 site.webmanifest 的 theme_color=' + wmTc + ' 与页面 meta 的 ' + tc + ' 不一致——同一个值不该有两个来源');
  }

  // ── I21–I23 样式表交付：令牌 / profile 走 CDN，且不得把 Tailwind 层片段当普通样式表 ──
  // I22 是这一轮真实踩出来的：primitives.css 的来源里有 @layer base/components，
  // 而 Tailwind 处理它们时会把内容**按层重新定位**（base 段落到 preflight 之后）。
  // 当成普通外部样式表从 CDN 加载时整个文件排在站点 bundle 之前，base 段落于是落到
  // preflight **之前**，preflight 的 body { line-height: inherit } 反过来盖掉
  // primitives 的 body { line-height: var(--line-height-body-md) } ——
  // 实测 developer/docs/wiki 三站整页偏移 3.0% / 3.0% / 4.5%，而所有既有闸门全绿。
  // 判据：**能否直链取决于位置无关性**，逐份登记在 consumer-targets.json 的 runtimeSheets 里；
  // 未登记的样式表一律判失败——新增一份运行期样式表时必须显式做这个判断。
  const sheetHrefs = [...text.matchAll(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=["']([^"']+)["']/gi)]
    .concat([...text.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']?stylesheet["']?/gi)])
    .map((m) => m[1]);
  const SHEET_RE = /^https:\/\/cdn\.autional\.cn\/ui\/(v[^/]+)\/((?:profiles\/)?[A-Za-z0-9._-]+\.css)$/;
  const cdnSheets = [];
  for (const h of new Set(sheetHrefs)) {
    const m = SHEET_RE.exec(h);
    if (!m) {
      problems.push('I21 ' + site + '：样式表 <link> 不是 CDN canonical 形态 → ' + h +
        ' —— 运行期资产必须来自 https://cdn.autional.cn/ui/<版本>/<文件>.css（' + rel + '）');
      continue;
    }
    cdnSheets.push({ href: h, version: m[1], rel: m[2] });
    // 逐份登记「能不能直接 link」——判据是**位置无关性**，不是「取不取得到」。
    // 未分类 = 失败：新增一份运行期样式表时必须显式做这个判断，不能默认它安全。
    const rs = RUNTIME_SHEETS[m[2]];
    if (!rs) {
      problems.push('I22 ' + site + '：' + h + ' 未在 consumer-targets.json 的 runtimeSheets 里分类 —— ' +
        '运行期样式表能否直接 <link> 取决于它是否**位置无关**（CDN 加载时整文件在站点 bundle 之前；' +
        '经 bundler 导入时 Tailwind 会把 @layer 片段按层重定位）。请显式登记。');
    } else if (!rs.linkable) {
      problems.push('I22 ' + site + '：' + h + ' 不能直接 <link> —— ' + rs.why);
    }
  }
  if (!cdnSheets.some((s) => s.rel === 'tokens.css')) {
    problems.push('I23 ' + site + '：<head> 里没有 link CDN 的 tokens.css —— 令牌（含字体 @font-face）的唯一来源就是它');
  }
  const wantProfile = PROFILE_BY_SITE[site] || null;
  const gotProfiles = cdnSheets.filter((s) => s.rel.indexOf('profiles/') === 0).map((s) => s.rel);
  if (wantProfile) {
    const want = 'profiles/' + wantProfile + '.css';
    if (gotProfiles.indexOf(want) < 0) {
      problems.push('I23 ' + site + '：consumer-targets.json 声明本站加载 ' + want + '，实际 [' + (gotProfiles.join(', ') || '无') + ']');
    }
  } else if (gotProfiles.length) {
    problems.push('I23 ' + site + '：consumer-targets.json 声明本站没有 profile（覆盖数为 0，生成器不产出文件），却加载了 ' + gotProfiles.join(', '));
  }
  for (const s of cdnSheets) {
    if (!cdnVersions.has(s.version)) cdnVersions.set(s.version, []);
    if (cdnVersions.get(s.version).indexOf(site) < 0) cdnVersions.get(s.version).push(site);
  }

  // ── I18 浏览器**真正读到**的那份清单里不得出现每站不同的值 ─────────────────
  // theme_color 在 DESIGN.md §13 里是「等于 PWA chrome 所在的表面色」，各站不同
  // （品牌面 #003153 / 浅色站 #ffffff / authenticator #0a0a0a）。
  // 一旦清单改由 14 站共用的 CDN 提供，它就只能装共享字段；写死其中一个值，
  // 就等于对另外两个站说谎，而且页面 meta 与清单会互相矛盾。实测踩过。
  let linkedTc = null;
  let linkedManifestPath = null;
  if (manifestHref) {
    const cm = CDN_URL_RE.exec(manifestHref);
    if (cm) linkedManifestPath = join(CDN_DIR, 'ui', cm[1], cm[2]);
    else if (!/^https?:/i.test(manifestHref)) linkedManifestPath = join(pubDir, manifestHref.split('?')[0].split('#')[0].replace(/^\//, ''));
  }
  if (linkedManifestPath && existsSync(linkedManifestPath)) {
    try { linkedTc = JSON.parse(readFileSync(linkedManifestPath, 'utf8')).theme_color || null; } catch (e) { /* I16 已覆盖不存在的情况 */ }
    if (linkedTc) {
      problems.push('I18 ' + site + '：共享的 site.webmanifest 声明了 theme_color=' + linkedTc +
        ' —— 它是**每站不同**的值，只能由各站 <meta name="theme-color">（当前 ' + tc + '）承担；' +
        '一份 14 站共用的文件写死其中一个就是对其他的说谎。见 DESIGN.md §13。');
    }
  }

  const declared = declaredThemeColor(site);
  if (declared && tc && tc !== declared) {
    problems.push('I11 ' + site + '：页面 theme-color=' + tc + ' 与 consumer-targets.json 声明的 ' + declared + ' 不一致——theme-color 只能有一个来源');
  }
  // I12–I14 回滚通道副本的逐字节漂移校验：站点 public/ 里的图标必须与 ui/assets 权威一致。
  // 这一条**不**再代表运行期交付（那是 I16/I17 的事）——它守的是「回滚通道随时可用且不漂移」。
  // 实测教训：把交付路径换掉之后，只看着旧副本的闸门会**照样全绿**，
  // 而浏览器早就拿到别的东西了。所以 I16/I17 与这里是两条独立的断言，缺一不可。
  for (const s of ICON_SOURCES) {
    const authPath = join(ROOT, s.from);
    const copyPath = join(pubDir, s.to);
    if (!existsSync(authPath)) { problems.push('I12 ' + site + '：权威图标不存在 ' + s.from); continue; }
    if (!existsSync(copyPath)) { problems.push('I13 ' + site + '：' + s.to + ' 未下发到 ' + pubRel + '/'); continue; }
    const a = createHash('sha256').update(readFileSync(authPath)).digest('hex').slice(0, 12);
    const b = createHash('sha256').update(readFileSync(copyPath)).digest('hex').slice(0, 12);
    if (a !== b) problems.push('I14 ' + site + '：回滚副本 ' + s.to + ' 与权威不一致（' + b + ' != ' + a + '）——重新生成：pnpm sync:consumers --rollback-vendor --write');
  }

  rows.push({
    site, icons: icons.length, apple, manifest: manifest || !!pwa, manifestDelivery: pwa ? 'vite-plugin-pwa' : 'static',
    themeColor: tc, manifestThemeColor: wmTc, declared, head: rel,
    cdnVersion: cdnRefs.length ? [...new Set(cdnRefs.map((r) => r.version))].join(',') : null,
    cdnRefs: cdnRefs.length, linkedThemeColor: linkedTc
  });
}

// ── I19 全舰队必须引用**同一个** CDN 版本 ──────────────────────────────────
// 「单一来源」的前提是 14 个站指向同一份。分成两个版本就退化成两个来源，
// 而它们看起来都对——这类漂移不会自己暴露。
if (cdnVersions.size > 1) {
  problems.push('I19 站点引用的 CDN 版本不止一个：' +
    [...cdnVersions.entries()].map(([v, s]) => v + '（' + s.join('/') + '）').join(' | ') +
    ' —— 版本不一致等于又多了一个来源，逐站查 <head> 里的 stylesheet/icons link。');
} else if (cdnVersions.size === 1) {
  const [v] = [...cdnVersions.keys()];
  info.push('I19 全部 ' + rows.length + ' 个站点引用同一个 CDN 版本 ' + v);
}

// ── I24 引用的必须是 cdn/ui/latest.json 当前那一版 ─────────────────────────
// I19 挡的是「站与站之间漂移」，挡不住「14 个站一致地停在上一版」——第 63 轮实测：
// 那一轮发了新的 ui/v<版本>（tokens rc.15 新增 color.bg-code / layout.modal-offset /
// layout.hero-offset），而 14 个站的 <head> 全部还指向前一版，I19 报的是「版本一致 ✅」。
// 后果不是 404，而是**静默的失效**：那几个变量只存在于新版 tokens.css，
// 浏览器拿不到 ⇒ .bg-code 变透明底（文字是 text-syntax-plain 的近白色）、
// pt-[var(--layout-modal-offset)] / mt-[var(--layout-hero-offset)] 算成 0。
// 判据：**「一致」不等于「当前」**。修法就是配套工具：node scripts/bump-cdn-version.mjs --write。
const LATEST_PATH = join(CDN_DIR, 'ui', 'latest.json');
if (cdnVersions.size === 1) {
  const [refV] = [...cdnVersions.keys()];
  if (!existsSync(LATEST_PATH)) {
    problems.push('I24 找不到 ' + LATEST_PATH + ' —— 无法判定站点引用的是不是当前发布版本' +
      '（先 node scripts/build-cdn.mjs 生成 latest.json）。');
  } else {
    let latestV = null;
    try { latestV = JSON.parse(readFileSync(LATEST_PATH, 'utf8')).version || null; }
    catch (e) { problems.push('I24 ' + LATEST_PATH + ' 不是合法 JSON'); }
    if (latestV) {
      const norm = (s) => String(s).replace(/^v/, '');
      const sites = cdnVersions.get(refV);
      if (norm(refV) !== norm(latestV)) {
        problems.push('I24 站点引用的 CDN 版本 ' + refV + ' **不是当前发布的那一版** ' + latestV +
          '（' + sites.length + ' 个站：' + sites.join('/') + '）—— 这一次发布新增/改动的运行期变量' +
          '在浏览器里根本不存在，而 URL 全都 200、所有闸门都会绿。' +
          '修法：node scripts/bump-cdn-version.mjs --write 后逐站提交。');
      } else {
        info.push('I24 全部站点引用的就是当前发布版本 ' + latestV);
      }
    }
  }
}

if (AS_JSON) console.log(JSON.stringify({ rows, problems, warns, info }, null, 2));
else {
  console.log('运行期资产交付闸门（图标 / 清单）：' + rows.length + ' 个站点');
  console.log('');
  console.log('  站点'.padEnd(17) + 'icon  apple  manifest  走CDN  CDN版本        theme-color');
  for (const r of rows) {
    console.log('  ' + r.site.padEnd(15) + String(r.icons).padStart(4) + String(r.apple ? 'Y' : 'N').padStart(7) +
      String(r.manifest ? 'Y' : 'N').padStart(10) + String(r.cdnRefs + '/6').padStart(7) + '  ' +
      String(r.cdnVersion || '（无）').padEnd(13) + String(r.themeColor || '（无）'));
  }
  console.log('');
  const pwaSites = rows.filter((r) => r.manifestDelivery === 'vite-plugin-pwa').map((r) => r.site);
  if (pwaSites.length) info.unshift('manifest 由 vite-plugin-pwa 构建期生成（I26–I28 验插件配置）：' + pwaSites.join('/'));
  for (const i of info) console.log('  [INFO ] ' + i);
  for (const w of warns) console.log('  [WARN ] ' + w);
  for (const p of problems) console.log('  [ERROR] ' + p);
  console.log(problems.length ? '结论：运行期资产交付有 ' + problems.length + ' 项不达标' : '结论：运行期资产交付一致（' + rows.length + ' 站，全部走 CDN）');
}
process.exit(problems.length ? 1 : 0);
