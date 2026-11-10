/**
 * `fetch` 版 API 客户端 —— 与 axios 版 `createApiClient()` **并存**，供「零运行时依赖」的控制台使用。
 *
 * 背景（docs/CONSOLE-KIT-DECISION.md §4-2）：配置中心 / 密钥中心用原生 fetch + 自建错误映射，
 * 与 shared 的 axios client 是两套实现（同一 bug 双写：见决策记录 §2.1）。本客户端只收敛
 * **传输层**（鉴权头、租户头、超时、错误归一、401 续期），不接管业务端点函数 ⇒ 两站可先换
 * 请求层，不动页面。
 *
 * 设计约束（与 axios client 的差异，务必保留）：
 * - **默认透传**：不 unwrap `{code,data}` 信封、不做 snake/camel 转换。两站后端通行 snake_case，
 *   且响应形状各异（`{items,total,page}` / 裸对象）。解包与转键用 `unwrap` / `caseConversion` 显式开启。
 * - 额外作用域头（如 `X-App-ID`）经 `getHeaders` 注入，不硬编码。
 * - `credentials: 'omit'`：与 shared axios（`withCredentials:false`）一致 —— 网关跨源不回写 ACAC。
 */

/** 归一后的 API 错误（替代各站自建 `ApiError`）。 */
export class FetchApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly detail: string;
	readonly body: unknown;

	constructor(status: number, message: string, code = '', detail = '', body: unknown = null) {
		super(message);
		this.name = 'FetchApiError';
		this.status = status;
		this.code = code;
		this.detail = detail;
		this.body = body;
	}
}

export type FetchQueryValue = string | number | boolean | null | undefined;

export interface FetchRequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	query?: Record<string, FetchQueryValue | FetchQueryValue[]>;
	/** 对象 ⇒ JSON.stringify；字符串/Blob/FormData 原样透传。 */
	body?: unknown;
	headers?: Record<string, string>;
	/** 单次覆盖超时（ms）。 */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface FetchClientOptions {
	/** 基址（如 `/bff/config/api/v1/admin/config`），与 path 直接拼接。 */
	baseUrl: string;
	/** 取 access token（缺省不注入 Authorization）。 */
	getToken?: () => string | null | undefined;
	/** 取租户 ID（缺省不注入 X-Tenant-ID）。 */
	getTenantId?: () => string | null | undefined;
	/** 额外作用域头（X-App-ID / X-Namespace …），每次请求求值。 */
	getHeaders?: () => Record<string, string>;
	/**
	 * 401 回调（跳登录 / 触发全局事件）。
	 * **只在「放弃」时调用**：无 refresh、refresh 返回空、或续期后重试仍 401 —— 整个请求最多一次。
	 * 可救回的 401 静默续期，不打扰用户。
	 */
	onUnauthorized?: (error: FetchApiError) => void;
	/** 401 静默续期：返回新 token 则重试一次；返回 null/抛错则放弃。 */
	refresh?: () => Promise<string | null>;
	/** 默认超时，20s（与两站现状一致）。 */
	timeoutMs?: number;
	/**
	 * 解 `{code,data}` 信封（`code != 0` 视为错误，number 与字符串形态都认）。
	 * `{code,items}` 列表信封保持原形返回，由调用方取 `items`。默认 false（透传）。
	 */
	unwrap?: boolean;
	/** 响应键名归一：`'camel'` = Pascal/snake → camelCase。默认 `'none'`。 */
	caseConversion?: 'none' | 'camel';
}

export interface FetchClient {
	request<T = unknown>(path: string, options?: FetchRequestOptions): Promise<T>;
	get<T = unknown>(path: string, options?: FetchRequestOptions): Promise<T>;
	post<T = unknown>(path: string, body?: unknown, options?: FetchRequestOptions): Promise<T>;
	put<T = unknown>(path: string, body?: unknown, options?: FetchRequestOptions): Promise<T>;
	patch<T = unknown>(path: string, body?: unknown, options?: FetchRequestOptions): Promise<T>;
	delete<T = unknown>(path: string, options?: FetchRequestOptions): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function buildUrl(baseUrl: string, path: string, query?: FetchRequestOptions['query']): string {
	const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
	const url = new URL(`${baseUrl}${path}`, origin);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item === undefined || item === null) continue;
					url.searchParams.append(key, String(item));
				}
				continue;
			}
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

function toCamelCase(key: string): string {
	return key.replace(/[_-](\w)/g, (_, next: string) => next.toUpperCase());
}

/** 递归把对象的键转 camelCase（仅响应侧，显式开启时使用）。 */
function camelizeKeys<T>(input: unknown): T {
	if (Array.isArray(input)) return input.map((item) => camelizeKeys(item)) as unknown as T;
	if (!input || typeof input !== 'object' || input instanceof Blob || input instanceof FormData) {
		return input as T;
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		out[toCamelCase(key)] = camelizeKeys(value);
	}
	return out as T;
}

interface ProblemBody {
	title?: string;
	detail?: string;
	code?: string | number;
	message?: string;
	status?: number;
}

function toError(status: number, body: unknown, fallbackMessage?: string): FetchApiError {
	const problem = (body && typeof body === 'object' ? body : null) as ProblemBody | null;
	const message =
		problem?.title || problem?.message || fallbackMessage || `HTTP ${status}`;
	const code = problem?.code === undefined || problem.code === null ? '' : String(problem.code);
	const detail = problem?.detail || problem?.message || message;
	return new FetchApiError(status, message, code, detail, body);
}

