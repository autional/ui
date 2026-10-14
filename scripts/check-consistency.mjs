#!/usr/bin/env node
// check-consistency — 跨 portal 视觉一致性检查
// 用法: node scripts/check-consistency.mjs [--json]
//
// 为什么需要它：
//   目标是「14 个 portal 看起来像同一家公司同一个产品的不同门户」。
//   令牌层已经打通（check-typography / check-consumers），但实测算下来，
//   真正让 portal 之间看起来不像一家的是下面三件事，此前没有任何检查覆盖：
//
//   C1 用 antd 的控制台没有把 antd 主题接到设计系统上
//      实测：admin 设了 token.colorPrimary = '#003153'（品牌蓝）；
//            platform 与 security 的 ConfigProvider **只设了 algorithm**，
//            渲染出来 18 处是 antd 出厂蓝 rgb(22,119,255)（含侧边栏 .ant-menu-item-selected）。
//            同一个产品，两个控制台的主色不是一个。
//      ui 仓库其实已经生成好 packages/tokens/dist/antd-theme.js，但无人消费——与 KI-006 同一种病。
//
//   C2 页面里硬编码设计系统已有的色值
//      实测 185 处：style 内联 66 / JS 常量 113 / CSS 6。
//      其中 antd 控制台的 antd-app.tsx 手写整套主题色，另有图标内联色、Statistic.valueStyle 等。
//
//   C3 packages/ui 共享组件库在 9 个站点各存一份
//      实测 29 个源文件里差 1–5 个（ErrorBoundary / PageContainer / package.json / test setup / vitest config）。
//      组件主体一致，但这是又一处「拷贝而非依赖」。
//
//   C5 直接 import antd 的入口数没有记账
//      收敛是分批次做的（D10：按组件种类分批，不按文件）。批次之间必须有个东西记住
//      「现在是多少」，否则这一批刚清掉的 import 会被下一批悄悄加回来。
//      台账 verification/antd-entries.json 就是那个东西：数字只许减不许增。
//// 判据必须跟着事实走：下面 C2 的「设计系统色值表」直接从 tokens 派生，
// 不写死清单——令牌改了，检查自动跟上。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, loadTokens, stripMeta, flatten } from './lib/tokens.mjs';
import { PORTALS } from './lib/portals.mjs';
import { ARTIFACT_DIRS } from './lib/scan-scope.mjs';

const AS_JSON = process.argv.includes('--json');
const SITES = process.env.AUTIONAL_SITES_DIR || resolve(ROOT, '..', 'sites');
const KNOWN = join(ROOT, 'verification', 'known-issues.json');
const TODAY = new Date().toISOString().slice(0, 10);

const SITES_HAS = (s) => { try { return statSync(join(SITES, s)).isDirectory(); } catch (e) { return false; } };
const problems = [];
const warns = [];
const info = [];
const known = existsSync(KNOWN) ? (JSON.parse(readFileSync(KNOWN, 'utf8')).issues || []) : [];

// ── 设计系统"品牌定义色"表：从令牌派生 ──────────────────────────────────
// 只收品牌定义性的色，不收中性白/黑/浅灰——那些在各处合法出现，收了只会淹没信号。
const core = stripMeta(loadTokens().core);
const BRANDISH = /^(primary|sky|amber)\.|^(success|warning|danger|info)$|^brand|^bg-developer$|^accent$/;
const colorToToken = new Map();
for (const [p, v] of Object.entries(flatten({ color: core.color }))) {
  const name = p.replace(/^color\./, '');
  if (!BRANDISH.test(name)) continue;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) continue;
  if (!colorToToken.has(v.toLowerCase())) colorToToken.set(v.toLowerCase(), 'color.' + name);
}
const HEX_RE = /#[0-9a-fA-F]{6}\b/g;

function walk(dir, acc, test, skip) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of entries) {
    if (skip && skip(e, dir)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, test, skip);
    else if (test(e.name)) acc.push(p);
  }
  return acc;
}
function execFileSyncSafe(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}
// R8（2026-10-15）：**构建期生成目录**显式排除在度量之外。
// 实测：docs 站 `src/pages/errors/*.astro` 由 scripts/gen-errors-pages.mjs **构建期生成**
// （其仓 .gitignore 已忽略，788 个文件、每个都含 <table>），却被 C8 当成「手写 <table>」
// ⇒ 计数 10 → 798 假红。生成物与手写代码不是一回事，拿前者判后者属判据错误。
// 为什么不用通用「git check-ignore」判定：这些站点在 `autional-cn/sites/*` 下是 **junction**
// （→ deploy-sync/*），实测同一条 `git -C … check-ignore -q` 在命令行返回 0、在 walk 里却拿不到该规则
// （junction 的仓发现语义不稳）；与其依赖它，不如按「生成物名单」**显式**排除（与本文件 ARTIFACT_DIRS 同惯例，可读可审）。
const GENERATED_DIRS = new Set(['errors']); // 生成器：sites/docs/scripts/gen-errors-pages.mjs（写入 src/pages/errors/）
const SKIP = (e, dir) => ARTIFACT_DIRS.has(e.name)
  || (e.isDirectory() && e.name === 'tailwind-preset' && dir.endsWith('packages'))
  || (e.isDirectory() && GENERATED_DIRS.has(e.name) && dir.endsWith('pages'));

if (!existsSync(SITES)) {
  console.log('check-consistency：本次工作区没有 sites/，跳过（CI 里同样跳过）');
  process.exit(0);
}

// ── antd 依赖台账（C1 / C5 共用一次扫描）────────────────────────────────
// 为什么要台账而不是每次现算：antd 是「14 个 portal 看起来像同一个产品」这条路上最大的
// 一处各自为政 —— 实测三个控制台各有 100+ 处直接 import antd。收敛按 D10 分种类分批做，
// 批次之间必须有个东西记住「现在是多少」，否则这一批刚清掉的 import 会被下一批悄悄加回来。
const ANTD_REGISTRY_PATH = join(ROOT, 'verification', 'antd-entries.json');
const CONSOLE_HEADERS_PATH = join(ROOT, 'verification', 'console-headers.json');
const PALETTE_PATH = join(ROOT, 'verification', 'palette-usage.json');
const WRITE_REGISTRY = process.argv.includes('--write-registry');
const ANTD_KINDS = ['Table', 'DatePicker', 'RangePicker', 'Drawer', 'icons', 'other', 'subpath'];
// ⚠ 'RangePicker' 是**唯一一个按用法计数的种类**，其余六个都按具名导入计。
// 原因是 antd 根本没有顶层导出 `RangePicker`：站点只能写 `const { RangePicker } = DatePicker;`，
// 于是「有没有用 RangePicker」在导入那一层**看不见**——只数 import 的话，这一批收敛完
// 再有人加回一个 RangePicker，棘轮会一声不吭。所以它单独扫源码里的 `RangePicker` 标识符（先剥注释）。
const antdKindOf = (name) => {
  if (name === 'Table') return 'Table';
  if (name === 'RangePicker') return 'DatePicker';
  if (name === 'DatePicker' || name === 'TimePicker' || name === 'Calendar') return 'DatePicker';
  if (name === 'Drawer') return 'Drawer';
  return 'other';
};

