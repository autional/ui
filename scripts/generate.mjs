#!/usr/bin/env node
/**
 * Autional design-system generator.
 *
 * Reads tokens/tokens.json (the single source of truth) and emits every
 * generated artifact into packages/. Generated files are committed.
 *
 * Usage:
 *   node scripts/generate.mjs           # write artifacts
 *   node scripts/generate.mjs --check   # verify on-disk artifacts, exit 1 on drift
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const TOKENS = JSON.parse(readFileSync(join(ROOT, 'tokens/tokens.json'), 'utf8'));
const VERSION = TOKENS.$meta.version;

const outputs = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const GENERATED = (source) =>
  `GENERATED FILE — DO NOT EDIT. Source: ${source} · Regenerate: pnpm gen · v${VERSION}`;

const isRef = (v) => typeof v === 'string' && /^\{[^}]+\}$/.test(v);
const refPath = (v) => v.slice(1, -1).split('.');
// CSS 自定义属性名必须是合法 ident：`.` 不允许出现在标识符里。
// 2026-11-03 线上事故：`space.0.5` → `--space-0.5`，Tailwind 3（postcss）宽容跳过该声明，
// 但 Tailwind 4 的 Lightning CSS 直接**丢弃整条 `:root` 规则** —— 整个色板随之消失
// （web 站没有 profile 兜底，整站失色）。非 [A-Za-z0-9_-] 一律折成 `-`。
const safeSegment = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '-');
const varName = (path) => `--${path.map(safeSegment).join('-')}`;

const cssValue = (v) => {
  if (typeof v === 'string') return isRef(v) ? `var(${varName(refPath(v))})` : v;
  throw new Error(`Unsupported token value: ${JSON.stringify(v)}`);
};

/** `#rrggbb` → `r g b` 通道三元组（浏览器 space-separated rgb() 语法）。 */
function rgbTriplet(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Expected #rrggbb, got ${JSON.stringify(hex)}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
}

/**
 * `-rgb` 伴随值：同一颜色的通道三元组表达。每个颜色变量都配一份，让 Tailwind 的
 * 透明度修饰符路径（parseColor loose → `rgb(<channels> / N)`）有可解析的通道。
 * ref → 指向目标伴随变量；var()-fallback 链 → 每个 var 名补 `-rgb`；字面 hex → 现算。
 * 其它形态在生成期直接报错（失败要响，不静默降级成死类）。
 */
function rgbCompanion(v) {
  if (isRef(v)) {
    const path = refPath(v);
    if (path[0] !== 'color') throw new Error(`Color ref out of the color namespace: ${v}`);
    return `var(${varName(path)}-rgb)`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return rgbTriplet(v);
  if (v.includes('var(')) return v.replace(/(--[a-zA-Z0-9-]+)/g, '$1-rgb');
  throw new Error(`Unsupported color value for -rgb companion: ${JSON.stringify(v)}`);
}

const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'cursive', 'fantasy']);
const cssFontStack = (stack) =>
  stack.map((f) => (GENERIC_FAMILIES.has(f) || !/[\s\d]/.test(f) ? f : `'${f}'`)).join(', ');

/**
 * Emit CSS custom properties for one namespace-keyed object (`$` keys skipped).
 * 色树（ns === 'color'）的每个变量额外发一份 `-rgb` 通道三元组伴随变量
 * （见 rgbCompanion）——preset 的 `rgb(var(--color-X-rgb))` 形态依赖它。
 * 伴随变量有变体/profile 的分区时跟随 base 变量走同一代码路径，天然同构。
 */
