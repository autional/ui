// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TenantIndexGuard, usePublicTenantSlugs } from '../TenantIndexGuard';

function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			// 重试由**本测试客户端**声明（生产里由消费方 QueryClient 默认决定；本包不再声明 retry，
			// 否则会盖过消费方默认 —— rc.35 起如此）。retry:1 + retryDelay:0 让
			// 「重试耗尽后错误必须上抛」这一断言仍可验证，且失败用例不白等默认退避。
			queries: { retry: 1, retryDelay: 0, gcTime: Infinity },
		},
	});
}

function wrapper(children: ReactNode) {
	return <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>;
}

/** mock fetch 返回 items 数组的 ListResponse */
function stubFetch(items: unknown[], ok = true, status = 200) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok,
			status,
			json: async () => ({ code: 0, message: 'success', items, total: items.length }),
		}),
	);
}

function stubFetchData(items: unknown[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ code: 0, message: 'success', data: items }),
		}),
	);
}

function stubFetchReject() {
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
}

function stubFetchNonOk() {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
}

function stubFetchBadShape() {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ foo: 'bar' }),
		}),
	);
}

function setPath(path: string) {
	window.history.pushState({}, '', path);
}

describe('usePublicTenantSlugs（响应契约解析）', () => {
	beforeEach(() => {
		setPath('/acme-corp');
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('ListResponse 用 items 字段 → 返回租户数组（修复回归）', async () => {
		stubFetch([
			{ id: '1', name: 'acme-corp' },
			{ id: '2', name: 'beta-inc' },
		]);
		let result: unknown[] | undefined;
		function Harness() {
			const q = usePublicTenantSlugs();
			result = q.data;
			return null;
		}
		render(wrapper(<Harness />));
		await waitFor(() =>
			expect(result).toEqual([
				{ id: '1', name: 'acme-corp' },
				{ id: '2', name: 'beta-inc' },
			]),
		);
	});

	it('旧 data 字段兼容 → 返回租户数组', async () => {
		stubFetchData([{ id: '1', name: 'acme-corp' }]);
		let result: unknown[] | undefined;
		function Harness() {
			const q = usePublicTenantSlugs();
			result = q.data;
			return null;
		}
		render(wrapper(<Harness />));
		await waitFor(() => expect(result).toEqual([{ id: '1', name: 'acme-corp' }]));
	});

	it('API 非 200 → 上抛进入 error 态，不吞成空数组成功（rc.35）', async () => {
		stubFetchNonOk();
		let state: { isError: boolean; data: unknown[] | undefined } | undefined;
		function Harness() {
			const q = usePublicTenantSlugs();
			state = { isError: q.isError, data: q.data };
			return null;
		}
		render(wrapper(<Harness />));
		await waitFor(() => expect(state?.isError).toBe(true));
		expect(state?.data).toBeUndefined();
	});

	it('网络异常 → 上抛进入 error 态（retry 不再被吞错架空，rc.35）', async () => {
		stubFetchReject();
		let state: { isError: boolean; data: unknown[] | undefined } | undefined;
		function Harness() {
			const q = usePublicTenantSlugs();
			state = { isError: q.isError, data: q.data };
			return null;
		}
		render(wrapper(<Harness />));
		await waitFor(() => expect(state?.isError).toBe(true));
		expect(state?.data).toBeUndefined();
	});

	it('fetch 携带 AbortSignal（8s 超时接线，rc.35）', async () => {
		stubFetch([{ id: '1', name: 'acme-corp' }]);
		let result: unknown[] | undefined;
		function Harness() {
			const q = usePublicTenantSlugs();
			result = q.data;
			return null;
		}
		render(wrapper(<Harness />));
		await waitFor(() => expect(result).toEqual([{ id: '1', name: 'acme-corp' }]));
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('超时 abort（AbortError）→ 上抛进入 error 态，不吞（rc.35）', async () => {
		const signals: AbortSignal[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					signals.push(init!.signal!);
					init!.signal!.addEventListener('abort', () =>
						reject(new DOMException('The operation was aborted.', 'AbortError')),
					);
				});
			}),
		);
		let isError = false;
		function Harness() {
			const q = usePublicTenantSlugs();
			isError = q.isError;
			return null;
		}
		render(wrapper(<Harness />));
		// 模拟计时器到点 abort（计时器-到点→abort 是标准库行为，此处验 abort 错误的上抛路径）；
		// hook retry:1 → 两跳都要 abort 才耗尽重试
		await waitFor(() => expect(signals.length).toBeGreaterThan(0));
		signals[0].dispatchEvent(new Event('abort'));
		await waitFor(() => expect(signals.length).toBeGreaterThan(1));
		signals[1].dispatchEvent(new Event('abort'));
		await waitFor(() => expect(isError).toBe(true));
	});

	it('响应无 items/data 且非数组 → 返回空数组', async () => {
		stubFetchBadShape();
		let result: unknown[] | undefined;
		function Harness() {
			const q = usePublicTenantSlugs();
			result = q.data;
			return null;
		}
		render(wrapper(<Harness />));
		await waitFor(() => expect(result).toEqual([]));
	});
});

