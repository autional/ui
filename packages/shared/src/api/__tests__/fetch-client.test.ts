import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchApiError, createFetchClient } from '../fetch-client';

type FetchArgs = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as unknown as Response;
}

function textResponse(text: string, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => text,
		headers: new Headers(),
	} as unknown as Response;
}

describe('createFetchClient', () => {
	let calls: FetchArgs[];

	function stubFetch(handler: (args: FetchArgs) => Response | Promise<Response>) {
		calls = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				const args = { url, init };
				calls.push(args);
				return handler(args);
			}),
		);
	}

	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('注入 Authorization / X-Tenant-ID / 自定义作用域头', async () => {
		stubFetch(() => jsonResponse({ ok: true }));
		const client = createFetchClient({
			baseUrl: '/bff/config/api/v1/admin/config',
			getToken: () => 'token-abc',
			getTenantId: () => 'tenant-1',
			getHeaders: () => ({ 'X-App-ID': 'app-9' }),
		});

		await client.get('/items');

		expect(calls).toHaveLength(1);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer token-abc');
		expect(headers['X-Tenant-ID']).toBe('tenant-1');
		expect(headers['X-App-ID']).toBe('app-9');
		expect(calls[0].init.credentials).toBe('omit');
	});

	it('无 token 时不注入 Authorization，也**不**注入 X-Tenant-ID（与 api/client.ts 同口径）', async () => {
		stubFetch(() => jsonResponse({}));
		const client = createFetchClient({
			baseUrl: '/api',
			getToken: () => null,
			// 无 token 时租户头的唯一权威是地址栏/调用方；这里给一个值，验证不会注入
			getTenantId: () => 'tenant-from-env',
		});

		await client.get('/x');

		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers['X-Tenant-ID']).toBeUndefined();
	});

	it('查询参数：跳过 null/undefined，数组展开', async () => {
		stubFetch(() => jsonResponse({}));
		const client = createFetchClient({ baseUrl: '/api' });

		await client.get('/items', {
			query: { page: 1, q: 'a b', empty: null, skip: undefined, tag: ['x', 'y'] },
		});

		const url = new URL(calls[0].url);
		expect(url.searchParams.get('page')).toBe('1');
		expect(url.searchParams.get('q')).toBe('a b');
		expect(url.searchParams.has('empty')).toBe(false);
		expect(url.searchParams.has('skip')).toBe(false);
		expect(url.searchParams.getAll('tag')).toEqual(['x', 'y']);
	});

	it('对象 body 序列化为 JSON 并带 Content-Type', async () => {
		stubFetch(() => jsonResponse({}, 201));
		const client = createFetchClient({ baseUrl: '/api' });

		await client.post('/items', { key: 'a_b' });

		expect(calls[0].init.body).toBe('{"key":"a_b"}');
		expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});

	it('默认透传信封（不 unwrap、不转键）', async () => {
		stubFetch(() => jsonResponse({ code: 0, data: { snake_key: 1 } }));
		const client = createFetchClient({ baseUrl: '/api' });

		const result = await client.get<{ code: number; data: { snake_key: number } }>('/x');

		expect(result).toEqual({ code: 0, data: { snake_key: 1 } });
	});

	it('unwrap=true 解 data；code!=0 抛错', async () => {
		stubFetch(() => jsonResponse({ code: 0, data: { total: 3 } }));
		const client = createFetchClient({ baseUrl: '/api', unwrap: true });
		await expect(client.get('/x')).resolves.toEqual({ total: 3 });

		stubFetch(() => jsonResponse({ code: 40000102, message: 'tenant not found' }));
		const failing = createFetchClient({ baseUrl: '/api', unwrap: true });
		await expect(failing.get('/x')).rejects.toMatchObject({
			status: 200,
			code: '40000102',
			message: 'tenant not found',
		});
	});

	it('unwrap：字符串 code（"0" 成功 / "40000102" 失败）也按业务码处理', async () => {
		stubFetch(() => jsonResponse({ code: '0', data: { ok: 1 } }));
		const ok = createFetchClient({ baseUrl: '/api', unwrap: true });
		await expect(ok.get('/x')).resolves.toEqual({ ok: 1 });

		stubFetch(() => jsonResponse({ code: '40000102', message: 'tenant not found' }));
		const bad = createFetchClient({ baseUrl: '/api', unwrap: true });
		await expect(bad.get('/x')).rejects.toMatchObject({ status: 200, code: '40000102' });
	});

	it('caseConversion=camel 只转响应键', async () => {
		stubFetch(() => jsonResponse({ item_key: [{ inner_key: 1 }] }));
		const client = createFetchClient({ baseUrl: '/api', caseConversion: 'camel' });

		await expect(client.get('/x')).resolves.toEqual({ itemKey: [{ innerKey: 1 }] });
	});

	it('非 2xx：RFC7807 归一为 FetchApiError', async () => {
		stubFetch(() =>
			jsonResponse({ title: '无权限', status: 403, code: '403001', detail: 'role missing' }, 403),
		);
		const client = createFetchClient({ baseUrl: '/api' });

		const error = await client.get('/x').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FetchApiError);
		expect(error).toMatchObject({ status: 403, code: '403001', message: '无权限', detail: 'role missing' });
	});

	it('401：回调 onUnauthorized，无 refresh 时直接抛', async () => {
		stubFetch(() => jsonResponse({ message: 'unauthorized' }, 401));
		const onUnauthorized = vi.fn();
		const client = createFetchClient({ baseUrl: '/api', onUnauthorized });

		await expect(client.get('/x')).rejects.toMatchObject({ status: 401 });
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(1);
	});

	it('401 + refresh 成功：只重试一次，且**不**触发 onUnauthorized（静默续期要真的静默）', async () => {
		let attempt = 0;
		stubFetch((args) => {
			attempt += 1;
			const headers = args.init.headers as Record<string, string>;
			if (attempt === 1) {
				expect(headers.Authorization).toBe('Bearer old');
				return jsonResponse({ message: 'expired' }, 401);
			}
			return jsonResponse({ ok: true });
		});

		const onUnauthorized = vi.fn();
		const client = createFetchClient({
			baseUrl: '/api',
			getToken: () => 'old',
			// 注意：refresh 只返回新 token，**不**回写 getToken —— 证明重试用的是续期返回值
			refresh: async () => 'new',
			onUnauthorized,
		});

		await expect(client.get('/x')).resolves.toEqual({ ok: true });
		expect(attempt).toBe(2);
		expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer new');
		expect(onUnauthorized).not.toHaveBeenCalled();
	});

	it('401 + refresh 返回 null：不重试，抛 401 并通知一次', async () => {
		stubFetch(() => jsonResponse({ message: 'expired' }, 401));
		const onUnauthorized = vi.fn();
		const client = createFetchClient({ baseUrl: '/api', refresh: async () => null, onUnauthorized });

		await expect(client.get('/x')).rejects.toMatchObject({ status: 401 });
		expect(calls).toHaveLength(1);
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
	});

	it('401 + 续期后仍 401：最多重试一次，onUnauthorized 只通知一次', async () => {
		stubFetch(() => jsonResponse({ message: 'expired' }, 401));
		const onUnauthorized = vi.fn();
		const client = createFetchClient({
			baseUrl: '/api',
			getToken: () => 'old',
			refresh: async () => 'new',
			onUnauthorized,
		});

		await expect(client.get('/x')).rejects.toMatchObject({ status: 401 });
		expect(calls).toHaveLength(2);
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
	});

	it('调用方 signal 已 abort：立即失败（code=aborted，不冒充 timeout）', async () => {
		stubFetch(() => jsonResponse({ ok: true }));
		const client = createFetchClient({ baseUrl: '/api' });
		const controller = new AbortController();
		controller.abort();

		await expect(client.get('/x', { signal: controller.signal })).rejects.toMatchObject({
			status: 0,
			code: 'aborted',
		});
		expect(calls).toHaveLength(0);
	});

	it('超时：abort 归一为 status 0 / code timeout', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => {
							const error = new Error('aborted');
							error.name = 'AbortError';
							reject(error);
						});
					}),
			),
		);
		const client = createFetchClient({ baseUrl: '/api', timeoutMs: 5 });

		await expect(client.get('/slow')).rejects.toMatchObject({ status: 0, code: 'timeout' });
	});

	it('2xx 但响应不是合法 JSON ⇒ invalid_json', async () => {
		stubFetch(() => textResponse('<html>oops</html>'));
		const client = createFetchClient({ baseUrl: '/api' });

		await expect(client.get('/x')).rejects.toMatchObject({ status: 200, code: 'invalid_json' });
	});

	it('空响应体 ⇒ null（删除成功类）', async () => {
		stubFetch(() => textResponse('', 204));
		const client = createFetchClient({ baseUrl: '/api' });

		await expect(client.delete('/x')).resolves.toBeNull();
	});
});