function emitVars(tree, indent = '  ') {
  const lines = [];
  const space = ' '.repeat(indent);
  for (const [ns, group] of Object.entries(tree)) {
    if (ns.startsWith('$')) continue;
    lines.push(`${space}/* ── ${ns} ── */`);
    if (ns === 'font') {
      for (const [k, v] of Object.entries(group)) {
        if (k.startsWith('$')) continue;
        lines.push(`${space}--font-${k}: ${cssFontStack(v)};`);
      }
    } else if (ns === 'font-size') {
      for (const [k, v] of Object.entries(group)) {
        if (k.startsWith('$')) continue;
        lines.push(`${space}--font-size-${k}: ${v.size};`);
        if (v.lineHeight) lines.push(`${space}--line-height-${k}: ${v.lineHeight};`);
        if (v.fontWeight) lines.push(`${space}--font-weight-${k}: ${v.fontWeight};`);
        if (v.letterSpacing) lines.push(`${space}--letter-spacing-${k}: ${v.letterSpacing};`);
      }
    } else {
      for (const [k, v] of Object.entries(group)) {
        if (k.startsWith('$')) continue;
        if (v !== null && typeof v === 'object') {
          for (const [k2, v2] of Object.entries(v)) {
            if (k2.startsWith('$')) continue;
            lines.push(`${space}${varName([ns, k, k2])}: ${cssValue(v2)};`);
            if (ns === 'color') lines.push(`${space}${varName([ns, k, k2])}-rgb: ${rgbCompanion(v2)};`);
          }
        } else {
          lines.push(`${space}${varName([ns, k])}: ${cssValue(v)};`);
          if (ns === 'color') lines.push(`${space}${varName([ns, k])}-rgb: ${rgbCompanion(v)};`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** Resolve `{a.b.c}` chains against layered contexts (later layers win). */
function makeResolver(layers) {
  const lookup = (path) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      let node = layers[i];
      let ok = node !== undefined;
      for (const seg of path) {
        if (node !== null && typeof node === 'object' && seg in node) node = node[seg];
        else { ok = false; break; }
      }
      if (ok) return node;
    }
    return undefined;
  };
  const resolve = (value, depth = 0) => {
    if (depth > 16) throw new Error(`Reference cycle at ${JSON.stringify(value)}`);
    if (typeof value !== 'string' || !isRef(value)) return value;
    const raw = lookup(refPath(value));
    if (raw === undefined) throw new Error(`Unresolved reference ${value}`);
    return resolve(raw, depth + 1);
  };
  return { resolve, raw: (path) => lookup(path) };
}

/** Pretty-print a JS value as an ES5 object literal (single quotes, 2-space). */
// Exact structural type for the emitted tokens.json, so consumers can index
// e.g. `tokens.core.color.primary['700']` without casting.
function tsType(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    const members = [...new Set(value.map((v) => tsType(v, 0)))];
    return `(${members.join(' | ')})[]`;
  }
  if (value !== null && typeof value === 'object') {
    if (Object.keys(value).length === 0) return 'Record<string, never>';
    const inner = Object.entries(value)
      .map(([k, v]) => `${pad}  ${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${tsType(v, indent + 1)};`)
      .join('\n');
    return `{\n${inner}\n${pad}}`;
  }
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

// String literals that contain an apostrophe (e.g. CSS font stacks) are emitted
// with double quotes so the generated JS stays parseable.
function jsStr(value) {
  return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
}

function js(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === 'string' ? jsStr(v) : js(v, indent))).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const inner = Object.entries(value)
      .map(([k, v]) => {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : jsStr(k);
        return `${pad}  ${key}: ${js(v, indent + 1)}`;
      })
      .join(',\n');
    return `{\n${inner}\n${pad}}`;
  }
  if (typeof value === 'string') return jsStr(value);
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// tokens.css (+ profile stylesheets)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_LAYER = `@layer base {
  html {
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    background-color: var(--color-bg-primary);
    color: var(--color-text-primary);
    margin: 0;
  }
  :focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring-color);
    outline-offset: var(--focus-ring-offset);
  }
}`;

const REDUCED_MOTION = `@media (prefers-reduced-motion: reduce) {
  *,
  ::before,
  ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}`;

// ── 品牌正文字体 Inter（拉丁）─────────────────────────────────────────────
// 实测（2026-09）：ASTRYX_MANIFEST 与 DESIGN.md 都声明「Latin is self-hosted Inter
// (@fontsource)」，但 ui/ 内 @font-face 声明数为 0、14 个站点里只有 2 个装了 @fontsource ——
// 声明与交付不一致，浏览器直接回退到系统字体（KI-007）。
// 现在字体随 tokens.css 一起分发：这里是相对路径，消费方的打包器会把它复制进产物。
// 用可变字体而不是 5 个静态字重：一份 47KB 覆盖 wght 100–900，静态五档约 115KB。
// Inter 为 SIL OFL 1.1，允许再分发；许可证随字体放在 fonts/LICENSE-Inter-OFL.txt。
const FONT_FACE = `@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('./fonts/inter-latin-wght-normal.woff2') format('woff2');
}`;
function themeBlock(selector, body) {
  return `${selector} {\n${body}\n}`;
}

function selectorFor(name) {
  return name === 'dark' ? '.dark,\n[data-theme="dark"]' : `[data-theme="${name}"]`;
}

function blockBody(node) {
  const parts = [];
  if (node.$colorScheme) parts.push(`  color-scheme: ${node.$colorScheme};`);
  if (node.color || node.focus) {
    parts.push(emitVars({ ...(node.color ? { color: node.color } : {}), ...(node.focus ? { focus: node.focus } : {}) }));
  }
  return parts.join('\n\n');
}

const variantBlocks = [];
// Cascade order is deliberate and must mirror the legacy tokens.css:
// [data-theme=portal|auth] set light-surface overrides and must LOSE to .dark;
// [data-theme=authenticator] is dark-first and must WIN over .dark.
const VARIANT_ORDER = ['portal', 'auth', 'dark', 'authenticator'];
const allVariants = { ...TOKENS.variants, dark: TOKENS.modes.dark };
// ── $extends：变体可以继承另一个变体的完整令牌集 ──
// authenticator 是「dark + 10 处覆盖」。此前只写那 10 条，导致单独应用
// [data-theme=authenticator] 而不带 .dark 时，未覆盖的键回落到 core 的浅色值，
// 形成深色底 + 浅色文字的坏混合（KI-005）。展开后其块自带 dark 的全部值，可独立成立。
// 注：scripts/lib/tokens.mjs 的 variantMap 有一份同构实现，必须与此保持一致。
function resolveVariantExtends(name, seen) {
  const node = allVariants[name];
  if (!node || typeof node !== 'object') return node;
  const parent = node.$extends;
  if (!parent) return node;
  seen = seen || new Set([name]);
  if (seen.has(parent)) throw new Error('变体 $extends 成环：' + name + ' -> ' + parent);
  if (!allVariants[parent]) throw new Error('变体「' + name + '」的 $extends 指向不存在的变体「' + parent + '」');
  seen.add(parent);
  const base = resolveVariantExtends(parent, seen) || {};
  const out = { ...base };
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    const isGroup = v && typeof v === 'object' && !Array.isArray(v);
    // 必须返回对象本身：`base[k] && typeof base[k]==='object' && !Array.isArray(base[k])` 求值为 true，
    // 那样 { ...true, ...v } 只会得到 v —— 静默失效。
    const baseGroup = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? base[k] : null;
    out[k] = isGroup && baseGroup ? { ...baseGroup, ...v } : v;
  }
  for (const [k, v] of Object.entries(node)) if (k.startsWith('$')) out[k] = v;
  return out;
}
const ordered = [
  ...VARIANT_ORDER.filter((n) => allVariants[n]),
  ...Object.keys(allVariants).filter((n) => !VARIANT_ORDER.includes(n)),
];
for (const name of ordered) {
  const node = resolveVariantExtends(name);
  if (node.$kind === 'runtime') continue;
  variantBlocks.push(themeBlock(selectorFor(name), blockBody(node)));
}

// CSS artifacts live at package-root paths (not dist/) because postcss-import does
// not read the `exports` map — consumers resolve them as plain files through node_modules.
outputs.set(
  'packages/tokens/tokens.css',
  `/**\n * Autional Design Tokens — ${GENERATED('tokens/tokens.json')}\n */\n\n` +
    FONT_FACE +
    '\n\n' +
    themeBlock(':root', emitVars(TOKENS.core)) +
    '\n\n' +
    BASE_LAYER +
    '\n\n' +
    variantBlocks.join('\n\n') +
    '\n\n' +
    REDUCED_MOTION +
    '\n',
);

// ── KI-001：profile 的语义覆盖不能压掉深色变体 ──────────────────────────
// profiles/X.css 在 tokens.css 之后加载，同为 0,1,0 特指度时源码顺序靠后者胜，
// 于是 profile 的 :root 会把 .dark / [data-theme=authenticator] 的覆盖压掉。
// 实测：docs 深色下 --color-border-subtle 生效 #d1e5f2（近白），本应 #1a4a65。
// 修法：把「与深色变体同名变量」的声明单独放进一个排除深色上下文的块——
// 浅色下它照常匹配并覆盖 :root；深色下不匹配，深色变体自然胜出。
// 排除列表由变体的 $colorScheme 自动推导，将来新增深色变体无需手改这里。
const darkSchemeVars = new Set();
const darkExclusions = [];
for (const vname of ordered) {
  const vnode = resolveVariantExtends(vname);
  if (!vnode || vnode.$kind === 'runtime' || vnode.$colorScheme !== 'dark') continue;
  for (const m of blockBody(vnode).matchAll(/(--[a-z0-9-]+)\s*:/g)) darkSchemeVars.add(m[1]);
  for (const sel of selectorFor(vname).split(',')) darkExclusions.push(':not(' + sel.trim() + ')');
}
const darkGuard = darkExclusions.join('');

function partitionProfile(profile, darkVars) {
  const base = {};
  const restricted = {};
  for (const [ns, group] of Object.entries(profile)) {
    if (ns.startsWith('$') || group === null || typeof group !== 'object') continue;
    for (const [k, v] of Object.entries(group)) {
      if (k.startsWith('$')) continue;
      if (v !== null && typeof v === 'object') {
        const a = {};
        const b = {};
        for (const [k2, v2] of Object.entries(v)) {
          if (k2.startsWith('$')) continue;
          (darkVars.has(varName([ns, k, k2])) ? a : b)[k2] = v2;
        }
        if (Object.keys(a).length) (restricted[ns] = restricted[ns] || {})[k] = a;
        if (Object.keys(b).length) (base[ns] = base[ns] || {})[k] = b;
      } else {
        const target = darkVars.has(varName([ns, k])) ? restricted : base;
        (target[ns] = target[ns] || {})[k] = v;
      }
    }
  }
  return { base, restricted };
}

for (const [name, profile] of Object.entries(TOKENS.profiles)) {
  const hasOverrides = Object.keys(profile).some((k) => !k.startsWith('$'));
  if (!hasOverrides) continue;
  const { base, restricted } = partitionProfile(
    Object.fromEntries(Object.entries(profile).filter(([k]) => !k.startsWith('$'))),
    darkSchemeVars,
  );
  const blocks = [];
  if (Object.keys(base).length) blocks.push(themeBlock(':root', emitVars(base)));
  if (Object.keys(restricted).length) {
    blocks.push(themeBlock(darkGuard ? ':root' + darkGuard : ':root', emitVars(restricted)));
  }
  outputs.set(
    `packages/tokens/profiles/${name}.css`,
    `/**\n * Autional profile: ${name} — ${GENERATED('tokens/tokens.json')}\n * Load AFTER @autional/tokens/tokens.css.\n */\n\n${blocks.join('\n\n')}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens package: data + typed entry + antd bridge + chart colors