describe('TenantIndexGuard（P0-2 slug 白名单守卫）', () => {
	const children = <div data-testid="children">Home</div>;
	const notFound = <div data-testid="notfound">404</div>;

	beforeEach(() => {
		setPath('/acme-corp');
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('slug 在白名单 → 渲染 children', async () => {
		stubFetch([{ id: '1', name: 'acme-corp' }]);
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('children')).toBeInTheDocument());
		expect(screen.queryByTestId('notfound')).toBeNull();
	});

	it('slug 不在白名单 → 渲染 notFound（修复回归：无效 slug 此前错误渲染首页）', async () => {
		stubFetch([{ id: '1', name: 'acme-corp' }]);
		setPath('/nonexistent-tenant');
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('notfound')).toBeInTheDocument());
		expect(screen.queryByTestId('children')).toBeNull();
	});

	it('白名单为空数组 → 放行渲染 children（API 挂掉时退化为不拦截）', async () => {
		stubFetch([]);
		setPath('/any-slug');
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('children')).toBeInTheDocument());
	});

	it('名单接口失败（重试耗尽 error）→ fail-open 渲染 children，不白屏不 404（rc.35）', async () => {
		stubFetchReject();
		setPath('/any-slug');
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('children')).toBeInTheDocument());
		expect(screen.queryByTestId('notfound')).toBeNull();
	});

	it('slug 有效 + 子路径（/acme-corp/terms）→ 渲染 children（回归：子路由此前被段数检查误杀）', async () => {
		stubFetch([{ id: '1', name: 'acme-corp' }]);
		setPath('/acme-corp/terms');
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('children')).toBeInTheDocument());
		expect(screen.queryByTestId('notfound')).toBeNull();
	});

	it('slug 无效 + 子路径（/nonexistent-tenant/terms）→ 渲染 notFound', async () => {
		stubFetch([{ id: '1', name: 'acme-corp' }]);
		setPath('/nonexistent-tenant/terms');
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('notfound')).toBeInTheDocument());
		expect(screen.queryByTestId('children')).toBeNull();
	});

	it('加载中 → 渲染 loading 占位', async () => {
		let resolveFetch: (v: unknown) => void;
		const pending = new Promise((res) => {
			resolveFetch = res;
		});
		vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
		setPath('/acme-corp');
		const loading = <div data-testid="loading">Loading...</div>;
		render(
			wrapper(
				<TenantIndexGuard notFound={notFound} loading={loading}>
					{children}
				</TenantIndexGuard>,
			),
		);
		expect(screen.getByTestId('loading')).toBeInTheDocument();
		await resolveFetch!({
			ok: true,
			status: 200,
			json: async () => ({ code: 0, items: [{ id: '1', name: 'acme-corp' }] }),
		});
		await waitFor(() => expect(screen.getByTestId('children')).toBeInTheDocument());
	});

	it('空 slug（根路径 /）→ 渲染 children', async () => {
		stubFetch([{ id: '1', name: 'acme-corp' }]);
		setPath('/');
		render(wrapper(<TenantIndexGuard notFound={notFound}>{children}</TenantIndexGuard>));
		await waitFor(() => expect(screen.getByTestId('children')).toBeInTheDocument());
	});
});
