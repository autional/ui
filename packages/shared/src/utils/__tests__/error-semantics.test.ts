import { describe, expect, it } from 'vitest';

import {
	ERROR_SEMANTICS,
	ERROR_SEMANTICS_META,
	MAX_RETRIES,
	UNPROVISIONED_CODES,
	isNotFoundError,
	isRetryableErrorContractFirst,
	semanticsOfCode,
	semanticsOfError,
	shouldRetry,
} from '../error-semantics';
import { isRetryableError } from '../query-state';

const httpErr = (status: number, code?: number) => ({
	response: { status, data: code === undefined ? {} : { code } },
});

describe('error-semantics：契约优先的重试与语义查询', () => {
	it('契约覆盖 61001801（LDAP 未配置：503 但重试必败）→ 契约口径不可重试，状态口径会说可重试', () => {
		const err = httpErr(503, 61001801);
		expect(isRetryableError(err)).toBe(true); // 状态口径（旧行为）
		expect(isRetryableErrorContractFirst(err)).toBe(false); // 契约口径（新行为）
		expect(shouldRetry(0, err)).toBe(false);
		expect(semanticsOfCode(61001801)?.uiObservation).toBe('action_required');
	});

	it('未收录码 → 回落状态口径；次数上限为 MAX_RETRIES', () => {
		const err = httpErr(503, 99999999);
		expect(semanticsOfError(err)).toBeUndefined();
		expect(isRetryableErrorContractFirst(err)).toBe(true);
		expect(shouldRetry(0, err)).toBe(true);
		expect(shouldRetry(MAX_RETRIES, err)).toBe(false);
	});

	it('404 一律不重试；契约给出 not_found/entity', () => {
		const err = httpErr(404, 61110004);
		expect(isRetryableErrorContractFirst(err)).toBe(false);
		expect(isNotFoundError(err)).toBe(true);
		expect(semanticsOfCode(61110004)?.absence).toBe('entity');
	});

	it('凭据不匹配 / 人机验证 / 通用 401 三者语义可区分（R2/R3 的回归锁）', () => {
		expect(semanticsOfCode(61000104)?.uiObservation).toBe('credential_mismatch');
		expect(semanticsOfCode(40800505)?.uiObservation).toBe('captcha_required');
		expect(semanticsOfCode(40800506)?.uiObservation).toBe('captcha_required');
		expect(semanticsOfCode(40000502)?.uiObservation).toBe('session_expired'); // 通用 401 未被覆写
		expect(semanticsOfCode(61002201)?.uiObservation).toBe('reauth_required');
	});

	it('契约规模自洽 + 未开通台账保持空（目标态）', () => {
		expect(ERROR_SEMANTICS_META.rowCount).toBe(Object.keys(ERROR_SEMANTICS).length);
		expect(UNPROVISIONED_CODES.size).toBe(0);
	});
});