// ─────────────────────────────────────────────────────────────────────────────

outputs.set('packages/tokens/dist/tokens.json', JSON.stringify(TOKENS, null, 2) + '\n');

outputs.set(
  'packages/tokens/dist/index.js',
  `'use strict';\n/** ${GENERATED('tokens/tokens.json')} */\nmodule.exports = require('./tokens.json');\n`,
);

outputs.set(
  'packages/tokens/dist/index.d.ts',
  `/** ${GENERATED('tokens/tokens.json')} */\n` +
    `declare const tokens: ${tsType(TOKENS, 0)};\n` +
    `export = tokens;\n`,
);

const light = makeResolver([TOKENS.core]);
const dark = makeResolver([TOKENS.core, TOKENS.modes.dark]);
const pixel = (v) => (typeof v === 'string' && /^\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : v);

const antdToken = (ctx) => ({
  colorPrimary: ctx.resolve('{color.brand-base}'),
  colorSuccess: ctx.resolve('{color.success}'),
  colorWarning: ctx.resolve('{color.warning}'),
  colorError: ctx.resolve('{color.danger}'),
  colorInfo: ctx.resolve('{color.info}'),
  colorBgContainer: ctx.resolve('{color.bg-surface}'),
  colorBgElevated: ctx.resolve('{color.bg-elevated}'),
  colorText: ctx.resolve('{color.text-primary}'),
  // KI-015：antd 的 colorTextSecondary / colorTextDescription **没有**默认吃到 colorText，
  // 它俩是拿 colorText 按透明度派生的 —— #003153 @45% → #8a8a8b，对白底 3.33:1，不到 AA。
  // admin-console 的 404 / 403 页（antd Result 组件的 .ant-result-subtitle）实测就是这样。
  // 设计系统里早就有对应角色，只是桥没接：colorTextSecondary ← text-secondary，
  // colorTextDescription ← text-muted。派生值必须被显式覆盖，否则改令牌传导不到这里。
  colorTextSecondary: ctx.resolve('{color.text-secondary}'),
  colorTextDescription: ctx.resolve('{color.text-muted}'),
  borderRadius: pixel(ctx.resolve('{radius.sm}')),
  fontFamily: cssFontStack(TOKENS.core.font.sans),
});

