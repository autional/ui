// cdn-refs.mjs — 运行期资产引用的「占位符/助手函数 ↔ canonical」归一化 + 注入自证（第 63 轮补·六）
//
// 背景：B3 单源化之后，**没有站点再在源码里写死 CDN 地址**，但两条线用了两种写法：
//   · SPA（9 站）：<head> 写 {{CDN_ASSET_BASE}} 占位符，由各站 vite.config.ts 构建期注入
//     （值 = scripts/env.mjs 的 readBuildEnv().cdnHost + CDN_PIN 常量）；
//   · 内容站（5 站，Astro）：<head> 写 {cdnAsset('tokens.css')}，由 src/lib/site-env.ts 的
//     cdnAsset() 拼接（同一套 CDN_HOST + CDN_PIN）。
// 于是 A4（webfont 交付链）与 I7/I15/I20/I21/I23（图标与样式表交付）当场变成假红 ——
// 它们匹配的是「写死的 canonical CDN URL」那个旧形态。
//
// 两条路：① 逐个规则放宽成「认识这两种写法」；② 扫描期把它们**还原成 canonical 基址**。
// 这里选 ②：还原之后既有规则一个字都不用改就继续成立，而放宽则是逐个规则地削弱判据。
//
// 还原用**开发兜底值**（cdn.autional.cn + 该站自己的 pin）：两区 CDN 内容逐字节一致、
// 版本指针由 I24 单独守，所以闸门不需要知道是哪个区。**声明这一点是有意的**：
// 哪天真出现「两区 CDN 不一致」，那是 I19/I24 的判据域，不该由这里猜。
//
// 归一化不能只有「放宽」：占位符**没被注入**比写死旧版本更糟 —— 它会把 {{CDN_ASSET_BASE}}
// 原样发给浏览器（一条死链）。所以配套 I25：两种写法都必须在仓里找得到它的注入方，
// 产物若已构建则不许有残余占位符。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PLACEHOLDER = '{{CDN_ASSET_BASE}}';
export const DEV_CDN_HOST = 'https://cdn.autional.cn';
export const ASSET_HELPER = 'cdnAsset';

const SKIP = new Set(['node_modules', '.git', 'dist', '.astro', 'build', 'coverage', '.artifacts']);

function walkFiles(dir, out, depth) {
  if (depth > 5) return out;
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walkFiles(p, out, depth + 1); continue; }
    out.push(p);
  }
  return out;
}

