// @vitest-environment jsdom
// ============================================================
// 会话心跳 hook 契约锁（2026-11-10 会话策略交接 §3.3）：
//  ① 端点由调用方给定（管理面 /admin/sessions/me/activity、用户面 /sessions/me/activity）
//  ② getToken 可注入（config/secret 用本地 @/lib/auth，不复用 shared store）
//  ③ 三道闸门：页面不可见不发 / 最近无交互不发 / 未到间隔不发
//  ④ 缺 sid 不发（服务端按 token 归属，前端不拼 sid）
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useSessionActivity } from '../useSessionActivity';

/** 构造一个带 sid 的假 JWT（签名无关，只解码 payload）。 */
function fakeToken(payload: Record<string, unknown>): string {
	const b64 = (obj: Record<string, unknown>) =>
		Buffer.from(JSON.stringify(obj)).toString('base64url');
	return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockClear();
	Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('useSessionActivity', () => {
	it('可见 + 有交互 + 到间隔 → 按调用方端点发一次心跳', () => {
		const token = fakeToken({ custom: { sid: 'sid-1' }, tenant_id: 't-1' });
		renderHook(() =>
			useSessionActivity({ endpoint: '/bff/session/api/v1/admin/sessions/me/activity', getToken: () => token }),
		);

		vi.advanceTimersByTime(5 * 60_000);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/bff/session/api/v1/admin/sessions/me/activity');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ' + token);
		expect((init.headers as Record<string, string>)['X-Tenant-ID']).toBe('t-1');
	});

	it('页面不可见 → 不发', () => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		renderHook(() =>
			useSessionActivity({ endpoint: '/x', getToken: () => fakeToken({ custom: { sid: 's' } }) }),
		);
		vi.advanceTimersByTime(10 * 60_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('没有 sid → 不发（服务端按 token 归属，前端不拼 sid）', () => {
		renderHook(() =>
			useSessionActivity({ endpoint: '/x', getToken: () => fakeToken({ sub: 'u-1' }) }),
		);
		vi.advanceTimersByTime(10 * 60_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('超过交互窗口无交互 → 停发（人不在就让会话自然过期）', () => {
		renderHook(() =>
			useSessionActivity({ endpoint: '/x', getToken: () => fakeToken({ custom: { sid: 'sid-1' } }) }),
		);

		vi.advanceTimersByTime(5 * 60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 之后 15 分钟无人交互（lastInteraction 停在挂载时刻）
		vi.advanceTimersByTime(15 * 60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('disabled → 完全不发', () => {
		renderHook(() =>
			useSessionActivity({ endpoint: '/x', getToken: () => fakeToken({ custom: { sid: 's' } }), disabled: true }),
		);
		vi.advanceTimersByTime(10 * 60_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