// 组件级主题。它解决的是「同一张表在四个门户里长得不一样」——
// 而**放在这里而不是放在某个 DataTable 组件里**是刻意的：
//   组件级 token 一旦由 ConfigProvider 下发，**所有** antd Table 都会吃到它，
//   包括控制台现存的 156 处直接使用（它们一行代码都不用改）。
//   若把视觉收在自研 DataTable 里，只有换用它的地方才统一 —— 覆盖面小一个数量级。
//
// 只覆盖「视觉维度」（表头底色 / 悬浮态 / 边框 / 行高），**不碰任何行为 props**：
//   columns / rowKey / pagination / scroll / onRow / rowSelection / expandable / sticky / tableLayout
//   全部照旧透传。这条边界就是 §3.1 的薄透传契约。
const antdComponents = (ctx) => ({
  Table: {
    headerBg: ctx.resolve('{color.bg-muted}'),
    headerColor: ctx.resolve('{color.text-primary}'),
    headerSplitColor: ctx.resolve('{color.border-subtle}'),
    rowHoverBg: ctx.resolve('{color.bg-muted}'),
    borderColor: ctx.resolve('{color.border-subtle}'),
    // ⚠ cellPaddingBlock / cellPaddingInline 是 **large 尺寸** 的取值，
    // middle / small 走的是 ...MD / ...SM 两组（见 antd es/table/style/index.d.ts）。
    // 实测踩到：只写前两个时它们**完全不起作用** —— DS 的 DataTable 默认 size='middle'，
    // 读的是 cellPaddingBlockMD，于是这两行是一条静默失效的配置：
    // 浏览器里量到的仍是 antd 出厂的 12px，而看不出来任何异常（真正的「配了等于没配」）。
    cellPaddingBlock: 10,
    cellPaddingInline: 12,
    cellPaddingBlockMD: 10,
    cellPaddingInlineMD: 12,
    // SM 刻意**不设**：控制台有 400+ 处 size="small"，改它等于一次性改掉那些表的密度 ——
    // 那是一个该被单独看见、单独评审的设计决定，不该夹在「修一个静默失效」里顺手做掉。
  },
  // L19 卡片边框色三值并存。antd 的 Card 边框走 antd 出厂的 `colorBorderSecondary`
  // （近白灰 #f0f0f0），而设计系统的 `SectionCard` 走 `--color-border-subtle`
  // （primary-200 / #a3c7e3）。控制台一个页面里**两种卡片并排出现**（363 张 antd Card +
  // 46 处 SectionCard），边框色却不是一个 —— 这是「看起来不像同一个产品」里最容易被眼睛
  // 抓到的一处。
  // 方向是**站点跟着设计系统走**（令牌是 SSOT），而不是把设计系统改成 antd 的出厂值。
  // 只覆盖 Card 这一个组件：全局 `colorBorderSecondary` 会连带改掉 Divider / Table /
  // Select / Descriptions 等**所有**吃这个令牌的组件 —— 那是一次没人评审过的全舰队换色，
  // 不属于「卡片边框收敛」这一批的内容。
  // ⚠ 组件级 token 有「配了等于没配」的先例（见上面 cellPaddingBlockMD）：这一条**必须**在
  // 浏览器里量到 antd Card 的真实边框色才算数，静态断言不算。
  Card: {
    colorBorderSecondary: ctx.resolve('{color.border-subtle}'),
  },
  // KI-016 / KI-017：控制台侧栏**选中态**的底色与文字。
  // 此前桥里没有 Menu 的任何组件级 token ⇒ antd 自己从 colorPrimary 推导选中底色，
  // 实测推导出 rgb(133,144,148)（一个与品牌色无关的灰蓝），#003153 铺上去只有 **4.1:1** ——
  // platform / admin 两个控制台的外壳目标页（第 53 轮加的取景框）首跑就被 check-contrast 报红。
  // 方向与 L19 一致：**站点跟着设计系统走**，用设计系统的「柔和容器档」配对
  // （primary-soft × brand-text，两对都已进 verification/contrast-pairs.json 由 T08 复算）。
  // 与 Card 同理**只覆盖 Menu 这一个组件**：全局 colorPrimaryBg / colorPrimary 会连带改掉
  // Select / Tabs / Dropdown / Steps 等所有吃它的组件 —— 那是另一次该单独评审的全舰队换色。
  // ⚠ 组件级 token 有「配了等于没配」的先例（见上面 cellPaddingBlockMD）：这一条同样**必须**
  // 在浏览器里量到 antd Menu 的真实计算样式才算数，静态断言不算。
  Menu: {
    itemSelectedBg: ctx.resolve('{color.primary-soft}'),
    itemSelectedColor: ctx.resolve('{color.brand-text}'),
  },
});

