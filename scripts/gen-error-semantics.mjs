#!/usr/bin/env node
/**
 * 错误语义契约生成器（消费侧）。
 *
 * 单一真源：service-core `base/error/semantics.go`（Go）→ 导出 `errors.semantics.json`
 *          → 镜像到本仓 `contracts/errors.semantics.json` → 生成 TS 目录（本脚本）。
 *
 * 为什么需要它：错误码 → 客户端行为（是否可重试 / 是否空态 / 是否「未开通」）必须只有一份来源。
 * 前端**不得**手抄错误码分支（手抄 = 漂移，正是 2026-10-14 novel-demo 页面误报的根因）。
 *
 * 用法：
 *   pnpm gen:errors          # 生成/更新
 *   pnpm gen:errors:check    # 校验磁盘产物与契约一致（漂移即 exit 1）
 *
 * 同步契约（从引擎仓刷新源 JSON）：
 *   node -e "require('fs').copyFileSync('<service-core>/base/error/testdata/errors.semantics.json','contracts/errors.semantics.json')"
 *   （生成物头部会记录源 sha256，便于对账）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const CONTRACT = join(ROOT, 'contracts/errors.semantics.json');
const OUTPUT = join(ROOT, 'packages/shared/src/generated/error-semantics.ts');

if (!existsSync(CONTRACT)) {
  console.error(`[gen:errors] 契约缺失：${CONTRACT}\n请先从 service-core 同步 errors.semantics.json（见本文件头注释）。`);
  process.exit(1);
}

const raw = readFileSync(CONTRACT);
const sha = createHash('sha256').update(raw).digest('hex');
const rows = JSON.parse(raw.toString('utf8'));
if (!Array.isArray(rows) || rows.length === 0) {
  console.error('[gen:errors] 契约内容非法：不是非空数组');
  process.exit(1);
}

// 失败要响：字段缺失/枚举未知/重复码一律报错，不静默降级（否则生成物会与契约悄悄分叉）。
const CLASSES = ['invalid', 'unauthorized', 'forbidden', 'not_found', 'gone', 'conflict', 'limit', 'unavailable', 'internal'];
const ABSENCES = ['', 'entity', 'unprovisioned'];
const UI = [
  'empty_state',
  'not_found_page',
  'form_error',
  'session_expired',
  'forbidden',
  'conflict',
  'rate_limited',
  'transient',
  'unexpected',
  'captcha_required',
  'credential_mismatch',
  'expired',
  'reauth_required',
  'action_required',
];
const sorted = [...rows].sort((a, b) => a.code - b.code);
const seen = new Set();
const nameSeen = new Map();
for (const r of sorted) {
  if (typeof r.code !== 'number' || !Number.isInteger(r.code)) throw new Error(`行缺少合法整数 code: ${JSON.stringify(r)}`);
  if (seen.has(r.code)) throw new Error(`契约含重复错误码: ${r.code}`);
  seen.add(r.code);
  if (typeof r.http_status !== 'number' || !Number.isInteger(r.http_status)) throw new Error(`code=${r.code} http_status 非法`);
  if (!CLASSES.includes(r.class)) throw new Error(`code=${r.code} 未知 class: ${r.class}`);
  if (!ABSENCES.includes(r.absence ?? '')) throw new Error(`code=${r.code} 未知 absence: ${r.absence}`);
  // 404 行必须显式带缺失分类（entity / unprovisioned）——否则客户端无法区分「真不存在」与「未开通」。
  if (r.http_status === 404 && !(r.absence === 'entity' || r.absence === 'unprovisioned')) {
    throw new Error(`code=${r.code} 为 404 但 absence=${JSON.stringify(r.absence)}（必须显式 entity/unprovisioned）`);
  }
  if (!UI.includes(r.ui_observation)) throw new Error(`code=${r.code} 未知 ui_observation: ${r.ui_observation}`);
  if (typeof r.retryable !== 'boolean') throw new Error(`code=${r.code} retryable 非布尔`);
  // docs_path 必须非空：否则会静默生成 docsPath: 'undefined'。
  if (typeof r.docs_path !== 'string' || r.docs_path.trim() === '') throw new Error(`code=${r.code} docs_path 缺失或为空`);
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || !/^[A-Z0-9_]+$/.test(r.name)) {
      throw new Error(`code=${r.code} name 非法: ${JSON.stringify(r.name)}（只允许 A-Z0-9_）`);
    }
    if (nameSeen.has(r.name)) throw new Error(`name 重复: ${r.name}（code=${r.code} 与 ${nameSeen.get(r.name)}）`);
    nameSeen.set(r.name, r.code);
  }
}

// 契约镜像完整性（防手工拷贝漏改）：contracts/errors.semantics.meta.json 钉住源与 sha256。
const META = join(ROOT, 'contracts/errors.semantics.meta.json');
if (!existsSync(META)) {
  console.error(`[gen:errors] 契约元数据缺失：${META}（应含 source / sourceSha256 / rows）`);
  process.exit(1);
}
const meta = JSON.parse(readFileSync(META, 'utf8'));
if (meta.sourceSha256 !== sha) {
  console.error(
    `[gen:errors] 契约镜像与元数据不一致：\n  meta.sourceSha256 = ${meta.sourceSha256}\n  实际 sha256      = ${sha}\n` +
      `说明：contracts/errors.semantics.json 被改过但 meta 未更新（或反之）。请重新从 service-core 同步并更新 meta。`,
  );
  process.exit(1);
}
if (meta.rows !== sorted.length) {
  console.error(`[gen:errors] 契约行数与元数据不一致：meta.rows=${meta.rows}, 实际=${sorted.length}`);
  process.exit(1);
}
const unprovisioned = sorted.filter((r) => r.absence === 'unprovisioned').map((r) => r.code);
const emptyState = sorted.filter((r) => r.ui_observation === 'empty_state').map((r) => r.code);

const lit = (s) => `'${s}'`;
const banner = [
  '// GENERATED FILE — DO NOT EDIT.',
  '// Source: contracts/errors.semantics.json（@autional/shared 仓内镜像，源 = service-core base/error/testdata/errors.semantics.json）',
  `// Regenerate: pnpm gen:errors · Verify: pnpm gen:errors:check`,
  `// rows: ${sorted.length} · source sha256: ${sha}`,
  '//',
  '// 单一真源链：service-core/base/error/semantics.go（Go）→ errors.semantics.json → 本文件。',
  '// ⚠️ 禁止在本文件或页面里手抄错误码分支：请消费 ERROR_SEMANTICS / UNPROVISIONED_CODES。',
].join('\n');

const body = [
  banner,
  '',
  `export type ErrorClass =\n\t| ${CLASSES.map(lit).join('\n\t| ')};`,
  '',
  `export type Absence = '' | 'entity' | 'unprovisioned';`,
  '',
  `export type UIObservation =\n\t| ${UI.map(lit).join('\n\t| ')};`,
  '',
  '/** 单个错误码的客户端契约（与后端语义表逐字对应）。 */',
  'export interface ErrorSemantics {',
  '\tcode: number;',
  '\thttpStatus: number;',
  '\tclass: ErrorClass;',
  '\tabsence: Absence;',
  '\tuiObservation: UIObservation;',
  '\tname?: string;',
  '\tretryable: boolean;',
  '\tdocsPath: string;',
  '}',
  '',
  '/** code → 语义。未收录的码返回 undefined（调用方须显式兜底，禁止猜测）。 */',
  'export const ERROR_SEMANTICS: Readonly<Record<number, ErrorSemantics>> = {',
  ...sorted.map(
    (r) =>
      `\t${r.code}: { code: ${r.code}, httpStatus: ${r.http_status}, class: ${lit(r.class)}, absence: ${lit(r.absence ?? '')}, uiObservation: ${lit(
        r.ui_observation,
      )}, ${r.name ? `name: ${lit(r.name)}, ` : ''}retryable: ${r.retryable}, docsPath: ${lit(r.docs_path)} },`,
  ),
  '};',
  '',
  '/**',
  ' * 「未开通」码：用户级单例尚未初始化。**不是错误** —— 必须渲染空态（可带开通 CTA），不得当失败。',
  ' * 目标态：后端改为 200 + status 后，本集合应随契约自动缩小至空。',
  ' */',
  `export const UNPROVISIONED_CODES: ReadonlySet<number> = new Set([${unprovisioned.join(', ')}]);`,
  '',
  '/** 客户端应渲染空态的码（当前等同于未开通集合，随契约演进）。 */',
  `export const EMPTY_STATE_CODES: ReadonlySet<number> = new Set([${emptyState.join(', ')}]);`,
  '',
  'export const ERROR_SEMANTICS_META = {',
  `\trowCount: ${sorted.length},`,
  `\tsourceSha256: '${sha}',`,
  '} as const;',
  '',
  '/** 具名错误码常量（契约 name → code）。页面只消费常量，不写数字字面量。 */',
  'export const ERROR_CODES = {',
  ...sorted.filter((r) => r.name).map((r) => `\t${r.name}: ${r.code},`),
  '} as const;',
  '',
  'export type ErrorCodeName = keyof typeof ERROR_CODES;',
  '',
].join('\n');

const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null;

if (CHECK) {
  if (current !== body) {
    console.error(`[gen:errors:check] 生成物与契约不一致：${OUTPUT}\n请运行 \`pnpm gen:errors\` 并提交结果。`);
    process.exit(1);
  }
  console.log(`[gen:errors:check] OK（rows=${sorted.length}, sha256=${sha.slice(0, 16)}）`);
  process.exit(0);
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, body);
console.log(`[gen:errors] wrote ${OUTPUT}（rows=${sorted.length}, unprovisioned=${unprovisioned.length}, sha256=${sha.slice(0, 16)}）`);