// 计的是**入口数**（具名导入的个数），不是用法数：一个文件 import 了 5 个组件算 5 个入口。
function countAntdText(txt) {
  const specifiers = {};
  for (const k of ANTD_KINDS) specifiers[k] = 0;
  // RangePicker 按用法计（原因见 ANTD_KINDS 旁边的注释）。先剥注释：
  // 本项目里就有「在注释里解释 RangePicker 这件事」的地方，不剥会把存量凭空加一。
  const code = txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  specifiers.RangePicker = (code.match(/\bRangePicker\b/g) || []).length;
  // ⚠ 不能用 [\s\S]*? —— 它会跨语句匹配：从一个普通的 import 开头一路吃到下一个 import 的 }
  // 上，把中间那些导入的名字全算到自己头上。实测踩过：下面的自检样例一开始把 icons 数成 2。
  const reAntd = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]antd['"]/g;
  const reIcons = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@ant-design\/icons['"]/g;
  let touchesAntd = false;
  let touchesIcons = false;
  for (const m of txt.matchAll(reAntd)) {
    touchesAntd = true;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) specifiers[antdKindOf(name)]++;
    }
  }
  if (/import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s+from\s+['"]antd['"]/.test(txt)) { touchesAntd = true; specifiers.other++; }
  if (/from\s+['"]antd\/(?:es|lib)\//.test(txt)) { touchesAntd = true; specifiers.subpath++; }
  for (const m of txt.matchAll(reIcons)) {
    touchesIcons = true;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) specifiers.icons++;
    }
  }
  return { specifiers, touchesAntd, touchesIcons };
}

function measureAntdSite(siteDir) {
  const files = walk(siteDir, [], (n) => /\.(tsx|ts|jsx|js)$/.test(n), SKIP);
  const specifiers = {};
  for (const k of ANTD_KINDS) specifiers[k] = 0;
  const rec = { specifiers, filesAntd: 0, filesIcons: 0, bridge: [], ownTheme: [] };
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    const rel = relative(SITES, f).replace(/\\/g, '/');
    const c = countAntdText(txt);
    for (const k of ANTD_KINDS) specifiers[k] += c.specifiers[k];
    if (c.touchesAntd) rec.filesAntd++;
    if (c.touchesIcons) rec.filesIcons++;
    if (/AntdThemeProvider/.test(txt) && /from\s+['"]@autional\/ui\/antd['"]/.test(txt)) rec.bridge.push(rel);
    if (/ConfigProvider/.test(txt) && /theme\s*=/.test(txt)) {
      const m = /theme\s*=\s*\{\{([\s\S]*?)\n\s*\}\}/.exec(txt) || /theme\s*=\s*\{\{([\s\S]*?)\}\}/.exec(txt);
      const block = m ? m[1] : '';
      const hexes = [...new Set((block.match(HEX_RE) || []).map((h) => h.toLowerCase()))].filter((h) => colorToToken.has(h));
      rec.ownTheme.push({ rel, hasToken: /token\s*:/.test(block), hexes, consumesBridge: /antd-theme|antdTheme|@autional\/tokens/.test(txt) });
    }
  }
  return rec;
}

const antdRegistry = existsSync(ANTD_REGISTRY_PATH) ? JSON.parse(readFileSync(ANTD_REGISTRY_PATH, 'utf8')) : null;
const antdMeasured = {};
const antdSites = [];
for (const site of readdirSync(SITES)) {
  const sp = join(SITES, site);
  if (!statSync(sp).isDirectory()) continue;
  const rec = measureAntdSite(sp);
  // 走设计系统桥的站点也算 antd 消费方：它渲染的就是 antd 组件，只是入口换成了 DS。
  if (!rec.filesAntd && !rec.filesIcons && !rec.bridge.length) continue;
  antdMeasured[site] = rec;
  antdSites.push(site);
}

// 度量器自检（正负控制）。解析器一旦失灵，棘轮会**全绿**——那比红危险得多，
// 因为它看起来在保护一致性，实际什么都没数。
{
  const c = countAntdText("import { Table, Button as B, DatePicker } from 'antd';\nimport type { MessageInstance } from 'antd/es/message/interface';\nimport { PlusOutlined } from '@ant-design/icons';\nconst { RangePicker } = DatePicker;\n");
  if (!(c.specifiers.Table === 1 && c.specifiers.other === 1 && c.specifiers.subpath === 1 && c.specifiers.icons === 1 && c.specifiers.DatePicker === 1 && c.specifiers.RangePicker === 1 && c.touchesAntd && c.touchesIcons)) {
    problems.push('C5 度量器正向控制失败：解析结果 ' + JSON.stringify(c) + '，期望 Table=1 other=1 subpath=1 icons=1 DatePicker=1 RangePicker=1 —— antd 入口计数解析器出错了，棘轮因此失去意义');
  }
  const n = countAntdText("import { Table } from './table';\nconst x = 'antd';\n// from 'antd'\n// 用 RangePicker 的地方就该用 DateRangeFilter\n");
  if (n.touchesAntd || n.specifiers.Table !== 0 || n.specifiers.RangePicker !== 0) {
    problems.push('C5 度量器负向控制失败：不 import antd 的文本被计成了 ' + JSON.stringify(n) + ' —— 度量器在误报，会让闸门失去可信度');
  }
}

// 手写 <table> 的度量（C8 用）。做成函数是因为写入台账与判定各要一次：
// 逻辑只有一份，重复的只是那次文件遍历。
function countHandwrittenTables() {
  // 这里自带一个剥注释的小函数，而不是复用下面 C2 的 stripComments ——
  // 那个是在 C2 段定义的，而本函数在写入台账时（更早）就会被调用，直接复用会撞上 TDZ。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  const counts = {};
  for (const site of readdirSync(SITES)) {
    const sp = join(SITES, site);
    if (!statSync(sp).isDirectory()) continue;
    if (!SITES_HAS(site)) continue;
    let n = 0;
    for (const f of walk(sp, [], (x) => /\.(tsx|jsx|astro)$/.test(x), SKIP)) {
      // 先剥注释：本项目里就有「把 <table> 写进注释解释这件事」的地方，
      // 不剥的话注释会把存量数凭空加一。
      n += (strip(readFileSync(f, 'utf8')).match(/<table[\s>]/g) || []).length;
    }
    if (n) counts[site] = n;
  }
  return counts;
}

// ── C10 控制台页头的度量（D5）───────────────────────────────────────────
// 两种「页头各写一遍」的形态，都要数：
//   ① inline    页面自己写 <h1 className="… text-xl font-semibold …">
//   ② marketing 控制台误用了设计系统的营销 PageHeader（居中 hero，text-3xl/sm:text-4xl）
// ② 是 §2.1「同名不同物」那一条在现实里的样子：实测有三个控制台的 36 个页面把营销 hero 当页头用，
// 于是同一个产品里一半页面是左对齐小标题、另一半是居中大标题。收敛目标是都用 AppPageHeader。
const CONSOLE_SITES = ['admin', 'platform', 'security'];
const INLINE_H1_RE = /<h1\b[^>]*>/g;
function countConsoleHeaders() {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  const inline = {};
  const marketing = {};
  for (const site of CONSOLE_SITES) {
    if (!SITES_HAS(site)) continue;
    const sp = join(SITES, site);
    let a = 0, b = 0;
    for (const f of walk(sp, [], (x) => /\.(tsx|jsx)$/.test(x), SKIP)) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(INLINE_H1_RE)) {
        const cls = (m[0].match(/className="([^"]*)"/) || [, ''])[1];
        if (/\btext-xl\b/.test(cls) && /\bfont-semibold\b/.test(cls)) a++;
      }
      // <PageHeader 不匹配 <AppPageHeader：正则要求 '<' 紧跟 PageHeader
      b += (code.match(/<PageHeader\b/g) || []).length;
    }
    if (a) inline[site] = a;
    if (b) marketing[site] = b;
  }
  return { inline, marketing };
}

// ── C11 非设计系统色阶的度量 ────────────────────────────────────────────
// 设计系统的 tailwind preset 只定义四个色阶：primary / sky / amber / neutral（其余是语义色）。
// Tailwind **出厂**的那些色阶（gray / red / green / blue / emerald / rose …）仍然能被生成 ——
// 所以第 13 道「类名可达性」抓不到它们。但它们不是设计系统的颜色：
//   ① 同一个页面上 `text-gray-500` 与 `text-neutral-600` 并存时，两个几乎一样的灰会并排出现；
//   ② 出厂色阶没有做过设计系统那套对比度验证（DS 的 neutral-400 只有 1.93:1）。
// 判据与 C5/C8/C9 同形：存量只许减不许增；closedKeys 里的键必须为 0。
//
// 度量范围（第 63 轮扩展）：**14 个站全部**，且**不再排除 `src/components/layout/**`**。
// 此前范围是「4 个控制台 + user」并排除布局目录 —— 那条排除是为并行工作流的只读边界留的（计划 §7 L2），
// 台账注释里写着「边界解除后应一并收敛」。第 63 轮核实：那条工作流的分支已全部并入 main
// （逐分支 rev-list 为 0），边界条件不再成立，于是解除。
// 扩展当天实测：范围外的存量是 **356 处**（trust 137 / status 111 / authenticator 47 / web 33 /
// docs 18 / auth 8 / developer 1 / user 1），全部迁移到设计系统令牌后归零。
// 「0 处」这个读数从此覆盖全舰队 —— 在此之前它只覆盖 5 个站，很容易被读成全量。
const DS_FAMILIES = new Set(['primary', 'sky', 'amber', 'neutral']);
const LOCKED_CLASSES = ['text-neutral-400'];
const PALETTE_RE = /\b(bg|text|border|ring|divide|from|to|via|fill|stroke|outline|shadow|decoration|placeholder|caret|accent)-(red|green|blue|yellow|orange|emerald|rose|violet|purple|indigo|teal|cyan|lime|pink|gray|grey|slate|zinc|stone)-(\d{2,3})\b/g;
// （原 PALETTE_EXCLUDE 已删除：布局目录不再豁免，见上面的范围说明。）
function countPaletteUsage() {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  const out = {};
  // 第 63 轮：范围扩到全部 14 个站（原来只有 4 个控制台 + user）。
  const PALETTE_SITES = readdirSync(SITES).filter((n) => { try { return statSync(join(SITES, n)).isDirectory(); } catch { return false; } }).sort();
  for (const site of PALETTE_SITES) {
    if (!SITES_HAS(site)) continue;
    const counts = {};
    for (const f of walk(join(SITES, site), [], (x) => /\.(tsx|jsx|ts|astro)$/.test(x), SKIP)) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(PALETTE_RE)) {
        if (DS_FAMILIES.has(m[2])) continue;
        counts[m[2]] = (counts[m[2]] || 0) + 1;
      }
      for (const cls of LOCKED_CLASSES) {
        const re = new RegExp('\\b' + cls + '\\b', 'g');
        for (const m of code.matchAll(re)) {
          // 只锁**无变体前缀**的：disabled:text-neutral-400 是设计系统许可的禁用态写法
          const before = code[m.index - 1];
          if (before === ':' || before === '-') continue;
          counts[cls] = (counts[cls] || 0) + 1;
        }
      }
    }
    if (Object.keys(counts).length) out[site] = counts;
  }
  return out;
}