/**
 * 创建 fetch 客户端。
 *
 * 用法（配置中心形态）：
 * ```ts
 * const client = createFetchClient({
 *   baseUrl: '/bff/config/api/v1/admin/config',
 *   getToken: () => currentSession()?.accessToken,
 *   getTenantId: () => currentSession()?.user.tenantId,
 *   getHeaders: () => ({ 'X-App-ID': APP_ID }),
 *   onUnauthorized: () => window.dispatchEvent(new CustomEvent('config-console:unauthorized')),
 *   refresh: () => refreshSession()?.accessToken ?? null,
 * });
 * ```
 */
export function createFetchClient(options: FetchClientOptions): FetchClient {
	const {
		baseUrl,
		getToken,
		getTenantId,
		getHeaders,
		onUnauthorized,
		refresh,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		unwrap = false,
		caseConversion = 'none',
	} = options;

	async function send<T>(
		path: string,
		init: FetchRequestOptions,
		retried: boolean,
		tokenOverride?: string | null,
	): Promise<T> {
		const { method = 'GET', query, body, headers: extraHeaders, timeoutMs: perCall, signal } = init;
		const effectiveTimeout = perCall ?? timeoutMs;

		const headers: Record<string, string> = { Accept: 'application/json' };
		let payload: BodyInit | undefined;

		if (body !== undefined && body !== null) {
			if (
				typeof body === 'string' ||
				body instanceof Blob ||
				body instanceof FormData ||
				body instanceof URLSearchParams
			) {
				payload = body as BodyInit;
			} else {
				payload = JSON.stringify(body);
				headers['Content-Type'] = 'application/json';
			}
		}

		// 作用域头：显式 headers 优先于自动注入（调用方可覆盖）
		// 续期重试时用续期返回的 token（调用方不一定回写 store）；无 token 不注入租户头
		// —— 与 api/client.ts:37-41 同口径（无 token 时 token 里的租户才是唯一权威）。
		const token = tokenOverride ?? getToken?.() ?? null;
		if (token) {
			headers.Authorization = `Bearer ${token}`;
			const tenantId = getTenantId?.() ?? null;
			if (tenantId) headers['X-Tenant-ID'] = tenantId;
		}
		if (getHeaders) Object.assign(headers, getHeaders());
		if (extraHeaders) Object.assign(headers, extraHeaders);

		// 调用方已取消 ⇒ 直接失败（addEventListener 对"已 abort"的 signal 不会再触发）
		if (signal?.aborted) {
			throw new FetchApiError(0, '请求已取消', 'aborted');
		}

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, effectiveTimeout);
		const onAbort = () => controller.abort();
		signal?.addEventListener('abort', onAbort);

		let response: Response;
		try {
			response = await fetch(buildUrl(baseUrl, path, query), {
				method,
				headers,
				body: payload,
				credentials: 'omit',
				signal: controller.signal,
			});
		} catch (cause) {
			const aborted = (cause as Error)?.name === 'AbortError';
			if (aborted) {
				throw new FetchApiError(
					0,
					timedOut ? `请求超时（${effectiveTimeout / 1000}s）` : '请求已取消',
					timedOut ? 'timeout' : 'aborted',
				);
			}
			throw new FetchApiError(0, `无法连接服务：${(cause as Error).message}`, 'network_error');
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		}

		// 401：**先**尝试一次静默续期（可救回的 401 不应把用户踢去登录页）；
		// 只有在「没有续期能力」或「续期失败 / 重试后仍 401」时才通知 onUnauthorized，
		// 且整个请求生命周期内最多通知一次。
		if (response.status === 401) {
			const unauthorized = toError(401, await safeJson(response), '未授权');
			if (!retried && refresh) {
				let nextToken: string | null = null;
				try {
					nextToken = await refresh();
				} catch {
					nextToken = null;
				}
				if (nextToken) {
					return send<T>(path, init, true, nextToken);
				}
			}
			onUnauthorized?.(unauthorized);
			throw unauthorized;
		}

		const raw = await safeText(response);
		let parsed: unknown = null;
		if (raw !== '') {
			try {
				parsed = JSON.parse(raw);
			} catch {
				if (response.ok) {
					throw new FetchApiError(response.status, '响应不是合法 JSON', 'invalid_json', raw, raw);
				}
				parsed = raw;
			}
		}

		if (!response.ok) {
			throw toError(response.status, parsed);
		}

		let result: unknown = parsed;
		if (unwrap && parsed && typeof parsed === 'object') {
			const envelope = parsed as { code?: unknown; data?: unknown; items?: unknown; message?: string };
			// 业务码：number 0 / 字符串 '0' 视为成功；其余非空值为错误（部分服务把 code 序列化成字符串）
			const code = envelope.code;
			const failedCode =
				(typeof code === 'number' && code !== 0) ||
				(typeof code === 'string' && code !== '' && code !== '0');
			if (failedCode) {
				throw toError(response.status, parsed);
			}
			if ('data' in envelope && envelope.data !== undefined) {
				result = envelope.data;
			}
			// 列表信封（`{items,total,pagination}`）：保持原形，由调用方取 items
		}

		return (caseConversion === 'camel' ? camelizeKeys<T>(result) : result) as T;
	}

	const request = <T,>(path: string, init: FetchRequestOptions = {}): Promise<T> =>
		send<T>(path, init, false);

	return {
		request,
		get: (path, init) => request(path, { ...init, method: 'GET' }),
		post: (path, body, init) => request(path, { ...init, method: 'POST', body }),
		put: (path, body, init) => request(path, { ...init, method: 'PUT', body }),
		patch: (path, body, init) => request(path, { ...init, method: 'PATCH', body }),
		delete: (path, init) => request(path, { ...init, method: 'DELETE' }),
	};
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

async function safeJson(response: Response): Promise<unknown> {
	const raw = await safeText(response);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
