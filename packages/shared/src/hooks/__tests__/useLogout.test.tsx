// @vitest-environment jsdom
// ============================================================
// AUTH-40：useLogout 落点口径锁——
//  ① 缺省回程 = 捕获的当前 URL（EntryRouter 据此解析租户 → /<slug>/login）
//  ② returnUrl 覆盖：裸 /logout 无 URL 租户段时由调用方补回上下文
//  ③ 顺序契约：先终结会话（AuthService.logout）再导航
// TASK-LS-08：client_id 可得 → 同源标准端点（post_logout_redirect_uri=门户根；state 携回程）
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockLogout, mockTraceRedirect } = vi.hoisted(() => ({
	mockLogout: vi.fn(() => Promise.resolve()),
	mockTraceRedirect: vi.fn(),
}));

vi.mock('../../auth/service', () => ({ AuthService: { logout: mockLogout } }));
vi.mock('../../auth/auth-trace', () => ({ traceRedirect: mockTraceRedirect }));
vi.mock('../../config', () => ({
	getPortalUrl: (portal: string) => (portal === 'auth' ? 'https://auth.example.com' : ''),
}));

import { useLogout } from '../useLogout';

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	window.history.replaceState(null, '', '/demo/dashboard');
});

describe('useLogout 落点口径（AUTH-40）', () => {
	it('缺省：回程 = 当前 URL（带租户段），先登出后导航', async () => {
		const { result } = renderHook(() => useLogout());
		result.current();

		await vi.waitFor(() => expect(mockTraceRedirect).toHaveBeenCalledTimes(1));
		expect(mockLogout).toHaveBeenCalledTimes(1);

		const [url, opts] = mockTraceRedirect.mock.calls[0];
		expect(url).toBe(
			'https://auth.example.com/?redirect=' +
				encodeURIComponent('http://localhost:3000/demo/dashboard') +
				'&logout=1',
		);
		expect(opts).toMatchObject({ reason: 'logout', assign: true });
		expect(mockLogout.mock.invocationCallOrder[0]).toBeLessThan(
			mockTraceRedirect.mock.invocationCallOrder[0] as number,
		);
	});

	it('returnUrl 覆盖：裸 /logout 用调用方补回的租户上下文（无渲染页 URL 依赖）', async () => {
		const { result } = renderHook(() => useLogout({ returnUrl: '/demo/dashboard' }));
		result.current();

		await vi.waitFor(() => expect(mockTraceRedirect).toHaveBeenCalledTimes(1));
		const [url] = mockTraceRedirect.mock.calls[0];
		expect(url).toBe(
			'https://auth.example.com/?redirect=' +
				encodeURIComponent('/demo/dashboard') +
				'&logout=1',
		);
	});

	// TASK-LS-08：client_id 可得（会话持久化）→ 同源标准端点（不再 legacy logout=1）；
	// 顺序契约不变：先终结会话（AuthService.logout）再导航。
	it('client_id 可得：同源标准端点 + 门户根回跳 + state 携当前 URL，顺序仍先清再跳', async () => {
		localStorage.setItem('oauth_client_id', 'cid-logout');
		const { result } = renderHook(() => useLogout());
		result.current();

		await vi.waitFor(() => expect(mockTraceRedirect).toHaveBeenCalledTimes(1));
		expect(mockLogout).toHaveBeenCalledTimes(1);

		const [url, opts] = mockTraceRedirect.mock.calls[0];
		expect(url).toBe(
			'http://localhost:3000/oauth/api/v1/oauth/logout?client_id=cid-logout&post_logout_redirect_uri=' +
				encodeURIComponent('http://localhost:3000/') +
				'&state=' +
				encodeURIComponent('http://localhost:3000/demo/dashboard'),
		);
		expect(opts).toMatchObject({ reason: 'logout', assign: true });
		expect(mockLogout.mock.invocationCallOrder[0]).toBeLessThan(
			mockTraceRedirect.mock.invocationCallOrder[0] as number,
		);
	});
});
