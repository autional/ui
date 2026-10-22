import { describe, it, expect } from 'vitest';
import { extractApiError, extractApiErrorMessage } from '../error';

// UP-17-B 回归锁（AC-401）：extractApiError message 键链。
// 后端 Problem 契约（service-core/base/dto/problem.go）为 title 必填 / detail / code / i18n_key，无 message；
// 只认 message 会把 Problem 类错误整类退化为 defaultMsg。
// U380 回归锁：detail 优先于 title，对齐 Problem.GetMessage()（Detail 非空优先）。
describe('extractApiError message 键链（UP-17-B / AC-401 / U380）', () => {
	it('detail 优先：Problem 契约（title/detail/code）→ 取 detail', () => {
		const err = {
			response: { data: { code: 403, title: 'Platform Access Denied', detail: '需要平台角色' } },
		};
		const out = extractApiError(err, 'fallback');
		expect(out.message).toBe('需要平台角色');
		expect(out.code).toBe(403);
	});

	it('title 兜底：无 message/detail 时取 title', () => {
		const err = { response: { data: { title: 'Invalid Request' } } };
		expect(extractApiError(err, 'fallback').message).toBe('Invalid Request');
	});

	it('U380：英文 title + 中文 detail → 中文 detail 胜出', () => {
		const err = {
			response: {
				data: {
					code: 61040050,
					title: 'push challenge not found',
					detail: '推送挑战未找到',
					i18n_key: 'error.push_challenge_not_found',
				},
			},
		};
		const out = extractApiError(err, 'fallback');
		expect(out.message).toBe('推送挑战未找到');
		expect(out.i18nKey).toBe('error.push_challenge_not_found');
	});

	it('皆无回落 err.message，再皆无回落 defaultMsg', () => {
		expect(extractApiError(new Error('network boom'), 'fallback').message).toBe('network boom');
		expect(extractApiError({}, 'fallback').message).toBe('fallback');
		expect(extractApiError(undefined, 'fallback')).toEqual({ code: 'UNKNOWN', message: 'fallback' });
	});

	it('业务信封（code+message）不回归：message 仍优先于 title', () => {
		const err = {
			response: { data: { code: 61040010, message: 'TOTP already enabled', title: 'Conflict' } },
		};
		expect(extractApiError(err, 'fallback')).toEqual({
			code: 61040010,
			message: 'TOTP already enabled',
		});
		expect(extractApiErrorMessage(err, 'fallback')).toBe('TOTP already enabled');
	});
});

// AUTH-46 回归锁：i18n_key 透出（消费方按 key 映射本地化文案，不再暴露英文裸句）。
describe('extractApiError i18n_key 透出（AUTH-46）', () => {
	it('Problem 体带 i18n_key → i18nKey 字段透出（snake 形）', () => {
		const err = {
			response: {
				data: {
					code: 400,
					title: 'Invalid Parameter',
					detail: 'state not found',
					i18n_key: 'error.oauth_state_missing',
				},
			},
		};
		const out = extractApiError(err, 'fallback');
		expect(out.i18nKey).toBe('error.oauth_state_missing');
		// U380：键链为 message → detail → title
		expect(out.message).toBe('state not found');
	});

	it('响应拦截器深 camel 后（i18nKey）同样识别', () => {
		const err = { response: { data: { code: 400, i18nKey: 'error.sso_provider_not_configured' } } };
		expect(extractApiError(err, 'fallback').i18nKey).toBe('error.sso_provider_not_configured');
	});

	it('无 i18n_key → undefined（向后兼容，不改变既有形状）', () => {
		expect(extractApiError(new Error('boom'), 'fallback').i18nKey).toBeUndefined();
		expect(extractApiError({}, 'fallback')).toEqual({
			code: 'UNKNOWN',
			message: 'fallback',
			i18nKey: undefined,
		});
	});
});