outputs.set(
  'packages/tokens/dist/antd-theme.js',
  `'use strict';\n/** ${GENERATED('tokens/tokens.json')}\n *\n * antd v5/v6 ThemeConfig bridge. Usage:\n *   const antdToken = require('@autional/tokens/antd-theme');\n *   <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,\n *                            token: (isDark ? antdToken.dark : antdToken.light).token }}>\n */\n` +
    `module.exports = {\n  light: { token: ${js(antdToken(light), 1)}, components: ${js(antdComponents(light), 2)} },\n  dark: { token: ${js(antdToken(dark), 1)}, components: ${js(antdComponents(dark), 2)} },\n};\n`,
);

// ESM 变体：站点侧的应用是 ESM（package.json "type": "module"），而上面的 .js 是 CJS。
// 用 .mjs 后缀消除歧义（不依赖消费方的 package type），再由 sync:consumers 下发给站点。
outputs.set(
  'packages/tokens/dist/antd-theme.mjs',
  `/** ${GENERATED('tokens/tokens.json')}
 *
 * antd v5/v6 ThemeConfig bridge (ESM). Usage:
 *   import antdTheme from '@autional/tailwind-preset/antd-theme.mjs';
 *   <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
 *                            token: (isDark ? antdTheme.dark : antdTheme.light).token }}>
 *
 * 由 pnpm sync:consumers 下发到各站点的 packages/tailwind-preset/。
 * 控制台不得再手写这些色值——手写会让令牌变更无法传导，各 portal 各自漂移（KI-011）。
 */
const antdTheme = {
  light: { token: ${js(antdToken(light), 1)}, components: ${js(antdComponents(light), 2)} },
  dark: { token: ${js(antdToken(dark), 1)}, components: ${js(antdComponents(dark), 2)} },
};
export default antdTheme;
export const light = antdTheme.light;
export const dark = antdTheme.dark;
`,
);

