/**
 * 错误语义消费层（**客户端单一真源**）。
 *
 * 契约链：service-core `base/error/semantics.go`（Go，单一真源）→ errors.semantics.json
 *        → 本仓 `contracts/`（镜像，sha256 钉住）→ `scripts/gen-error-semantics.mjs` 生成
 *        `src/generated/error-semantics.ts`（码 → class/absence/ui/retryable）。
 *
 * 两个真源，各司其职、不重复：
 *  1) `./query-state` = **HTTP 状态**语义（error / 空 / 无权 / 可重试）；
 *  2) `../generated/error-semantics` = **业务码**语义（码 → class / absence / ui_observation / retryable）。
 * 本文件把二者组合成调用方可直接消费的判定。
 *
 * 纪律：**页面/应用不得再手写错误码字面量**（手抄 = 漂移，正是 2026-10-14 novel-demo 事故的根因）。
 * 各站点原先各自的 `lib/error-semantics.ts` 垫片，在本包发布含本模块的版本后**删除**并改为从本包导入。
 */
import { getHttpStatus, isForbiddenError, isRetryableError } from './query-state';
import {
	EMPTY_STATE_CODES,
	ERROR_CODES,
	ERROR_SEMANTICS,
	ERROR_SEMANTICS_META,
	UNPROVISIONED_CODES,
} from '../generated/error-semantics';
import type {
	Absence,
	ErrorClass,
	ErrorCodeName,
	ErrorSemantics,
	UIObservation,
} from '../generated/error-semantics';

export { EMPTY_STATE_CODES, ERROR_CODES, ERROR_SEMANTICS, ERROR_SEMANTICS_META, UNPROVISIONED_CODES };
export type { Absence, ErrorClass, ErrorCodeName, ErrorSemantics, UIObservation };
export { getHttpStatus, isForbiddenError, isRetryableError };

/** 单次查询最多重试次数（策略参数，唯一出处）。 */
export const MAX_RETRIES = 1;

/** 从错误对象里取后端 Problem 契约的业务码（与 `getHttpStatus` 的形状对齐）。 */
export function errorCodeOf(error: unknown): number | undefined {
	if (error === null || error === undefined || typeof error !== 'object') return undefined;
	const e = error as { code?: unknown; data?: { code?: unknown }; response?: { data?: { code?: unknown } } };
	for (const code of [e.response?.data?.code, e.data?.code, e.code]) {
		if (typeof code === 'number' && Number.isInteger(code) && code > 0) return code;
		if (typeof code === 'string' && /^\d+$/.test(code) && Number(code) > 0) return Number(code);
	}
	return undefined;
}

/** 码 → 语义。未收录的码返回 undefined（调用方须显式兜底，**禁止猜测**）。 */
export function semanticsOfCode(code: number | undefined): ErrorSemantics | undefined {
	return code === undefined ? undefined : ERROR_SEMANTICS[code];
}

/** 错误对象 → 语义。 */
export function semanticsOfError(error: unknown): ErrorSemantics | undefined {
	return semanticsOfCode(errorCodeOf(error));
}

/** HTTP 404：按标识寻址的资源不存在（absence=entity）。 */
export function isNotFoundError(error: unknown): boolean {
	return getHttpStatus(error) === 404;
}

/** HTTP 401：登录态失效（与 query-state 同口径，供调用方在语义层统一取用）。 */
export function isUnauthorizedError(error: unknown): boolean {
	return getHttpStatus(error) === 401;
}

/** 「未开通」判定：404 且契约标记 absence='unprovisioned'。 */
export function isUnprovisionedError(error: unknown): boolean {
	if (getHttpStatus(error) !== 404) return false;
	const code = errorCodeOf(error);
	return code !== undefined && UNPROVISIONED_CODES.has(code);
}

/** 该错误是否应按空态渲染（契约 ui_observation='empty_state'）。 */
export function isEmptyStateError(error: unknown): boolean {
	const s = semanticsOfError(error);
	if (s) return s.uiObservation === 'empty_state';
	if (getHttpStatus(error) !== 404) return false;
	const code = errorCodeOf(error);
	return code !== undefined && EMPTY_STATE_CODES.has(code);
}

/**
 * **契约优先的重试判定**（R4）：
 *   - 有业务码且契约收录 → **以契约 `retryable` 为准**（如 61001801「LDAP 未配置」=503 但重试必败 ⇒ false）；
 *   - 无业务码 / 未收录 → 回落 HTTP 状态口径（`isRetryableError`：无状态 / 5xx / 408 / 429）。
 * 这样「重试」也收敛到同一份契约，不再出现"状态说可重试、语义说没必要"的分叉。
 */
export function isRetryableErrorContractFirst(error: unknown): boolean {
	const s = semanticsOfError(error);
	return s ? s.retryable : isRetryableError(error);
}

/**
 * 重试策略（唯一实现）—— 所有 `QueryClient` 默认与调用方都必须走这里。
 * 契约优先（见 `isRetryableErrorContractFirst`）；`MAX_RETRIES` 为唯一次数出处。
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
	return isRetryableErrorContractFirst(error) && failureCount < MAX_RETRIES;
}
