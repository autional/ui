/**
 * Shared error handling utilities
 * Framework-agnostic: works with any UI notification system
 */

export interface ExtractedApiError {
	code: number | string;
	message: string;
	/** AUTH-46：后端 Problem 契约的 i18n_key（如 error.oauth_state_invalid）。消费方可据此
	 * 映射本地化文案；缺省时 undefined（message 键链不变，向后兼容）。 */
	i18nKey?: string;
}

export function extractApiErrorMessage(err: unknown, defaultMsg: string): string {
	return extractApiError(err, defaultMsg).message;
}

export function extractApiError(err: unknown, defaultMsg: string): ExtractedApiError {
	// UP-17-B：后端 Problem 契约（service-core/base/dto/problem.go）字段为 title（必填）/ detail / code / i18n_key，
	// **没有 message** —— 只认 message 会把整类后端错误退化成 defaultMsg。
	// U380：键链 message → detail → title，对齐 Problem.GetMessage()（Detail 非空优先），
	// 避免英文 title 压过本地化 detail。
	// 继续用 `||`（而非 `??`）：空串语义按「缺省」处理，与既有实现一致。
	// AUTH-46：附加透出 i18n_key（响应拦截器深 camel 后为 i18nKey，两者都认）。
	const data = (err as any)?.response?.data;
	return {
		code: data?.code || 'UNKNOWN',
		message: data?.message || data?.detail || data?.title || (err as any)?.message || defaultMsg,
		i18nKey: data?.i18n_key || data?.i18nKey || undefined,
	};
}

export function createHandleApiError(notify: (msg: string) => void) {
	return (err: unknown, defaultMsg: string): void => {
		notify(extractApiErrorMessage(err, defaultMsg));
	};
}