// .d.mts：TypeScript 对 .mjs 的声明查找规则要求同名的 .d.mts（.d.ts 在 moduleResolution
// 为 bundler/node16 时不会命中 .mjs），所以两份都产出，内容相同。
outputs.set(
  'packages/tokens/dist/antd-theme.d.mts',
  `/** ${GENERATED('tokens/tokens.json')} */\n` +
    `declare const antdTheme: {\n` +
    `  light: { token: Record<string, string | number>; components: Record<string, Record<string, string | number>> };\n` +
    `  dark: { token: Record<string, string | number>; components: Record<string, Record<string, string | number>> };\n` +
    `};\n` +
    `export default antdTheme;\n` +
    `export declare const light: { token: Record<string, string | number>; components: Record<string, Record<string, string | number>> };\n` +
    `export declare const dark: { token: Record<string, string | number>; components: Record<string, Record<string, string | number>> };\n`,
);

outputs.set(
  'packages/tokens/dist/antd-theme.d.ts',
  `/** ${GENERATED('tokens/tokens.json')} */\n` +
    `declare const antdTheme: {\n` +
    `  light: { token: Record<string, string | number>; components: Record<string, Record<string, string | number>> };\n` +
    `  dark: { token: Record<string, string | number>; components: Record<string, Record<string, string | number>> };\n` +
    `};\n` +
    `export = antdTheme;\n`,
);

const chartColors = {};
for (const [k, v] of Object.entries(TOKENS.core.color.chart)) {
  if (!k.startsWith('$')) chartColors[k] = light.resolve(v);
}
const methodColors = {};
for (const [k, v] of Object.entries(TOKENS.core.color.method)) {
  if (!k.startsWith('$')) methodColors[k] = light.resolve(v);
}
outputs.set(
  'packages/tokens/dist/chart.js',
  `'use strict';\n/** ${GENERATED('tokens/tokens.json')}\n *\n * Literal color values for chart libraries that need real hex strings.\n * Status-like series should use the semantic group, not the chart group.\n */\n` +
    `module.exports = {\n  chart: ${js(chartColors, 1)},\n  method: ${js(methodColors, 1)},\n  semantic: {\n    success: ${js(light.resolve('{color.success}'))},\n    warning: ${js(light.resolve('{color.warning}'))},\n    danger: ${js(light.resolve('{color.danger}'))},\n    info: ${js(light.resolve('{color.info}'))},\n  },\n};\n`,
);

outputs.set(
  'packages/tokens/dist/chart.d.ts',
  `/** ${GENERATED('tokens/tokens.json')} */\n` +
    `declare const chart: {\n` +
    `  chart: Record<string, string>;\n` +
    `  method: Record<string, string>;\n` +
    `  semantic: Record<string, string>;\n` +
    `};\n` +
    `export = chart;\n`,
);

// ─────────────────────────────────────────────────────────────────────────────
// Tailwind preset package
// ─────────────────────────────────────────────────────────────────────────────