if (WRITE_REGISTRY) {
  const prev = (antdRegistry && antdRegistry.sites) || {};
  const out = {
    $comment: 'antd 直接依赖台账（棘轮）。specifiers 计的是**入口数**（具名导入个数），不是用法数。数字只许减不许增：新增直接 import antd 会被 C5 判红。closedKinds 里的种类必须为 0（该批收敛完了）。themeConverged=true 的站点另受 C1 强判据约束：不许自己拿 ConfigProvider。',
    updated: TODAY,
    kinds: ANTD_KINDS,
    closedKinds: (antdRegistry && antdRegistry.closedKinds) || [],
    tableConvergedSites: (antdRegistry && antdRegistry.tableConvergedSites) || [],
    overlayConvergedSites: (antdRegistry && antdRegistry.overlayConvergedSites) || [],
    handwrittenTablesBySite: countHandwrittenTables(),
    handwrittenOverlaysBySite: countHandwrittenOverlays(),
    sites: {},
  };
  for (const [site, rec] of Object.entries(antdMeasured)) {
    out.sites[site] = {
      themeConverged: !!(prev[site] && prev[site].themeConverged),
      specifiers: rec.specifiers,
      filesAntd: rec.filesAntd,
      filesIcons: rec.filesIcons,
      bridgeFiles: rec.bridge.length,
      ownThemeFiles: rec.ownTheme.length,
    };
  }
  writeFileSync(ANTD_REGISTRY_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('已写入 ' + relative(ROOT, ANTD_REGISTRY_PATH).replace(/\\/g, '/') + '（' + Object.keys(out.sites).length + ' 个站点）');

  const chPrev = existsSync(CONSOLE_HEADERS_PATH) ? JSON.parse(readFileSync(CONSOLE_HEADERS_PATH, 'utf8')) : null;
  const ch = countConsoleHeaders();
  writeFileSync(CONSOLE_HEADERS_PATH, JSON.stringify({
    $comment: '控制台页头台账（棘轮，D5）。inline = 页面自己写 text-xl font-semibold 的 <h1>；marketing = 控制台误用设计系统的营销 PageHeader。两者都只许减不许增，convergedSites 里的站点必须为 0（该站已全部改用 @autional/ui 的 AppPageHeader）。',
    updated: TODAY,
    convergedSites: (chPrev && chPrev.convergedSites) || [],
    inline: ch.inline,
    marketing: ch.marketing,
  }, null, 2) + '\n');
  console.log('已写入 ' + relative(ROOT, CONSOLE_HEADERS_PATH).replace(/\\/g, '/') + '（inline ' + Object.values(ch.inline).reduce((x, y) => x + y, 0) + ' 处 / marketing ' + Object.values(ch.marketing).reduce((x, y) => x + y, 0) + ' 处）');

  const pPrev = existsSync(PALETTE_PATH) ? JSON.parse(readFileSync(PALETTE_PATH, 'utf8')) : null;
  const pu = countPaletteUsage();
  writeFileSync(PALETTE_PATH, JSON.stringify({
    $comment: '非设计系统色阶台账（棘轮，C11）。键 = 非 DS 的 Tailwind 色系名（gray/red/green/blue/…），或设计系统内部被锁的类名（如 text-neutral-400）。数字只许减不许增；closedKeys 里的键必须为 0。度量范围排除 src/components/layout/**（并行工作流只读边界，边界解除后一并收敛）。',
    updated: TODAY,
    // 第 63 轮起：覆盖全部站点（判定时按台账里的这份名单逐个断言 closedKeys 必须为 0）
  coveredSites: ['admin', 'auth', 'authenticator', 'brand', 'developer', 'docs', 'platform', 'reference', 'security', 'status', 'trust', 'user', 'web', 'wiki'],
    closedKeys: (pPrev && pPrev.closedKeys) || [],
    usage: pu,
  }, null, 2) + '\n');
  console.log('已写入 ' + relative(ROOT, PALETTE_PATH).replace(/\\/g, '/') + '（非 DS 色阶 ' + Object.values(pu).reduce((a, o) => a + Object.entries(o).filter(([k]) => !LOCKED_CLASSES.includes(k)).reduce((x, [, y]) => x + y, 0), 0) + ' 处）');
  process.exit(0);
}

// ── C1 antd 主题是否接到设计系统（唯一桥）──────────────────────────────
// 判据分两档，跟着**该站点是否已在台账里收敛**走：
//   · 未收敛：站点仍可自持 ConfigProvider，但必须有 token，且不得手写设计系统已有的色值；
//   · 已收敛（themeConverged=true）：**不许**再自己拿 ConfigProvider —— 必须挂
//     @autional/ui/antd 的 AntdThemeProvider，主题只能从设计系统下发。
// 为什么必须分档：2026-10 起三个控制台把主题收进了设计系统，本地已经没有 ConfigProvider。
// 旧判据「没有 ConfigProvider 就是没接主题」会把已经收敛的站点判成红的，方向正好相反；
// 而如果把判据整体放宽成「有桥或有 ConfigProvider 都算」，收敛状态就再也没人守了。
const c1 = [];
const themeConverged = (site) => !!(antdRegistry && antdRegistry.sites && antdRegistry.sites[site] && antdRegistry.sites[site].themeConverged);
for (const site of antdSites) {
  const rec = antdMeasured[site];
  const converged = themeConverged(site);
  if (!rec.bridge.length && !rec.ownTheme.length) {
    problems.push('C1 ' + site + ' 源码里使用了 antd，但既没有自己的 ConfigProvider theme，也没有挂设计系统的 AntdThemeProvider——antd 组件将使用出厂配色（primary #1677ff），与已接入品牌的控制台不一致');
  }
  if (converged && !rec.bridge.length) {
    problems.push('C1 ' + site + ' 在台账里登记为 themeConverged=true，但源码里没有任何文件挂 @autional/ui/antd 的 AntdThemeProvider——登记与事实不符：要么补挂桥，要么把台账改回 false');
  }
  for (const o of rec.ownTheme) {
    if (converged) {
      problems.push('C1 ' + site + ' 已收敛到设计系统，但 ' + o.rel + ' 仍自己拿 ConfigProvider theme= —— antd 主题只能由 @autional/ui/antd 下发，本地再拿一份就是又一处会各自漂移的实现（这正是 KI-011 的成因）');
      continue;
    }
    if (!o.hasToken) {
      problems.push('C1 ' + o.rel + ' 的 ConfigProvider 只设了 algorithm、没有 token——antd 组件走出厂配色，未接品牌');
      continue;
    }
    if (o.hexes.length && !o.consumesBridge) {
      problems.push('C1 ' + o.rel + ' 的 antd 主题手写了 ' + o.hexes.length + ' 个设计系统已有色值（' + o.hexes.slice(0, 5).join(' ') + '）而不是消费 @autional/tokens/antd-theme——令牌变更不会传导到这里');
    }
  }
}
info.push('C1 使用 antd 的站点：' + antdSites.length + ' 个（' + antdSites.join(', ') + '）；主题已收敛到设计系统的：' + (antdSites.filter(themeConverged).join(', ') || '无'));

// ── C5 直接 import antd 的入口数（棘轮：只许减，不许增）─────────────────
// 收敛是分批次做的，台账是批次之间的记忆。没有它，每一批刚清掉的 import 都可能在下一批
// 被重新加回来，而且没人会注意到——因为「多一处 import antd」本身不会让任何检查变红。
if (!antdRegistry) {
  problems.push('C5 verification/antd-entries.json 缺失——antd 收敛分批次进行（D10：按组件种类分批），批次之间靠这份台账记住基线。用 node scripts/check-consistency.mjs --write-registry 生成。');
} else {
  const closedKinds = new Set(antdRegistry.closedKinds || []);
  for (const k of closedKinds) {
    if (!ANTD_KINDS.includes(k)) {
      problems.push('C5 台账里的 closedKinds 含有未定义种类「' + k + '」——种类拼错会让该批的闸门静默失效（合法种类：' + ANTD_KINDS.join(' / ') + '）');
    }
  }
  let total = 0;
  let rangeTotal = 0;
  for (const [site, rec] of Object.entries(antdMeasured)) {
    const entry = antdRegistry.sites ? antdRegistry.sites[site] : null;
    if (!entry) {
      problems.push('C5 ' + site + ' 有 antd 直接依赖但没有登记在 verification/antd-entries.json——新出现的消费方先登记（--write-registry）并在评审里说明为什么不能走 @autional/ui/antd');
      continue;
    }
    // RangePicker 是用法计数，不进「入口数」这个总数（口径混在一起会让总数失去意义），单独报。
    for (const k of ANTD_KINDS) if (k !== 'RangePicker') total += rec.specifiers[k] || 0;
    rangeTotal += rec.specifiers.RangePicker || 0;
    const grew = [];
    const shrank = [];
    for (const k of ANTD_KINDS) {
      const now = rec.specifiers[k] || 0;
      const was = (entry.specifiers && entry.specifiers[k]) || 0;
      if (now > was) grew.push(k + ' ' + was + '→' + now);
      else if (now < was) shrank.push(k + ' ' + was + '→' + now);
    }
    if (grew.length) {
      problems.push('C5 ' + site + ' 新增了直接 import antd 的入口（' + grew.join('、') + '）。全舰队的 antd 入口只减不增：能走 @autional/ui/antd 的走设计系统，确实缺能力就先把能力补进设计系统，而不是在站点里直接 import。');
    }
    for (const k of closedKinds) {
      if ((rec.specifiers[k] || 0) > 0) {
        problems.push('C5 ' + site + ' 仍有 ' + rec.specifiers[k] + ' 处 ' + k + '，而种类「' + k + '」在台账里已登记为 closed（该批收敛完了）——closed 的含义是 0 处。该批次应改走设计系统对应件。');
      }
    }
    if (shrank.length) {
      warns.push('C5 ' + site + ' 的直接 import 比台账少了（' + shrank.join('、') + '）——这是进展，但请跑 node scripts/check-consistency.mjs --write-registry 更新台账，否则台账会慢慢变成一段没人相信的数字。');
    }
  }
  info.push('C5 直接 import antd 的入口总数：' + total + ' 处（' + ANTD_KINDS.filter((k) => k !== 'RangePicker').join(' / ') + '），分布在 ' + Object.keys(antdMeasured).length + ' 个站点');
  info.push('C5 直接用 antd RangePicker 的处数：' + rangeTotal + ' 处（按用法计；收敛目标是改走 @autional/ui/antd 的 DateRangeFilter）');
}


// ── C2 页面里硬编码设计系统色值 ─────────────────────────────────────────
// 判据细节（第一版有假阳性，按实测修）：
//   ① 跳过 public/ —— 那里是第三方 vendored 产物（如 reference/public/scalar/api-reference.js），不是站点自己的代码；
//   ② 扫之前先剥掉注释 —— 否则「文档里提到某个色值」会被当成硬编码（本项目自己的 global.css 头部注释就中过招）；
//   ③ 测试文件单列：断言里出现色值是正当的，降级为 INFO，不判失败；
//   ④ 构建配置文件（*.config.*）单列：那里的色值是写给工具/清单用的字面量，不是渲染样式。
//      实测踩过：status 的 vite.config.ts 里 theme_color: '#003153' 是 PWA manifest 字段，
//      写成 var(--color-primary-700) 在 manifest.webmanifest 里毫无意义（它不经过 CSS 解析）。
// 注意 m 标志：没有它时 `^` 只匹配整个字符串的开头，行内的 // 注释剥不掉——
// 实测本项目自己的 antd-app.tsx 头注释就被当成了硬编码（第二处同类假阳性）。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
const isPublic = (f, sp) => relative(sp, f).replace(/\\/g, '/').startsWith('public/');
const isTest = (f) => /(__tests__|\.test\.|\.spec\.)/.test(f);
const isBuildConfig = (f) => /[^/]*\.config\.[cm]?[jt]s$/.test(f);
// ⑤ theme-color / theme_color 这一类是**写给浏览器与清单的字面量**，不经过 CSS 解析。
//    在这类位置写 var() 不是「更规范」，而是**失效**——浏览器视作非法值直接忽略。
//    实测踩过：wiki 的 <meta name="theme-color" content="var(--color-primary-700)">
//    实际效果是「没有 theme-color」。与 ④ 同理，这类行降级为 INFO，不判失败。
const isLiteralOnlyContext = (line) => /theme[-_]color/i.test(line);
const c2rows = [];
const c2test = [];
for (const site of readdirSync(SITES)) {
  const sp = join(SITES, site);
  if (!statSync(sp).isDirectory()) continue;
  const files = walk(sp, [], (n) => /\.(tsx|ts|jsx|js|css|astro)$/.test(n), SKIP).filter((f) => !isPublic(f, sp));
  const hits = [];
  const testHits = [];
  for (const f of files) {
    const text = stripComments(readFileSync(f, 'utf8'));
    text.split('\n').forEach((line, i) => {
      const found = [...new Set((line.match(HEX_RE) || []).map((h) => h.toLowerCase()))].filter((h) => colorToToken.has(h));
      if (!found.length) return;
      const rec = { file: relative(sp, f).replace(/\\/g, '/'), line: i + 1, found: found.map((h) => h + '=' + colorToToken.get(h)) };
      (isTest(f) || isBuildConfig(f) || isLiteralOnlyContext(line) ? testHits : hits).push(rec);
    });
  }
  if (hits.length) c2rows.push({ site, hits });
  if (testHits.length) c2test.push({ site, n: testHits.length });
}
const c2total = c2rows.reduce((a, r) => a + r.hits.length, 0);
info.push('C2 硬编码设计系统已有色值的行数：' + c2total + ' 处，分布在 ' + c2rows.length + ' 个站点');
if (c2test.length) info.push('C2b 测试文件与构建配置里的色值（正当，不判失败——前者是断言、后者是写给工具/清单的字面量）：' + c2test.map((t) => t.site + ' ' + t.n + ' 行').join(', '));
for (const r of c2rows) {
  problems.push('C2 ' + r.site + '：' + r.hits.length + ' 行硬编码了设计系统已有同值的色（示例：' +
    r.hits.slice(0, 3).map((h) => h.file + ':' + h.line + ' ' + h.found.join(' ')).join('；') +
    '）。这些颜色应引用 var(--color-*) 或令牌，否则改令牌不会传导、各 portal 会各自漂移。');
}

// ── C3 packages/ui 的本地副本 ───────────────────────────────────────────
// 判据变过一次，跟着**交付方式**变：
//   · 2026-09 之前：组件库以 9 份逐字节相同的副本存在，C3 守的是「它们不许分叉」；
//   · 2026-09 起：组件库发布为 @autional/ui@0.1.0-rc，14 个站点全部改为 npm 依赖，
//     本地副本清零。于是判据从「N 份里只有 1 种实现」改成 **「0 份」** ——与 P4 对
//     packages/tailwind-preset 的处理完全同构。
// 为什么要改而不是留着：留着「1 种实现」会让副本悄悄长回来时**照样全绿**
// （副本只要彼此一致就没问题），而那时「站点真的从 npm 消费组件库」已经没人看了。
const uiCopies = [];
for (const site of readdirSync(SITES)) {
  if (existsSync(join(SITES, site, 'packages', 'ui'))) uiCopies.push(site);
}
info.push('C3 packages/ui 的本地副本：' + uiCopies.length + ' 个站点' +
  (uiCopies.length ? '（' + uiCopies.join('/') + '）' : '——全部走已发布的 @autional/ui'));
if (uiCopies.length) {
  problems.push('C3 有 ' + uiCopies.length + ' 个站点还留着组件库副本 packages/ui（' + uiCopies.join('/') +
    '）。组件库已发布为 @autional/ui@0.1.0-rc，站点应声明 npm 依赖、删除副本——' +
    '「拷贝而非依赖」正是这一层要消灭的东西。');
}

// ── C4 站点本地覆盖设计系统令牌（同名、不同值）──────────────────────────
// 与 C2 的区别：C2 查「硬编码了某个等于令牌的色值」；C4 查「把设计系统已有的变量名
// 在本地重新定义成别的值」——后者更隐蔽，因为它看起来在「用令牌」，实际把令牌改掉了。
// 实测（2026-09）：全舰队只有 3 处，都在 admin 的图表色上。
// ⚠️ 判据必须**分上下文**：站点在 [data-theme="dark"] 里写 --color-bg-primary 本就该与 :root 不同，
// 正确的参照是设计系统的 .dark 块，不是 :root。早期版本只取 :root 作参照，又用
// `if (/^var\(/.test(val)) continue;` 把「用 var() 引了错令牌」整类跳过——
// 于是 5 个站把暗色底色写成中性灰（--color-neutral-900/800），而设计系统是品牌深蓝
// （--color-primary-900 / #0a2940），**一处都没报**，全绿了整整几轮。
// 「看起来在引用令牌」正是最隐蔽的一种分叉，判据不能把它排除在外。
const DS_CSS = readFileSync(join(ROOT, 'packages', 'tokens', 'tokens.css'), 'utf8');
// 去掉 @layer/@media/@supports 外壳（保留内部规则）与 @keyframes（整块丢弃），
// 这样下面按「选择器 { 声明 }」逐块扫描时，选择器就是真正的选择器。
// 按**配对花括号**摘块，不用正则：第一版用贪婪的 /@layer[^{]*\{([\s\S]*)\n\}/，
// 它一路吃到文件里最后一个 \n}，把紧随其后的站点暗色块连外层一起吞掉，
// 结果是 platform 的 6 处分叉一处都没报（而同一份内容在 admin 上报了）。
// 「闸门少报」比「闸门误报」危险得多——它看起来是绿的。
const AT_WRAPPER = /^@(layer|media|supports|container)\b/;
const AT_KEYFRAMES = /^@(-webkit-)?keyframes\b/;
function spliceBlocks(css, pred, keepInner) {
  let out = '';
  let i = 0;
  let changed = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { out += css.slice(i); break; }
    const sel = css.slice(i, open);
    if (!pred(sel.trim())) { out += css.slice(i, open + 1); i = open + 1; continue; }
    let depth = 0; let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (!depth) break; }
    }
    out += keepInner ? css.slice(open + 1, j) : '';
    i = j + 1;
    changed++;
  }
  return { out, changed };
}
function shellOut(css) {
  let out = spliceBlocks(css, (s) => AT_KEYFRAMES.test(s), false).out;
  for (let i = 0; i < 12; i++) {
    const r = spliceBlocks(out, (s) => AT_WRAPPER.test(s), true);
    if (!r.changed) break;
    out = r.out;
  }
  return out;
}
function varMapOf(css, wantDark) {
  const m = new Map();
  for (const r of shellOut(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const dark = /\.dark|\[data-theme=["']?dark/.test(r[1]);
    if (dark !== wantDark) continue;
    for (const d of r[2].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) m.set(d[1], d[2].trim());
  }
  return m;
}
const dsVars = varMapOf(DS_CSS, false);
const dsDarkVars = varMapOf(DS_CSS, true);
const c4rows = [];
{
  for (const site of readdirSync(SITES)) {
    const sp = join(SITES, site);
    if (!statSync(sp).isDirectory()) continue;
    const files = walk(sp, [], (n) => /\.(css|astro|tsx|ts)$/.test(n), SKIP)
      .filter((f) => !relative(sp, f).replace(/\\/g, '/').startsWith('public/'));
    for (const f of files) {
      const rel = relative(sp, f).replace(/\\/g, '/');
      const text = shellOut(stripComments(readFileSync(f, 'utf8')));
      for (const r of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = r[1].trim().replace(/\s+/g, ' ');
        if (!sel || sel.startsWith('@')) continue;
        // 站点自己的暗色块 → 与设计系统的 .dark 比；其余 → 与 :root 比
        const dark = /\.dark|\[data-theme=["']?dark/.test(sel);
        const ref = dark ? dsDarkVars : dsVars;
        for (const d of r[2].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
          const name = d[1]; const val = d[2].trim();
          if (!ref.has(name)) continue;
          if (val === ref.get(name)) continue;
          // 自引用（--x: var(--x)）不是分叉，跳过；其余一律算。
          if (new RegExp('^var\\(\\s*' + name.replace(/[-]/g, '\\-') + '\\s*[,)]').test(val)) continue;
          c4rows.push({ site, rel, sel, dark, name, val, ds: ref.get(name) });
        }
      }
    }
  }
}
info.push('C4 本地覆盖设计系统令牌且值不同的处数：' + c4rows.length + ' 处，分布在 ' +
  new Set(c4rows.map((r) => r.site)).size + ' 个站点');
for (const s of new Set(c4rows.map((r) => r.site))) {
  const list = c4rows.filter((r) => r.site === s);
  const darkN = list.filter((r) => r.dark).length;
  problems.push('C4 ' + s + '：' + list.length + ' 处把设计系统已有的变量名在本地重新定义成了别的值' +
    (darkN ? '（其中 ' + darkN + ' 处在暗色/主题选择器里，参照的是设计系统的 .dark 块）' : '') + '（' +
    list.slice(0, 4).map((r) => r.sel.slice(0, 24) + ' ' + r.name + ' = ' + r.val + '，设计系统为 ' + r.ds).join('；') +
    '）。这看起来像在用令牌，实际把令牌改掉了——各 portal 因此会各自漂移。' +
    '修法二选一：改用设计系统的值（暗色块通常直接删掉即可，tokens.css 的 .dark 已经定义），' +
    '或把该站点确实需要的差异补成设计系统里的新令牌。');
}

// ── C6 打包分块策略（同一套键名 + 同一套归属）──────────────────────────
// 同一产品的 portal 不该因为「谁当年记得加 vendor 块」而在首屏体积上差一个量级。
// 实测踩过：admin 的 manualChunks 里没有 antd，于是 1.3MB 的 antd 混进了入口块
// （入口 2,698KB / gzip 739KB），而 platform 与 security 把它单独成块（入口 224–282KB）。
// 判据只对**已经采纳分块策略**的站点生效（有 manualChunks 才算采纳）；
// 一旦采纳，键名与归属就必须与下面这张策略表完全一致，且本站依赖到的库不许漏。
const CHUNK_POLICY = {
  'vendor-react': ['react', 'react-dom', 'react-router'],
  'vendor-ui': ['antd', '@ant-design/icons', 'lucide-react'],
  'vendor-charts': ['recharts'],
  'vendor-query': ['@tanstack/react-query'],
  'vendor-i18n': ['i18next', 'react-i18next'],
  'shared-api': ['@autional/shared'],
};
const libToChunk = new Map();
for (const [chunk, libs] of Object.entries(CHUNK_POLICY)) for (const l of libs) libToChunk.set(l, chunk);
const c6sites = new Set();
for (const site of readdirSync(SITES)) {
  const sp = join(SITES, site);
  if (!statSync(sp).isDirectory()) continue;
  for (const cfg of walk(sp, [], (n) => /^vite\.config\.[cm]?ts$/.test(n), SKIP)) {
    const txt = readFileSync(cfg, 'utf8');
    const m = /manualChunks\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(txt);
    if (!m) continue;
    const rel = relative(SITES, cfg).replace(/\\/g, '/');
    c6sites.add(site);
    const assigned = new Map();
    for (const e of m[1].matchAll(/['"]([^'"]+)['"]\s*:\s*\[([^\]]*)\]/g)) {
      const chunk = e[1];
      for (const lib of e[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)) {
        assigned.set(lib, chunk);
        const want = libToChunk.get(lib);
        if (!want) {
          problems.push('C6 ' + rel + ' 把 ' + lib + ' 分到了 ' + chunk + '，但这个库没有登记在分块策略里——先把它登记进 check-consistency 的 CHUNK_POLICY，否则各站会各自发明归属');
        } else if (want !== chunk) {
          problems.push('C6 ' + rel + ' 把 ' + lib + ' 分到了 ' + chunk + '，策略里是 ' + want + '——同一个库在不同 portal 属于不同块，缓存与体积口径就不一致了');
        }
      }
    }
    if (!assigned.size) {
      problems.push('C6 ' + rel + ' 写了 manualChunks 却一个条目都没解析出来——判据会因此静默失效（写法变了或解析器坏了）');
      continue;
    }
    const pkgPath = join(dirname(cfg), 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const missing = Object.keys(pkg.dependencies || {}).filter((d) => libToChunk.has(d) && !assigned.has(d));
    if (missing.length) {
      problems.push('C6 ' + rel + ' 没有给这些依赖分块：' + missing.map((d) => d + '（应属 ' + libToChunk.get(d) + '）').join('、') + '——它们会混进入口块，业务代码一改就要用户重下整个依赖库');
    }
  }
}
info.push('C6 已采纳分块策略的站点：' + c6sites.size + ' 个（' + [...c6sites].join(', ') + '）');

// ── C7 站点测试环境（jsdom 缺口只有一份实现）────────────────────────────
// 实测踩到：三个控制台各自抄了一份 matchMedia + ResizeObserver 的补丁，user 只有 matchMedia。
// 于是 user 接入 antd 的当天，**8 个既有用例一起红**在「ResizeObserver is not defined」上，
// 而那条报错完全指不到真正的原因（它看起来像页面代码坏了）。
//
// 判据分两条，依据不同，所以不能合并：
//   ① 任何站点都不许在**本地**定义 matchMedia / ResizeObserver —— 抄成四份的东西必然有一份漏掉；
//   ② **用 antd 的站点**必须消费设计系统那一份 —— antd 同时依赖这两个 API。
//      这一条刻意**不**对全舰队要求：不吃 antd 的站补了也用不上，
//      那会变成「给 5 个站点加一个用不到的 import」——判据要跟着事实走，不是跟着整齐走。
const C7_SETUP_IMPORT = '@autional/ui/test-setup';
const c7setup = new Map();
for (const site of readdirSync(SITES)) {
  const sp = join(SITES, site);
  if (!statSync(sp).isDirectory()) continue;
  for (const cfg of walk(sp, [], (n) => /^vitest\.config\.[cm]?ts$/.test(n), SKIP)) {
    const m = /setupFiles\s*:\s*\[([^\]]*)\]/.exec(readFileSync(cfg, 'utf8'));
    if (!m) continue;
    const rel = relative(SITES, cfg).replace(/\\/g, '/');
    const refs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (!refs.length) {
      problems.push('C7 ' + rel + ' 声明了 setupFiles 却一个路径都没解析出来——判据会因此静默失效');
      continue;
    }
    const found = c7setup.get(site) || [];
    for (const ref of refs) {
      const setupPath = join(dirname(cfg), ref.replace(/^\.\//, ''));
      if (!existsSync(setupPath)) {
        problems.push('C7 ' + rel + ' 引用的 setup 文件不存在：' + ref);
        continue;
      }
      found.push({ srel: relative(SITES, setupPath).replace(/\\/g, '/'), st: readFileSync(setupPath, 'utf8') });
    }
    c7setup.set(site, found);
  }
}
if (!c7setup.size) {
  problems.push('C7 一个站点的测试 setup 都没扫到——判据静默失效比误报危险得多（要么工程结构变了，要么解析器坏了）');
}
for (const [site, files] of c7setup) {
  for (const { srel, st } of files) {
    // ⚠ 必须先剥注释：本文件与站点 setup 的注释里都写着「ResizeObserver」，
    // 不剥的话这条会把「解释为什么这样做的注释」判成本地又定义了一份。
    if (/ResizeObserver|matchMedia/.test(stripComments(st))) {
      problems.push('C7① ' + srel + ' 本地又定义了一遍 matchMedia / ResizeObserver——同一个 jsdom 缺口只能有一份实现（' + C7_SETUP_IMPORT + '），本地再写一份就是又一处会漂移的副本');
    }
  }
  if (antdSites.includes(site) && !files.some((f) => f.st.includes(C7_SETUP_IMPORT))) {
    problems.push('C7② ' + site + ' 使用 antd（它同时依赖 matchMedia 与 ResizeObserver），但测试 setup 没有 import ' + C7_SETUP_IMPORT + '——实测 user 就是这样，8 个既有用例在接入 antd 的当天一起红，而报错指向完全无关的位置');
  }
}
info.push('C7 有测试 setup 的站点：' + c7setup.size + ' 个（' + [...c7setup.keys()].join(', ') + '）');

// ── C8 手写 <table> 存量（棘轮 + 收敛开关）──────────────────────────────
// §9 完成定义第 2 条写着「四站的表格由同一个 DataTable 渲染（user 不再有手写 table 标签）」。
// 在那之前它只是文档里的一句话 —— **没有任何东西在数手写表格还剩几个**，
// 于是「还剩几个」只能靠人去数，而人一忙就不数了。
// 判据与 C5 同一形状：存量只许减不许增；登记为已收敛的站点必须为 0。
const tableCounts = countHandwrittenTables();
const tableTotal = Object.values(tableCounts).reduce((a, b) => a + b, 0);
if (!antdRegistry) {
  problems.push('C8 缺少 verification/antd-entries.json —— 手写表格的存量要靠它记账（node scripts/check-consistency.mjs --write-registry）');
} else {
  const recorded = antdRegistry.handwrittenTablesBySite || {};
  for (const [site, n] of Object.entries(tableCounts)) {
    const was = recorded[site] || 0;
    if (n > was) {
      problems.push('C8 ' + site + ' 新增了手写 <table>（' + was + ' → ' + n + '）。表格一律走 @autional/ui/antd 的 DataTable：手写表要自己实现排序/分页/空态/加载态，而且必然与其余 portal 长得不一样。');
    } else if (n < was) {
      warns.push('C8 ' + site + ' 的手写 <table> 从 ' + was + ' 降到 ' + n + ' —— 这是进展，请跑 node scripts/check-consistency.mjs --write-registry 更新台账');
    }
  }
  for (const site of antdRegistry.tableConvergedSites || []) {
    if (!SITES_HAS(site)) { problems.push('C8 台账里的 tableConvergedSites 含不存在的站点「' + site + '」——拼错会让该站的闸门静默失效'); continue; }
    if ((tableCounts[site] || 0) > 0) {
      problems.push('C8 ' + site + ' 已登记为「表格已收敛」，但仍有 ' + tableCounts[site] + ' 个手写 <table> —— 登记与事实不符');
    }
  }
}
info.push('C8 手写 <table> 存量：' + tableTotal + ' 处，分布在 ' + Object.keys(tableCounts).length + ' 个站点' +
  (Object.keys(tableCounts).length ? '（' + Object.entries(tableCounts).map(([s, n]) => s + ' ' + n).join('、') + '）' : ''));

// ── C9 手写浮层存量（棘轮 + 收敛开关）────────────────────────────────────
// 「弹窗」是继表格、徽标之后第三处四个门户各写一遍的东西：每个页面自己拼
// fixed inset-0 遮罩 + rounded-xl border bg-white p-6 shadow-xl 卡片 + 手写标题栏，
// 于是 Esc 关闭、body 滚动锁、点击遮罩关闭这些**行为**有的做有的没做。
// 设计系统已经有 Modal（含 Esc 与滚动锁）；判据就是「别再自己拼」。
//
// 计的是**全屏浮层的迹象数**（fixed inset-0）。这个口径包含少数合法的全屏遮罩
// （例如移动端侧边栏背后那层），所以对它们不设「必须为 0」，
// 只做两件事：① 存量只许减不许增；② 登记进 overlayConvergedSites 的站点必须为 0。
// 判据口径必须说清楚 —— 一个会把合法用法算进去的数字，只能当棘轮用，不能当验收线。
const OVERLAY_MARK = /fixed\s+inset-0/g;
// 度量器正负控制：解析器失灵时棘轮会全绿，那比红危险。
{
  const pos = (('<div class="') + 'fixed inset-0 z-50' + ('">')).match(OVERLAY_MARK);
  const neg = 'fixed inset-x-0 bottom-0'.match(OVERLAY_MARK);
  if (!pos || pos.length !== 1 || neg) {
    problems.push('C9 度量器自检失败（正例 ' + (pos ? pos.length : 0) + ' 次、反例 ' + (neg ? neg.length : 0) + ' 次）——浮层计数解析器出错了，棘轮因此失去意义');
  }
}

function countHandwrittenOverlays() {
  // 与 countHandwrittenTables 同样的理由：本函数在写入台账时就会被调用，
  // 不能复用 C2 段的 stripComments（那时它还没初始化）。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  // 与 countHandwrittenTables 同理：本函数在**写入台账时**就会被调用，
  // 所以不能引用 C9 段顶部那个常量（那时还没初始化）—— 本轮的 TDZ 是第二次踩到（第一次是 C8）。
  const mark = /fixed\s+inset-0/g;
  const counts = {};
  for (const site of readdirSync(SITES)) {
    const sp = join(SITES, site);
    if (!statSync(sp).isDirectory()) continue;
    let n = 0;
    for (const f of walk(sp, [], (x) => /\.(tsx|jsx|astro)$/.test(x), SKIP)) {
      n += (strip(readFileSync(f, 'utf8')).match(mark) || []).length;
    }
    if (n) counts[site] = n;
  }
  return counts;
}

const overlayCounts = countHandwrittenOverlays();
const overlayTotal = Object.values(overlayCounts).reduce((a, b) => a + b, 0);
if (!antdRegistry) {
  problems.push('C9 缺少 verification/antd-entries.json —— 手写浮层的存量要靠它记账（node scripts/check-consistency.mjs --write-registry）');
} else {
  const recorded = antdRegistry.handwrittenOverlaysBySite || {};
  for (const [site, n] of Object.entries(overlayCounts)) {
    const was = recorded[site] || 0;
    if (n > was) {
      problems.push('C9 ' + site + ' 新增了手写全屏浮层（' + was + ' → ' + n + '）。弹窗走 @autional/ui 的 Modal：Esc 关闭、body 滚动锁、点击遮罩关闭这些行为不该由每个页面各自实现一遍。');
    } else if (n < was) {
      warns.push('C9 ' + site + ' 的手写浮层从 ' + was + ' 降到 ' + n + ' —— 这是进展，请跑 node scripts/check-consistency.mjs --write-registry 更新台账');
    }
  }
  for (const site of antdRegistry.overlayConvergedSites || []) {
    if (!SITES_HAS(site)) { problems.push('C9 台账里的 overlayConvergedSites 含不存在的站点「' + site + '」——拼错会让该站的闸门静默失效'); continue; }
    if ((overlayCounts[site] || 0) > 0) {
      problems.push('C9 ' + site + ' 已登记为「浮层已收敛」，但仍有 ' + overlayCounts[site] + ' 处手写全屏浮层 —— 登记与事实不符');
    }
  }
}
info.push('C9 手写浮层存量：' + overlayTotal + ' 处，分布在 ' + Object.keys(overlayCounts).length + ' 个站点' +
  (Object.keys(overlayCounts).length ? '（' + Object.entries(overlayCounts).map(([s, n]) => s + ' ' + n).join('、') + '）' : ''));

// ── C10 控制台页头（棘轮 + 收敛开关，D5）────────────────────────────────
// 度量器自检：解析器一旦失灵，棘轮会全绿 —— 那比红危险。
{
  const pos = ('<h1 class="' + 'text-xl font-semibold' + '">x</h1>').match(INLINE_H1_RE);
  const posCls = pos && pos.length === 1 ? (pos[0].match(/className="([^"]*)"/) || [, ''])[1] : '';
  const neg = ('<h1 class="' + 'text-2xl font-bold' + '">x</h1>').match(INLINE_H1_RE);
  const negCls = neg && neg.length === 1 ? (neg[0].match(/className="([^"]*)"/) || [, ''])[1] : '';
  const okPos = /\btext-xl\b/.test('text-xl font-semibold') && /\bfont-semibold\b/.test('text-xl font-semibold');
  const okNeg = /\btext-xl\b/.test('text-2xl font-bold') || /\bfont-semibold\b/.test('text-2xl font-bold');
  if (!pos || !neg || !okPos || okNeg || !/<PageHeader\b/.test('<PageHeader title="x" />') || /<PageHeader\b/.test('<AppPageHeader title="x" />')) {
    problems.push('C10 度量器自检失败（正例 ' + JSON.stringify(posCls) + ' / 反例 ' + JSON.stringify(negCls) + '）——页头计数解析器出错了，棘轮因此失去意义');
  }
}

const chCounts = countConsoleHeaders();
if (!existsSync(CONSOLE_HEADERS_PATH)) {
  problems.push('C10 verification/console-headers.json 缺失 —— 控制台页头的存量要靠它记账（node scripts/check-consistency.mjs --write-registry）');
} else {
  const chReg = JSON.parse(readFileSync(CONSOLE_HEADERS_PATH, 'utf8'));
  const LABEL = { inline: '页面自己写的 text-xl font-semibold 标题', marketing: '设计系统的营销 PageHeader' };
  for (const kind of ['inline', 'marketing']) {
    const recorded = chReg[kind] || {};
    const now = chCounts[kind] || {};
    for (const site of CONSOLE_SITES) {
      const was = recorded[site] || 0;
      const n = now[site] || 0;
      if (n > was) {
        problems.push('C10 ' + site + ' 新增了「' + LABEL[kind] + '」（' + was + ' → ' + n + '）。控制台的页头一律走 @autional/ui 的 AppPageHeader：一个产品里一半页面左对齐小标题、另一半居中大标题，正是这一条要消掉的东西。');
      } else if (n < was) {
        warns.push('C10 ' + site + ' 的「' + LABEL[kind] + '」从 ' + was + ' 降到 ' + n + ' —— 这是进展，请跑 node scripts/check-consistency.mjs --write-registry 更新台账');
      }
    }
  }
  for (const site of chReg.convergedSites || []) {
    if (!SITES_HAS(site)) { problems.push('C10 台账里的 convergedSites 含不存在的站点「' + site + '」——拼错会让该站的闸门静默失效'); continue; }
    for (const kind of ['inline', 'marketing']) {
      const n = (chCounts[kind] || {})[site] || 0;
      if (n > 0) problems.push('C10 ' + site + ' 已登记为「页头已收敛」，但仍有 ' + n + ' 处「' + LABEL[kind] + '」—— 登记与事实不符');
    }
  }
}
info.push('C10 控制台页头：inline ' + Object.values(chCounts.inline).reduce((a, b) => a + b, 0) + ' 处 / marketing ' + Object.values(chCounts.marketing).reduce((a, b) => a + b, 0) + ' 处（收敛目标是 0，改用 AppPageHeader）');

// ── C11 非设计系统色阶（棘轮 + 收敛开关）────────────────────────────────
{
  const pos = ('class="' + 'text-gray-500' + '"').match(PALETTE_RE);
  const neg = ('class="' + 'text-neutral-500' + '"').match(PALETTE_RE);
  const neg2 = ('class="' + 'text-primary-900' + '"').match(PALETTE_RE);
  if (!pos || pos.length !== 1 || neg || neg2) {
    problems.push('C11 度量器自检失败（正例 ' + (pos ? pos.length : 0) + ' 次、反例 ' + (neg ? neg.length : 0) + '/' + (neg2 ? neg2.length : 0) + ' 次）——非 DS 色阶计数解析器出错了，棘轮因此失去意义');
  }
}
const paletteCounts = countPaletteUsage();
if (!existsSync(PALETTE_PATH)) {
  problems.push('C11 verification/palette-usage.json 缺失 —— 非设计系统色阶的存量要靠它记账（node scripts/check-consistency.mjs --write-registry）');
} else {
  const pReg = JSON.parse(readFileSync(PALETTE_PATH, 'utf8'));
  const pRec = pReg.usage || {};
  let pTotal = 0;
  for (const [site, counts] of Object.entries(paletteCounts)) {
    const rec = pRec[site] || {};
    for (const [k, n] of Object.entries(counts)) {
      if (!LOCKED_CLASSES.includes(k)) pTotal += n;
      const was = rec[k] || 0;
      if (n > was) {
        problems.push('C11 ' + site + ' 新增了非设计系统色阶「' + k + '」（' + was + ' → ' + n + '）。设计系统的 preset 只定义 primary / sky / amber / neutral 四个色阶加语义色；Tailwind 出厂色阶能生成但没做过对比度验证，且会让同一个页面上并排出现两个几乎一样的灰。');
      } else if (n < was) {
        warns.push('C11 ' + site + ' 的「' + k + '」从 ' + was + ' 降到 ' + n + ' —— 这是进展，请跑 node scripts/check-consistency.mjs --write-registry 更新台账');
      }
    }
  }
  for (const site of pReg.coveredSites || []) {
    if (!SITES_HAS(site)) { problems.push('C11 台账里的 coveredSites 含不存在的站点「' + site + '」——拼错会让该站的闸门静默失效'); continue; }
    for (const k of pReg.closedKeys || []) {
      const n = (paletteCounts[site] || {})[k] || 0;
      if (n > 0) problems.push('C11 ' + site + ' 已登记为「' + k + ' 已收敛」，但仍有 ' + n + ' 处 —— 登记与事实不符');
    }
  }
  info.push('C11 非设计系统色阶：' + pTotal + ' 处，分布在 ' + Object.keys(paletteCounts).length + ' 个站点；已 closed 的键：' + ((pReg.closedKeys || []).join(' / ') || '无'));
}

// ── C12 手写卡片容器（硬零 + 设计系统那一份的规格）──────────────────────
// 「区块容器」是四站里最后一件形态各异的通用件：控制台 363 张 antd Card + 46 处 <SectionCard>，
// 而 user 门户 62 处手写 —— rounded-lg + border + bg-white + p-5/p-6 + shadow-sm 的排列组合有 27 种
// （其中 3 处还写着 `bg-card` 这个**根本不存在的类**，等于没有底色）。
// 收敛之后判据是硬零，不是棘轮：四站在册的手写卡片容器 = 0。
// 两边都验（同 H1/H2/C13 的形状）——站点侧干净了不等于设计系统那一份是对的：
//   ① 站点侧：源码里 0 处「中性面 + 边框 + rounded-lg」的手写容器；
//   ② DS 侧：SectionCard 必须落在设计系统的档位上（rounded-lg / border-subtle / bg-surface）。
// 第 30 轮实测：收敛后四站都是 0，所以这里可以是硬零而不是台账。
{
  const BT = String.fromCharCode(96);
  const SURFACES = ['bg-white', 'bg-card', 'bg-[var(--color-bg-surface)]'];
  const isHandCard = (cls) => {
    if (!SURFACES.some((s) => cls.includes(s))) return false;
    if (/bg-(info|danger|success|warning|amber|primary)-/.test(cls)) return false; // 着色提示块归 Alert 那一类，见 L20
    // 边框带语义色的同样排除：那 5 处是「结果/状态卡」（错误态、成功态、危险区），
    // 设计系统既没有 Alert 也没有带语义边框的卡片变体 —— 第一版迁移把这 5 处的边框色吃掉了，
    // 是回退时逐条比对才发现的：**判据的范围要跟着「设计系统有没有这个能力」走**。
    if (/border-(info|danger|success|warning|amber|primary)-/.test(cls)) return false;
    if (cls.includes('hover:') || cls.includes('animate-pulse') || cls.includes('absolute')) return false; // 可点行 / 骨架 / 浮层
    if (!cls.includes('rounded-lg')) return false;
    const toks = cls.split(/\s+/);
    if (!toks.includes('border') && !toks.some((t) => t.startsWith('border-'))) return false;
    return true;
  };
  // ── 度量器自检：正例必须命中、反例必须不命中（C11 同款）
  const selfPos = isHandCard('rounded-lg border border-neutral-200 bg-white p-6 shadow-sm');
  const selfNeg1 = isHandCard('rounded-lg border border-info-soft bg-info-soft p-4');
  const selfNeg2 = isHandCard('rounded-lg border border-neutral-200 bg-white p-4 hover:shadow-md');
  const selfNeg3 = isHandCard('rounded-lg border border-neutral-200 bg-white p-4');
  if (!selfPos || selfNeg1 || selfNeg2 || !selfNeg3) {
    problems.push('C12 度量器自检失败（正例 ' + (selfPos ? 1 : 0) + '、着色 ' + (selfNeg1 ? 1 : 0) + '、可点 ' + (selfNeg2 ? 1 : 0) + '、非卡片 ' + (selfNeg3 ? 0 : 1) + '）——手写卡片计数解析器出错了，硬零因此失去意义');
  }
  const CARD_RE = new RegExp('<div\\s+className=(?:"([^"]*)"|\\{' + BT + '([^' + BT + ']*)' + BT + '\\})', 'g');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
  let total = 0;
  const detail = [];
  for (const site of PORTALS.map((p) => p.site)) {
    if (!SITES_HAS(site)) continue;
    let n = 0;
    for (const file of walk(join(SITES, site), [], (x) => /\.(tsx|jsx)$/.test(x), SKIP)) {
      const t = strip(readFileSync(file, 'utf8'));
      CARD_RE.lastIndex = 0; let m;
      while ((m = CARD_RE.exec(t))) {
        const cls = (m[1] || m[2] || '').replace(/\s+/g, ' ').trim();
        if (isHandCard(cls)) { n++; detail.push(site + '/' + file.slice(join(SITES, site).length + 1).replace(/\\/g, '/') + ' :: ' + cls.slice(0, 70)); }
      }
    }
    total += n;
    if (n > 0) {
      problems.push('C12 ' + site + ' 里有 ' + n + ' 处手写卡片容器 —— 区块容器一律走设计系统的 <SectionCard>（它固定了圆角/边框/底色/阴影与内边距档位）。前几处：' + detail.slice(0, 3).join(' | '));
    }
  }
  const SECTION_CARD = join(ROOT, 'packages', 'ui', 'src', 'molecules', 'SectionCard.tsx');
  const sc = existsSync(SECTION_CARD) ? strip(readFileSync(SECTION_CARD, 'utf8')) : '';
  const scOk = /rounded-lg/.test(sc) && /border-\[var\(--color-border-subtle\)\]/.test(sc) && /bg-\[var\(--color-bg-surface\)\]/.test(sc);
  if (!scOk) {
    problems.push('C12 设计系统的 SectionCard 不满足卡片契约（' + SECTION_CARD.replace(/\\/g, '/') +
      ' 需要 rounded-lg + border-[var(--color-border-subtle)] + bg-[var(--color-bg-surface)]，且圆角要走 --radius-lg 这一档）—— 站点把卡片交给它之后，卡片契约就没有人满足了');
  }
  // ── 着色提示块（第 31 轮并入同一条判据）────────────────────────────────
  // Alert 落地之后，手写的着色提示块同样是硬零。判定范围**故意与 Alert 的能力对齐**：
  // 居中的结果卡、徽标、可点行、以及内边距不在 p-4 档的那些，都不是 Alert 能表达的东西
  // （设计系统还没有 Result / 带品牌色的提示块），它们登记在 L21 而不是被这条判据逼着改造。
  const isHandAlert = (cls) => {
    if (!/bg-(success|warning|danger|info)-soft\b/.test(cls) && !/\bbg-amber-50\b/.test(cls)) return false;
    if (cls.includes('text-center')) return false;
    if (cls.includes('rounded-full') || cls.includes('hover:')) return false;
    if (/\bh-(9|10|12|14|16|20)\b/.test(cls) && /\bw-(9|10|12|14|16|20)\b/.test(cls)) return false;
    if (/\bp-([368]|12)\b/.test(cls)) return false;
    return true;
  };
  const alertSelfPos = isHandAlert('rounded-lg border border-info-soft bg-info-soft p-4');
  const alertSelfNeg1 = isHandAlert('rounded-lg border border-success-soft bg-success-soft p-8 text-center');
  const alertSelfNeg2 = isHandAlert('flex h-10 w-10 items-center justify-center rounded-md bg-primary-50');
  const alertSelfNeg3 = isHandAlert('rounded-md border border-danger-soft bg-white p-6 shadow-sm');
  if (!alertSelfPos || alertSelfNeg1 || alertSelfNeg2 || alertSelfNeg3) {
    problems.push('C12 提示块度量器自检失败 —— 正例/反例判定错了，硬零因此失去意义');
  }
  let alerts = 0;
  const alertDetail = [];
  for (const site of PORTALS.map((p) => p.site)) {
    if (!SITES_HAS(site)) continue;
    let n = 0;
    for (const file of walk(join(SITES, site), [], (x) => /\.(tsx|jsx)$/.test(x), SKIP)) {
      const t = strip(readFileSync(file, 'utf8'));
      CARD_RE.lastIndex = 0; let m;
      while ((m = CARD_RE.exec(t))) {
        const cls = (m[1] || m[2] || '').replace(/\s+/g, ' ').trim();
        if (!isHandAlert(cls)) continue;
        // 必须真的有文字，否则那是图标徽标之类
        const tail = t.slice(m.index, t.indexOf('</div>', m.index) + 6);
        if (!(/>[^<>{}]{2,}</.test(tail) || /\{t\(/.test(tail))) continue;
        n++;
        alertDetail.push(site + '/' + file.slice(join(SITES, site).length + 1).replace(/\\/g, '/') + ' :: ' + cls.slice(0, 60));
      }
    }
    alerts += n;
    if (n > 0) {
      problems.push('C12 ' + site + ' 里有 ' + n + ' 处手写着色提示块 —— 提示一律走设计系统的 <Alert>（它固定了 -soft/-text 配对与边框）。前几处：' + alertDetail.slice(0, 3).join(' | '));
    }
  }
  const ALERT_SRC = join(ROOT, 'packages', 'ui', 'src', 'molecules', 'Alert.tsx');
  const aSrc = existsSync(ALERT_SRC) ? strip(readFileSync(ALERT_SRC, 'utf8')) : '';
  // 判据钉在**那一处表达式**上：第一版写的是「文件里能找到 SOFT_TEXT[variant] 与 SOFT_BORDER[variant]」，
  // 阳性对照当场证明它不成立 —— 把 surface 那一行换成裸的 bg-danger-soft 之后闸门照样绿，
  // 因为别处（textTone / badgeCls）还留着 SOFT_TEXT[variant]。与 H2 那次同型：**判据要落在它要说的那个元素上**。
  const PAIR = 'SOFT_TEXT[variant]} ${SOFT_BORDER[variant]';
  const alertOk = aSrc.includes(PAIR);
  if (!alertOk) {
    problems.push('C12 设计系统的 Alert 不满足提示契约（' + ALERT_SRC.replace(/\\/g, '/') +
      ' 必须用 internal/semantic-styles 的 SOFT_TEXT / SOFT_BORDER 配对，而不是自己写一套 bg-X / text-X）—— 站点把提示交给它之后，对比度契约就没有人满足了');
  }
  // ── 结果块（第 32 轮并入同一条判据）────────────────────────────────────
  // 与 Result 的能力对齐：居中的、圆角的、有底色（白面或同色浅底）、内边距在 p-6/p-8 档的那些。
  const isHandResult = (cls) => {
    if (!cls.includes('text-center')) return false;
    if (!/rounded-(lg|md)\b/.test(cls)) return false;
    if (!/(bg-white|bg-(success|warning|danger|info)-soft)\b/.test(cls)) return false;
    if (!/\bp-[68]\b/.test(cls)) return false;
    if (cls.includes('hover:')) return false;
    return true;
  };
  const resultSelfPos = isHandResult('rounded-lg border border-success-soft bg-white p-6 shadow-sm text-center');
  const resultSelfPos2 = isHandResult('rounded-lg border border-success-soft bg-success-soft p-8 text-center shadow-sm');
  const resultSelfNeg = isHandResult('rounded-lg border border-danger-soft bg-white p-6 shadow-sm');
  if (!resultSelfPos || !resultSelfPos2 || resultSelfNeg) {
    problems.push('C12 结果块度量器自检失败 —— 硬零因此失去意义');
  }
  let results = 0;
  const resultDetail = [];
  for (const site of PORTALS.map((p) => p.site)) {
    if (!SITES_HAS(site)) continue;
    let n = 0;
    for (const file of walk(join(SITES, site), [], (x) => /\.(tsx|jsx)$/.test(x), SKIP)) {
      const t = strip(readFileSync(file, 'utf8'));
      CARD_RE.lastIndex = 0; let m;
      while ((m = CARD_RE.exec(t))) {
        const cls = (m[1] || m[2] || '').replace(/\s+/g, ' ').trim();
        if (!isHandResult(cls)) continue;
        n++;
        resultDetail.push(site + '/' + file.slice(join(SITES, site).length + 1).replace(/\\/g, '/') + ' :: ' + cls.slice(0, 60));
      }
    }
    results += n;
    if (n > 0) {
      problems.push('C12 ' + site + ' 里有 ' + n + ' 处手写结果块 —— 结果块一律走设计系统的 <Result>（居中的图标 + 标题 + 说明 + 一个动作）。前几处：' + resultDetail.slice(0, 3).join(' | '));
    }
  }
  const RESULT_SRC = join(ROOT, 'packages', 'ui', 'src', 'molecules', 'Result.tsx');
  const rSrc = existsSync(RESULT_SRC) ? strip(readFileSync(RESULT_SRC, 'utf8')) : '';
  const resultOk = rSrc.includes(PAIR);
  if (!resultOk) {
    problems.push('C12 设计系统的 Result 不满足结果块契约（' + RESULT_SRC.replace(/\\/g, '/') +
      ' 必须用 internal/semantic-styles 的 SOFT_TEXT / SOFT_BORDER 配对）—— 站点把结果块交给它之后，对比度契约就没有人满足了');
  }
  info.push('C12 手写容器：卡片 ' + total + ' 处 · 着色提示块 ' + alerts + ' 处 · 结果块 ' + results + ' 处（四站在册，判据是硬零）');
}
// ── 已知问题登记（与其它检查同一套约定）────────────────────────────────
// R8 修复：原为 /^(C\d)/ ⇒ 只取一位数字，C10/C11/C12 会被截成 C1 ⇒ 「C10 及以后的 finding 永远无法登记」。
const codeOf = (msg) => { const m = /^(C\d+)/.exec(msg); return m ? m[1] : null; };
const knownFor = (msg) => { const c = codeOf(msg); return c ? known.find((k) => k.code === c && msg.indexOf(k.match) >= 0) : undefined; };
const suppressed = [];
const active = [];
for (const msg of problems) {
  const k = knownFor(msg);
  if (k) suppressed.push({ msg, issue: k }); else active.push(msg);
}
const expired = [];
for (const k of known) {
  if (!/^C\d/.test(k.code)) continue;
  for (const f of ['id', 'code', 'match', 'reason', 'owner', 'expires']) {
    if (!k[f]) active.push('C9 known-issue:' + (k.id || '?') + ' 缺少字段 ' + f);
  }
  if (k.expires && k.expires < TODAY) expired.push('C9 登记 ' + k.id + ' 已过期（' + k.expires + '）：要么修掉，要么重新评估并续期');
}
for (const e of expired) active.push(e);

if (AS_JSON) {
  console.log(JSON.stringify({ errors: active.length, warnings: warns.length, suppressed: suppressed.length, active, warns, suppressed, info }, null, 2));
} else {
  console.log('视觉一致性检查：站点 ' + readdirSync(SITES).filter((s) => statSync(join(SITES, s)).isDirectory()).length + ' 个');
  for (const i of info) console.log('  [INFO ] ' + i);
  for (const w of warns) console.log('  [WARN ] ' + w);
  for (const a of active) console.log('  [ERROR] ' + a);
  for (const sp of suppressed) console.log('  [KNOWN] ' + sp.msg.slice(0, 100) + '  已登记为 ' + sp.issue.id + '（owner ' + sp.issue.owner + '，到期 ' + sp.issue.expires + '）');
  console.log('');
  console.log(active.length === 0
    ? '结论：视觉一致性检查通过（' + warns.length + ' 警告，' + suppressed.length + ' 条已登记）'
    : '结论：视觉一致性检查失败（' + active.length + ' 错误，' + suppressed.length + ' 条已登记）');
}
process.exit(active.length === 0 ? 0 : 1);
