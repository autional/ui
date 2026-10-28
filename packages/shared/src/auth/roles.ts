/**
 * Autional 共享登录 URL 构建工具（仅 buildLoginUrl）
 *
 * 职责划分（AC-008）：
 * - 前端角色仅用于 UI 呈现（UX-only）；安全判断由后端 rbac-backed 授权强制。
 * - 角色获取统一走 userinfo-first：`getCurrentRole()`（store 派生，见 ./store）
 *   与 `useCurrentRole()`（响应式 hook，见 hooks/useCurrentRole）。
 */

import { getPortalUrl } from '../config';
import { resolveClientIdForSession } from './oauth-client-id-store';

/** auth-pages 的静态/受保护路由 — 首段不会是租户 slug */
const AUTH_ROUTE_RESERVED = new Set([
	'oauth',
	'login',
	'register',
	'forgot-password',
	'reset-password',
	'terms',
	'privacy',
	'error',
	'logout',
	'logout-confirm',
	'passkey',
	'reapply',
	'mfa',
	'account',
	'dashboard',
	'magic-link',
	'verify-email',
	'verify-phone',
	'mfa-challenge',
	'mfa-setup',
	'change-password',
	'recover-account',
	'account-deletion',
	'verify-identity',
]);

/**
 * 登出 URL（TASK-LS-08）：同源标准端点（RP-Initiated Logout 无 hint 形态）优先，
 * client_id 不可得时保持 legacy 形态。
 *
 * 标准端点形态（ADR-12 同源直通）：`${origin}/oauth/api/v1/oauth/logout`
 * - client_id：本部署的 OAuth 客户端（`resolveClientIdForSession` 三级来源：会话持久化
 *   localStorage `oauth_client_id` → env），服务端据此做 post_logout_redirect_uri 注册面白名单校验；
 * - post_logout_redirect_uri：本门户 origin 根（`<origin>/`，注册形态同 PlatformPortalRedirectURIs）；
 * - state：returnUrl 的 URL-safe 编码（门户零行为驱动——服务端只原样回拼到回跳 URL，门户不解析）。
 * 浏览器整页导航不带 Bearer → 服务端「无 hint 无会话浏览器」支 302 确认页承接；
 * 用户确认后由确认页经 BFF（会话 cookie → Bearer）触达端点，走认证会话支并导航服务端 location。
 *
 * legacy 兜底（D2=A 兼容分支保留，EntryRouter 承接）：client_id 不可得 → auth 域**裸根**入口 +
 * `logout=1` 显式登出意图标记。刻意不复用 buildLoginUrl：其租户 slug 保留会把 auth 域页面的
 * 登出落到 `/<slug>/login`（登录页路由，不经入口路由），`logout=1` 在那里被静默忽略；
 * 带会话回程甚至会被登录页 checkAndRedirect 直接放行成静默重登（F-W5c）。
 * 裸根 = EntryRouter 唯一登出闸门：先终结 auth 域会话，再决定落点——回程能解析出真实租户 →
 * 裸 `/<slug>/login`；否则落 brand 裸根。
 */
export function buildLogoutUrl(returnUrl?: string): string {
	const base = getPortalUrl('auth');
	// legacy 兜底：现行为保持（auth 裸根 + logout=1 意图标记）
	const legacy = (): string => {
		if (!base) return '/';
		const redirect = returnUrl ? `redirect=${encodeURIComponent(returnUrl)}&` : '';
		return `${base}/?${redirect}logout=1`;
	};

	const clientId = resolveClientIdForSession();
	if (!clientId || typeof window === 'undefined' || !window.location?.origin) return legacy();

	const params = new URLSearchParams();
	params.set('client_id', clientId);
	params.set('post_logout_redirect_uri', `${window.location.origin}/`);
	if (returnUrl) params.set('state', returnUrl);
	return `${window.location.origin}/oauth/api/v1/oauth/logout?${params.toString()}`;
}

/**
 * 当前页是否已是 auth 的「登录承接面」——裸根入口（`/`、`/login`，由入口路由承接）、
 * `/<slug>/login` 登录页、`/error` 错误页。
 *
 * 会话终结（onUnauthorized）时若已停在承接面，整页 replace 不但无益（目标就是本页），
 * 还会因 buildLoginUrl 的防嵌套截断返回不带 redirect 的本页 —— 把 URL 中的回程目标
 * 一并丢掉，且构成一次整页闪烁（F-W8b 修复②：存量过期 token 在登录页「静默弹走」）。
 */
export function isAuthLoginSurface(): boolean {
	if (typeof window === 'undefined') return false;
	const segs = window.location.pathname.split('/').filter(Boolean);
	if (segs.length === 0) return true; // 裸根 `/`
	if (segs[0] === 'login' || segs[0] === 'error') return true; // `/login`、`/error`
	return segs.length === 2 && segs[1] === 'login'; // `/<slug>/login`
}

export function buildLoginUrl(
	returnUrl?: string,
	fromRequireAuth?: boolean,
	tenantSlug?: string | null,
): string {
	const base = getPortalUrl('auth');
	if (!base) return '/';

	// 租户上下文优先级：显式 tenantSlug > returnUrl 首段推导 > auth 根（租户选择页）。
	// 显式参数用于「站点在根路径（无 slug）但已知当前/最近租户」的场景。
	let loginBase = tenantSlug ? `${base}/${encodeURIComponent(tenantSlug)}/login` : base;
	if (!tenantSlug && returnUrl) {
		try {
			const clean = new URL(returnUrl, typeof window !== 'undefined' ? window.location.origin : '');
			const baseOrigin = new URL(base).origin;
			const firstSeg = clean.pathname.split('/').filter(Boolean)[0];
			if (
				clean.origin === baseOrigin &&
				firstSeg &&
				!AUTH_ROUTE_RESERVED.has(firstSeg.toLowerCase())
			) {
				loginBase = `${base}/${firstSeg}/login`;
			}
		} catch {
			/* invalid URL — fall through */
		}
	}

	if (returnUrl) {
		// 防止嵌套 redirect：仅当 returnUrl 落在 auth 域且本身已是登录页时才截断
		try {
			const clean = new URL(returnUrl, typeof window !== 'undefined' ? window.location.origin : '');
			const baseOrigin = new URL(base).origin;
			if (
				clean.origin === baseOrigin &&
				(clean.pathname === '/' || clean.pathname.endsWith('/login') || clean.href === base)
			) {
				return fromRequireAuth ? `${loginBase}?from_requireauth=1` : loginBase;
			}
		} catch {
			/* invalid URL — fall through */
		}
		const qs = `?redirect=${encodeURIComponent(returnUrl)}`;
		if (fromRequireAuth) {
			return `${loginBase}${qs}&from_requireauth=1`;
		}
		return `${loginBase}${qs}`;
	}
	if (fromRequireAuth) {
		return `${loginBase}?from_requireauth=1`;
	}
	return loginBase;
}