// syntax 是第 62 轮加的：与 chart 同构的「角色色」——品牌色阶按定义表达不了
// 「关键字 / 字符串 / 注释」这类角色，于是 8 个站各写各的（舰队里 132 处，含三个非 DS 色系）。
const PALETTES = ['primary', 'sky', 'amber', 'neutral', 'chart', 'method', 'syntax'];
const FLAT_COLORS = [
  ['success', 'success'],
  ['warning', 'warning'],
  ['danger', 'danger'],
  // 语义柔和容器档（浅底色）。配上对应的 -text 才是完整用法：
  //   bg-success-soft + text-success-text
  // U66 第⑤项：原本只有实心值，各站只好写 bg-emerald-50 text-emerald-600 这类
  // 非设计系统色的组合。
  ['success-soft', 'success-soft'],
  ['warning-soft', 'warning-soft'],
  ['danger-soft', 'danger-soft'],
  // 与 -soft 配对的文本档。缺了它们，组件写 text-success-text 就生成不出类 ——
  // 而 $soft-note 规定的完整用法正是「bg-success-soft + text-success-text」（对比度 5.51/4.85/4.65）。
  ['success-text', 'success-text'],
  ['warning-text', 'warning-text'],
  ['danger-text', 'danger-text'],
  ['error', 'danger'],
  ['info', 'info'],
  ['info-text', 'info-text'],
  ['info-soft', 'info-soft'],
  ['brand', 'brand'],
  ['brand-hover', 'brand-hover'],
  ['brand-soft', 'brand-soft'],
  ['brand-active', 'brand-active'],
  // 品牌文本角色（fill vs text 分离，AUTH-05）：品牌填充色被当文本用时对白底可能低至
  // 3.24:1（#1890ff 实测）；text-brand-text 走 --color-brand-text（缺省=brand-base，
  // dark 钉 brand-dark，运行期注入派生值——见 tokens.json $brand-text-note）。
  ['brand-text', 'brand-text'],
  ['accent', 'accent'],
  ['inverse', 'text-inverse'],
  ['surface', 'bg-surface'],
  ['muted', 'bg-muted'],
  ['elevated', 'bg-elevated'],
  ['developer', 'bg-developer'],
  // 代码块底色（第 63 轮）：与 color.syntax.* 成对 —— 语法色板的可读性判据正是对这个底色的，
  // 底色的取值必须能从 SSOT 读到，闸门才不会退化成「钉字面量」。
  ['code', 'bg-code'],
  // 浮层遮罩（第 63 轮补·四）：此前舰队各写各的 bg-black/30|40|50|60，一个概念五种深浅。
  ['scrim', 'bg-scrim'],
  ['border-subtle', 'border-subtle'],
  ['border-strong', 'border-strong'],
];
// ── 色值形态：rgb(var(--color-X-rgb)) 通道三元组 ────────────────────────────
// 颜色统一发成 `rgb(var(--color-X-rgb))`，让透明度修饰符在任何颜色上可用：
//   bg-primary-500        → background-color: rgb(var(--color-primary-500-rgb))
//   bg-primary-500/10     → background-color: rgb(var(--color-primary-500-rgb) / 0.1)
//   text-success-text/60  → color: rgb(var(--color-success-text-rgb) / 0.6)
// 背景（U394/U379，2026-10-05 全舰队实测）：旧形态是裸 `var(--color-X)`，
// Tailwind 3.4 对带 `/NN` 的候选走宽松 parseColor——它只认 #hex / rgb() / 颜色名词，
// 裸 var() 解析为 null ⇒ withAlphaValue 返回 undefined ⇒ **整条规则静默丢弃**：
// 类写了、构建成功、页面上没有效果（渲染面 112 处：authenticator 57 / status 31 /
// user 18 / brand 5 / web 1；另有 65 处 `[var(--color-x)]/NN` 任意值形态同因死掉）。
// `-rgb` 通道三元组变量由 tokens.css 机械同构生成（含 dark / 变体 / profile 各作用域，
// 见 emitVars + rgbCompanion），任何主题下 alpha 都可用。新形态在三类路径均可解析：
//   ① 无修饰符 → 原样输出（合法 CSS，space-separated rgb() 语法）；
//   ② 修饰符 `/NN` 与 ③ 任意 `[.NN]` → 宽松 parseColor 取到通道 → `rgb(<channels> / N)`。
//
// 注意这里**不能**用补 DEFAULT 的方式去解决 bg-primary / text-primary：
// 设计系统的令牌名自带语义前缀（--color-bg-primary / --color-text-primary），
// Tailwind 的 utility 也加前缀（bg- / text- / border-），两者叠加就撞车。
// 而 colors.primary 是**色阶**（50..900、无 DEFAULT），于是 bg-primary / border-primary
// 一个类都生成不出来——K1 闸门（check-classnames.mjs）把这种死类变响，教写
// bg-[var(--color-bg-primary)] 或 bg-primary-700。唯一开给的语义例外是**文本色**
// （text-primary 等），由下方 semanticTextUtilities 插件组提供——那是 K1 的历史实况
// （2026-09-29 实测 133 处写了不生成、text-primary 居首）倒逼出来的收敛（U389）。
// 取舍记录见 docs/PORTAL-UI-UNIFICATION-PLAN-V2.md §P6 与 DESIGN.md
//「Ramp families have no DEFAULT」——不补 DEFAULT 的决定不变。

const presetColors = {};
for (const name of PALETTES) {
  presetColors[name] = Object.fromEntries(
    Object.entries(TOKENS.core.color[name])
      .filter(([k]) => !k.startsWith('$'))
      .map(([k]) => [k, `rgb(var(${varName(['color', name, k])}-rgb))`]),
  );
}
const colorKeys = new Set(Object.keys(TOKENS.core.color).filter((k) => !k.startsWith('$')));
for (const [className, varSuffix] of FLAT_COLORS) {
  if (!colorKeys.has(varSuffix)) {
    throw new Error(`FLAT_COLORS「${className}」指向不存在的令牌 color.${varSuffix}`);
  }
  presetColors[className] = `rgb(var(--color-${varSuffix}-rgb))`;
}

// ── U389 语义文本色类组 ─────────────────────────────────────────────────────
// 色阶无 DEFAULT 是刻意的（上），但 `text-primary`（正文色）是全舰队作者最自然的
// 直觉写法，K1 只能报死 + 教任意值形态。U389 给语义文本色一条正路：令牌名即类名——
// 所有 `text-*` 令牌 → 同名工具类（`.text-primary { color: var(--color-text-primary) }`）。
// 走插件 addUtilities：每个名字独立、与色阶零 slot 冲突；深色主题天然继承——语义
// 变量在各作用域自动换值，无需 dark: 变体。text-inverse 刻意排除：flat「inverse」
// 已提供同名类且绑同一变量，不重复生成。注意静态类**不带** `/NN` 通道：需要透明度
// 的语义文本用任意值通道形态 `text-[rgb(var(--color-text-primary-rgb))]/50`。
const semanticTextUtilities = Object.fromEntries(
  Object.keys(TOKENS.core.color)
    .filter((k) => /^text-[a-z0-9-]+$/.test(k) && k !== 'text-inverse')
    .map((k) => ['.' + k, { color: `var(${varName(['color', k])})` }]),
);