/** 声明 CDN 版本的候选文件：SPA 在 scripts/env.mjs，Astro 站（内容站）在 src/lib/site-env.ts。 */
export const PIN_FILES = [join('scripts', 'env.mjs'), join('src', 'lib', 'site-env.ts')];
/** 匹配 `export const CDN_PIN = 'v…'`（也容忍 `CDN_PIN: 'v…'` 的对象写法）。第 3 组是版本值。 */
export const PIN_RE = /(CDN_PIN\s*[:=]\s*)(['"])([^'"]+)\2/;

/** 找到站点在哪个文件里声明 pin，返回 { file, rel, value }。bump-cdn-version 用它改值。 */
export function findSitePin(siteDir) {
  for (const rel of PIN_FILES) {
    const p = join(siteDir, rel);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(PIN_RE);
    if (m) return { file: p, rel, value: m[3] };
  }
  return null;
}

/** 站点声明的 CDN 版本指纹（scripts/env.mjs 或 src/lib/site-env.ts 里的 CDN_PIN 常量）。 */
export function readSitePin(siteDir) {
  const found = findSitePin(siteDir);
  return found ? found.value : null;
}

/** 还原 {{CDN_ASSET_BASE}} 与 cdnAsset('X') → canonical 基址。返回 { text, expanded, base }。 */
export function expandPlaceholders(text, siteDir) {
  const usesPlaceholder = text.includes(PLACEHOLDER);
  const usesHelper = text.includes(ASSET_HELPER + '(');
  if (!usesPlaceholder && !usesHelper) return { text, expanded: false, base: null };
  const pin = readSitePin(siteDir);
  if (!pin) return { text, expanded: false, base: null };
  const base = DEV_CDN_HOST + '/ui/' + pin;
  let out = text.split(PLACEHOLDER).join(base);
  // Astro 属性形态 `href={cdnAsset('X')}` 有**大括号**，而闸门里那些 href 正则要求引号；
  // 所以先把它还原成带引号的字面量（否则 I23 这类规则仍然看不见 —— 实测栽过：
  // check-assets 通过之后 check-icons 的 I23 还在报"没有 link CDN 的 tokens.css"）。
  const helperCall = ASSET_HELPER + '\\(\\s*[\'"\`]([^\'"\`]+)[\'"\`]\\s*\\)';
  out = out.replace(new RegExp('\\{' + helperCall + '\\}', 'g'), (m, p) => '"' + base + '/' + p + '"');
  // 其余位置的 cdnAsset('X')（脚本里的拼接等）：还原成裸 URL
  out = out.replace(new RegExp(helperCall, 'g'), (m, p) => base + '/' + p);
  return { text: out, expanded: out !== text, base };
}

/**
 * I25：两种写法都必须真的被注入。
 *   · 用了 {{CDN_ASSET_BASE}}：仓里要有引用它的构建配置；scripts/env.mjs 要有 CDN_PIN；产物不许有残余占位符。
 *   · 用了 cdnAsset(...)：仓里要有它的定义；要有 CDN_PIN。
 * 返回问题字符串数组。
 */
export function injectionProblems(site, siteDir, headFiles) {
  const problems = [];
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch (e) { return ''; } };
  const heads = headFiles.map(read);
  const usesPlaceholder = heads.some((t) => t.includes(PLACEHOLDER));
  const usesHelper = heads.some((t) => t.includes(ASSET_HELPER + '('));
  if (!usesPlaceholder && !usesHelper) return problems;
  const files = walkFiles(siteDir, [], 0);
  const pin = readSitePin(siteDir);
  if (!pin) {
    problems.push('I25 ' + site + '：运行期资产走了占位符/助手函数，但仓里找不到 CDN_PIN 常量 —— ' +
      '注入值没有单一来源（scripts/env.mjs 或 src/lib/site-env.ts）');
  }
  if (usesPlaceholder) {
    const injector = files.find((f) => /\.(ts|tsx|mjs|js|cjs|astro)$/.test(f) && read(f).includes('CDN_ASSET_BASE'));
    if (!injector) {
      problems.push('I25 ' + site + '：<head> 用了 ' + PLACEHOLDER + '，但仓里没有任何构建配置引用它 ' +
        '—— 占位符不会被替换，浏览器会拿到字面量（死链）');
    }
    const distHtml = files.filter((f) => /(^|[\\/])dist[\\/].*\.html$/.test(f));
    const residual = distHtml.filter((f) => /\{\{[A-Z_]+\}\}/.test(read(f)));
    if (residual.length) {
      problems.push('I25 ' + site + '：产物 HTML 里有 ' + residual.length + ' 个未被替换的 {{…}} 占位符（' +
        residual.slice(0, 3).map((f) => f.slice(siteDir.length + 1)).join(', ') + '）—— 会被原样发给浏览器');
    }
  }
  if (usesHelper) {
    const def = files.find((f) => /\.(ts|tsx)$/.test(f) && new RegExp('(const|function)\\s+' + ASSET_HELPER + '\\b').test(read(f)));
    if (!def) {
      problems.push('I25 ' + site + '：<head> 调用了 ' + ASSET_HELPER + '()，但仓里找不到它的定义 ' +
        '—— 它由 src/lib/site-env.ts 提供，缺了就是构建期报错或链接为空');
    }
  }
  return problems;
}
