import { useEffect, useRef } from 'react';

import { getAccessToken } from '../auth/store';
import { decodeJwtPayload } from '../auth/jwt-payload';

/** 心跳间隔：闲置 30 分钟的 1/6（业界常用 5 分钟）。 */
const DEFAULT_PING_INTERVAL = 5 * 60_000;
/** 检查节拍：每秒级太重，1 分钟一次足够（真正的间隔由 pingInterval 控制）。 */
const DEFAULT_TICK_INTERVAL = 60_000;
/** 交互新鲜度：超过这个时间没交互就不发心跳（人不在，让会话自然闲置过期）。 */
const DEFAULT_INTERACTION_FRESH = 5 * 60_000;

export interface UseSessionActivityOptions {
	/**
	 * 心跳端点。管理面用 `/bff/session/api/v1/admin/sessions/me/activity`，
	 * 用户面用 `/bff/session/api/v1/sessions/me/activity`。
	 */
	endpoint: string;
	/**
	 * 取 access token。默认用 shared 的 `getAccessToken`；
	 * 门户若用本地 auth 模块（如 config/secret 的 `@/lib/auth`），可注入自己的实现。
	 */
	getToken?: () => string | null;
	/** 心跳最小间隔，默认 5 分钟。 */
	pingIntervalMs?: number;
	/** 检查节拍，默认 60 秒。 */
	tickIntervalMs?: number;
	/** 交互新鲜度窗口，默认 5 分钟。 */
	interactionFreshMs?: number;
	/** 关闭开关（灰度/测试用），默认 false。 */
	disabled?: boolean;
}

function str(source: Record<string, unknown> | null | undefined, key: string): string {
	const value = source?.[key];
	return typeof value === 'string' ? value : '';
}

/**
 * 会话活动心跳（NIST「activity resets inactivity」口径）。
 *
 * 只在「页面可见 + 最近 N 分钟有真实交互」时上报；失败静默，不影响业务请求。
 * 服务端首次心跳把会话切到闲置策略（opt-in），未接心跳的客户端不受影响。
 * 心跳只续闲置窗口，绝对上限由服务端固定，心跳无法突破。
 */
export function useSessionActivity(options: UseSessionActivityOptions): void {
	const {
		endpoint,
		getToken = getAccessToken,
		pingIntervalMs = DEFAULT_PING_INTERVAL,
		tickIntervalMs = DEFAULT_TICK_INTERVAL,
		interactionFreshMs = DEFAULT_INTERACTION_FRESH,
		disabled = false,
	} = options;

	const lastInteraction = useRef(Date.now());
	const lastPing = useRef(0);

	// 依赖项放在 ref 里，避免调用方每次渲染传新对象导致定时器重建。
	const config = useRef({ endpoint, getToken, pingIntervalMs, tickIntervalMs, interactionFreshMs, disabled });
	config.current = { endpoint, getToken, pingIntervalMs, tickIntervalMs, interactionFreshMs, disabled };

	useEffect(() => {
		const mark = () => {
			lastInteraction.current = Date.now();
		};
		const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
		events.forEach((name) => window.addEventListener(name, mark, { passive: true }));

		const ping = () => {
			const cfg = config.current;
			if (cfg.disabled) return;
			const token = cfg.getToken();
			if (!token) return;
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			const now = Date.now();
			if (now - lastInteraction.current > cfg.interactionFreshMs) return;
			if (now - lastPing.current < cfg.pingIntervalMs) return;
			const claims = decodeJwtPayload(token);
			const custom = (claims?.custom ?? null) as Record<string, unknown> | null;
			const sid = str(custom, 'sid') || str(custom, 'session_id') || str(claims, 'session_id');
			if (!sid) return;
			lastPing.current = now;
			const headers: Record<string, string> = {
				Accept: 'application/json',
				Authorization: 'Bearer ' + token,
			};
			const tenant = str(claims, 'tenant_id') || str(custom, 'tenant_id');
			const app = str(claims, 'app_id') || str(custom, 'app_id');
			if (tenant) headers['X-Tenant-ID'] = tenant;
			if (app) headers['X-App-ID'] = app;
			void fetch(cfg.endpoint, { method: 'POST', headers, credentials: 'omit' }).catch(() => undefined);
		};

		const timer = window.setInterval(ping, tickIntervalMs);
		const onVisible = () => {
			if (document.visibilityState === 'visible') ping();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			events.forEach((name) => window.removeEventListener(name, mark));
			window.clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, [tickIntervalMs]);
}