const presetFontSize = Object.fromEntries(
  Object.entries(TOKENS.core['font-size'])
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => {
      const opts = {};
      if (v.lineHeight) opts.lineHeight = v.lineHeight;
      if (v.fontWeight) opts.fontWeight = v.fontWeight;
      if (v.letterSpacing) opts.letterSpacing = v.letterSpacing;
      return [k, Object.keys(opts).length ? [v.size, opts] : [v.size]];
    }),
);

const preset = {
  theme: {
    extend: {
      colors: presetColors,
      fontFamily: {
        sans: TOKENS.core.font.sans,
        serif: TOKENS.core.font.serif,
        mono: TOKENS.core.font.mono,
      },
      fontSize: presetFontSize,
      spacing: TOKENS.core.space,
      // ── 动效（第 56 轮接进来）─────────────────────────────────────────────
      // 在此之前 motion 的九个令牌**没有生成过任何类**：站点写的 duration-200 用的是
      // Tailwind 出厂值，只是恰好与令牌同值 —— 于是「时长只走令牌」这句话没有判据支撑。
      // 键取**毫秒数值**（duration-200），因为那是舰队已经写着的类名；取语义键
      // （duration-base）会让 50 多处改名却零收益。令牌名仍然是 SSOT 里的语义名。
      transitionDuration: Object.fromEntries(
        Object.entries(TOKENS.core.motion)
          .filter(([k, v]) => k.startsWith('duration-') && typeof v === 'string' && /^\d+ms$/.test(v))
          .map(([, v]) => [v.replace('ms', ''), v]),
      ),
      // easing 用令牌名（ease-standard / ease-out / ease-in / ease-in-out）。
      // 注意：其中三个与 Tailwind **同名不同值**（ease-out、ease-in-out 不同，ease-in 相同），
      // 所以这一步会把站点上这几个类的曲线换成设计系统的 —— 是一次有意的动效收敛，
      // 而且**静态截图量不到它**（见 §11 第 56 轮）。
      transitionTimingFunction: Object.fromEntries(
        Object.entries(TOKENS.core.motion)
          .filter(([k, v]) => k.startsWith('ease-') && typeof v === 'string' && /^(cubic-bezier\(|linear$)/.test(v))
          .map(([k, v]) => [k.slice('ease-'.length), v]),
      ),
      borderRadius: TOKENS.core.radius,
      boxShadow: TOKENS.core.shadow,
      zIndex: TOKENS.core.z,
      backgroundImage: Object.fromEntries(
        Object.entries(TOKENS.core.image)
          .filter(([k]) => !k.startsWith('$'))
          .map(([k]) => [k, `var(${varName(['image', k])})`]),
      ),
    },
  },
};

outputs.set(
  'packages/tailwind-preset/index.js',
  `/** @type {import('tailwindcss').Config} */\n// ${GENERATED('tokens/tokens.json')}\n` +
    `const semanticTextPlugin = ({ addUtilities }) => {\n` +
    `  addUtilities(${js(semanticTextUtilities, 1)});\n` +
    `};\n` +
    `module.exports = ${js(preset)};\n` +
    `module.exports.plugins = [semanticTextPlugin];\n`,
);

outputs.set(
  'packages/tailwind-preset/index.d.ts',
  `/** ${GENERATED('tokens/tokens.json')} */\n` +
    `declare const preset: { theme: { extend: Record<string, unknown> } };\n` +
    `export default preset;\n`,
);

outputs.set(
  'packages/tailwind-preset/tokens.css',
  `@import '@autional/tokens/tokens.css';\n\n/* ${GENERATED('tokens/tokens.json')} — redirect kept so existing\n   \`@import '@autional/tailwind-preset/tokens.css'\` consumers keep working. */\n`,
);

// ─────────────────────────────────────────────────────────────────────────────
// Write or verify
// ─────────────────────────────────────────────────────────────────────────────

let drift = 0;
for (const [rel, content] of outputs) {
  const abs = join(ROOT, rel);
  if (CHECK) {
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current !== content) {
      drift++;
      console.error(`DRIFT  ${rel}`);
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`wrote  ${rel}`);
  }
}

if (CHECK) {
  if (drift > 0) {
    console.error(`\n${drift} generated file(s) out of date. Run: pnpm gen`);
    process.exit(1);
  }
  console.log(`OK — all ${outputs.size} generated files are up to date.`);
} else {
  console.log(`\nDone — ${outputs.size} files generated.`);
}
