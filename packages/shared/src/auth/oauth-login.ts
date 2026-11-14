/**
 * Dev-mode OAuth PKCE login utilities
 *
 * Used by RequireAuth when VITE_OAUTH_CLIENT_ID is configured.
 * Supports 3 profiles:
 *   - dev:   API=localhost, OAuth=off (password login, no OAuth)
 *   - oauth: API=localhost, OAuth=on  (local Docker API, tianv.local OAuth)
 *   - prod:  API=production, OAuth=on (production API, iam.tianv.com OAuth)
 */

import { apiClient } from '../api/client';
import { loginWithTokens } from './store';
import { AuthService } from './service';
import { generatePKCE } from './pkce';
import { getPortalUrl } from '../config';
import { persistOAuthClientId } from './oauth-client-id-store';
import { traceRedirect } from './auth-trace';
import { decodeJwtPayload } from './jwt-payload';
import type { User } from '../types';

function getAppConfig(): Record<string, string> | undefined {
	if (typeof window !== 'undefined') {
		return (window as any).__APP_CONFIG__;
	}
	return undefined;
}

const SK = {
	PKCE: 'oauth_pkce_verifier',
	STATE: 'oauth_state',
	INIT_TS: 'oauth_init_ts',
	CID: 'oauth_client_id',
};

/**
 * 第一方门户登录申请的 scope —— **单一真源**。
 *
 * `read` 自 2026-11-06 起是必需项：平台读接口（rbac / identity / profile 等 18 个服务
 * 与网关 BFF）统一 `RequireScopes("read")`，令牌不带 `read` 会直接 403。
 * 所有第一方客户端在 `oauth_clients.scopes` 里都已登记 `read`，只是必须**申请**才会进令牌。
 *
 * 改这里之前先确认：服务端新增的 enforce scope 必须 ⊆ 本字符串（否则登录能成、接口 403）。
 */
export const OAUTH_LOGIN_SCOPES = 'openid profile email offline_access read';

/** 把 `extra` 并入基础登录 scope：去重、保持顺序（基础项在前，新增项按传入次序追加）。 */
export function withOAuthScopes(...extra: string[]): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [OAUTH_LOGIN_SCOPES, ...extra]) {
		for (const s of String(raw ?? '')
			.trim()
			.split(/\s+/)
			.filter(Boolean)) {
			if (seen.has(s)) continue;
			seen.add(s);
			out.push(s);
		}
	}
	return out.join(' ');
}

/**
 * 第一方门户登录申请的**完整 scope 档**（基础档 + 业务写能力）。
 *
 * 2026-11-14 事故：用户门户「短信验证 → 验证并开启」返回 403
 * `token scope does not allow this operation` —— 登录只申请了 `read`，而 MFA 写接口自
 * 2026-11-06 起强制 `mfa:write`。同类受影响的还有通知流 stream-ticket（`write`）、
 * 社交账号绑定/解绑与授权撤销（`oauth:write`）、钱包/积分/支付/账单写（`*:write`）。
 *
 * 服务端 `oauth_clients.scopes` 已为全部首方门户 client（9 个固定 client +
 * 全部租户 Default Client）登记了这套 scope；缺的一直只是「登录时申请」这一步。
 * 认证器 PWA 另有更窄的档位（`withOAuthScopes('write')`，见 ADR-027 D2），不得使用本常量。
 */
export const PORTAL_LOGIN_SCOPES = withOAuthScopes(
	'write',
	'wallet:write',
	'point:write',
	'pay:write',
	'billing:write',
	'oauth:write',
	'mfa:write',
);

/** granted 是否覆盖 required 要求的全部 scope（空格分隔；`*` 通配覆盖一切）。 */
export function scopesCover(granted: string | null | undefined, required: string): boolean {
	const have = new Set(
		String(granted ?? '')
			.trim()
			.split(/\s+/)
			.filter(Boolean),
	);
	if (have.has('*')) return true;
	return String(required ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.every((s) => have.has(s));
}

/**
 * 现有令牌是否需要一次性 scope 升级（2026-11-14 前签发的令牌只带基础档）。
 *
 * 只对 **OAuth 令牌**（`custom.client_id` 存在）判定：会话 / SAML / identity 直签令牌
 * 没有业务 scope 语义（`custom.scope` 含 `*` 或压根没有 client_id），不会被 scope 门禁拦。
 * 模拟会话（`custom.is_imp`，平台→管理台交接）必须跳过——升级会把它换成本人令牌。
 */
export function tokenNeedsPortalScopeUpgrade(token: string | null | undefined): boolean {
	if (!token) return false;
	const payload = decodeJwtPayload(token) as { custom?: Record<string, unknown> } | null;
	const custom = payload?.custom;
	if (!custom) return false;
	if (typeof custom.client_id !== 'string' || !custom.client_id) return false;
	if (custom.is_imp === true) return false;
	const scope = typeof custom.scope === 'string' ? custom.scope : '';
	if (scope.split(/\s+/).includes('*')) return false;
	return !scopesCover(scope, PORTAL_LOGIN_SCOPES);
}

export interface OAuthInitiateOptions {
	/** 「停留」取消本次跳转时回调（AUTH-03，调用方据此恢复 UI）；内部已先清预置物 |
	 *  与待重试定时器（AUTH-08），再次交互可全新发起。 */
	onStay?: () => void;
	/** 跳过 10s 防重入窗口（用户显式点「前往登录」重试时用，AUTH-03）。 */
	force?: boolean;
	/**
	 * 本次登录申请的 scope（缺省 = `OAUTH_LOGIN_SCOPES`，即既有行为）。
	 * 用 `withOAuthScopes('write')` 生成，供需要写 scope 的第一方客户端使用
	 * （例：authenticator-app 的推送登记 / stream-ticket 需 `write`）。
	 * 空串或纯空白视同未传。服务端仍会按 `oauth_clients.scopes` 校验，未登记项会被拒绝。
	 */
	scope?: string;
	/**
	 * 静默发起：流程内部步骤（如旧令牌的一次性 scope 升级），不弹「即将离开本页」
	 * 提示条，直接整页跳转（trace 记 funnel）。用户主动登录不要设置。
	 */
	silent?: boolean;
}

/**
 * AUTH-46②：OAuth 回调失败错误——携稳定 code，消费方（OAuthCallbackPage 等）按 code
 * 映射本地化文案；message 保留英文原文供 console/诊断。此前直接 throw 英文裸句
 * （"State mismatch — possible CSRF attack" 等）落用户屏。
 */
export class OAuthCallbackError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'OAuthCallbackError';
		this.code = code;
	}
}

// 防重入拦截后的一次性重试 timer（避免 10 秒窗口内快速刷新导致 OAuth 跳转被吞、页面卡住）
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 丢弃未完成的 OAuth 发起留下的全部预置物（AUTH-08 会话卫生）：
 * 取消待重试定时器 + 清 sessionStorage 四键（state/verifier/client_id/init_ts）。
 * 「停留」（handleStay）与登出（AuthService.logout）共用——两者都意味着
 * 「本次发起已作废」：不清则 ① 窗口过期后自动重试仍会把用户弹走；
 * ② 明文 verifier 与 state 跨登出残留在 tab 里。
 */
export function discardPendingOAuthLogin(): void {
	if (typeof window === 'undefined') return;
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	sessionStorage.removeItem(SK.STATE);
	sessionStorage.removeItem(SK.PKCE);
	sessionStorage.removeItem(SK.CID);
	sessionStorage.removeItem(SK.INIT_TS);
}

function parseUserFromToken(token?: string, apiUser?: unknown): User {
	if (token) {
		const p = decodeJwtPayload(token);
		if (p) {
			return {
				id: (p.sub || p.user_id) as string,
				username: ((p as any).custom?.username || (p as any).username) as string,
				email: p.email as string,
				status: 'active',
				avatarUrl: p.picture as string,
			} as unknown as User;
		}
	}
	return apiUser as User;
}

function envVar(key: string): string {
	const cfg = getAppConfig();
	if (cfg && cfg[key]) return cfg[key];
	try {
		return (import.meta as any).env?.[key] || '';
	} catch {
		return '';
	}
}

function getConfig() {
	const base = getPortalUrl('auth');
	const callbackPath = (window as any).__APP_CONFIG__?.BASE_PATH || '/';
	const origin = window.location.origin;
	return {
		clientId: envVar('VITE_OAUTH_CLIENT_ID'),
		authorizeUrl: `${base}/oauth/api/v1/oauth/authorize`,
		redirectUri:
			callbackPath === '/' ? `${origin}/oauth/callback` : `${origin}${callbackPath}/oauth/callback`,
		scope: OAUTH_LOGIN_SCOPES,
	};
}

export function isOAuthEnabled(): boolean {
	return !!envVar('VITE_OAUTH_CLIENT_ID');
}

function randomState(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		try {
			return crypto.randomUUID();
		} catch {
			/* fall through to getRandomValues */
		}
	}
	// crypto.getRandomValues is available in non-secure contexts too (unlike
	// randomUUID, which requires HTTPS/localhost). This value is used as the
	// OAuth state CSRF token — never degrade to a state-recoverable, predictable
	// PRNG or a timestamp (both are attackable for CSRF forgery). Fail loud.
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	throw new Error('No CSPRNG available — cannot generate secure OAuth state');
}

export async function initiateOAuthLogin(
	clientId?: string,
	redirectTarget?: string,
	opts?: OAuthInitiateOptions,
): Promise<void> {
	const ts = sessionStorage.getItem(SK.INIT_TS);
	if (!opts?.force && ts && Date.now() - parseInt(ts, 10) < 10000) {
		// 防重入：10 秒内已有一次 OAuth 初始化（如快速刷新/重复导航）。
		// 直接 return 会吞掉跳转导致 RequireAuth 卡在空白页（无 re-render 不会重试），
		// 因此在窗口过期后安排一次自动重试，保证最终完成跳转。
		const wait = 10000 - (Date.now() - parseInt(ts, 10)) + 100;
		if (!retryTimer) {
			retryTimer = setTimeout(() => {
				retryTimer = null;
				// scope 必须随重试带下去：否则自动重试会把调用方申请的额外 scope 丢掉
				// （表现为「登录成功但写接口 403」，且极难复现）。
				void initiateOAuthLogin(clientId, redirectTarget, {
					...(opts?.scope ? { scope: opts.scope } : {}),
					...(opts?.silent ? { silent: true } : {}),
				});
			}, wait);
		}
		return;
	}
	// 本次发起取代任何待重试定时器（含 force 绕过窗口时的遗留）
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	sessionStorage.setItem(SK.INIT_TS, String(Date.now()));

	// Determine the URL to redirect to after successful OAuth
	const target = redirectTarget || window.location.href;

	// Derive OAuth config (redirectUri computed from BASE_PATH, consistent with handleOAuthCallback)
	const cfg = getConfig();
	const cid = clientId || cfg.clientId;
	if (!cid) throw new Error('OAuth client_id is not available');

	// 申请 scope：调用方显式传入则用之（含额外 scope），否则沿用基础 scope（零波及其它站点）
	const requestedScope = opts?.scope?.trim() || cfg.scope;

	// Always encode state as JSON with CSRF token + redirect target
	const csrf = randomState();
	const state = JSON.stringify({ csrf, redirect: target });

	sessionStorage.setItem(SK.STATE, csrf);
	sessionStorage.setItem(SK.CID, cid);
	// 交棒时落持久层：刷新/登出在 React 上下文外，拿不到 slug 解析结果（TASK-09 / D8）
	persistOAuthClientId(cid);

	// 「停留」= 放弃本次发起：清预置物 + 取消待重试定时器，防止窗口过期后
	// 自动重试再把用户弹走；随后通知调用方恢复 UI（AUTH-03/08）。
	const handleStay = () => {
		discardPendingOAuthLogin();
		opts?.onStay?.();
	};

	// silent（流程内部步骤，如 scope 升级）：静默整页跳，不弹「即将离开本页」提示条。
	const traceKind = opts?.silent ? 'funnel' : 'interstitial';
	const traceReason = opts?.silent ? 'oauth-scope-upgrade' : 'oauth-initiate';

	try {
		const pkce = await generatePKCE();
		sessionStorage.setItem(SK.PKCE, pkce.verifier);
		const params = new URLSearchParams({
			response_type: 'code',
			client_id: cid,
			redirect_uri: cfg.redirectUri,
			scope: requestedScope,
			code_challenge: pkce.challenge,
			code_challenge_method: 'S256',
			state,
		});
		// interstitial：未认证深链被动弹去登录 → authTrace 提示（可停留）。
		traceRedirect(`${cfg.authorizeUrl}?${params}`, {
			reason: traceReason,
			kind: traceKind,
			assign: true,
			onStay: handleStay,
		});
	} catch {
		const params = new URLSearchParams({
			response_type: 'code',
			client_id: cid,
			redirect_uri: cfg.redirectUri,
			scope: requestedScope,
			state,
		});
		traceRedirect(`${cfg.authorizeUrl}?${params}`, {
			reason: traceReason,
			kind: traceKind,
			assign: true,
			onStay: handleStay,
		});
	}
}

export async function handleOAuthCallback(): Promise<void> {
	const q = new URLSearchParams(window.location.search);

	const err = q.get('error');
	if (err) {
		throw new OAuthCallbackError(
			'oauth.provider_error',
			q.get('error_description') || `OAuth error: ${err}`,
		);
	}

	const code = q.get('code');
	if (!code) throw new OAuthCallbackError('oauth.missing_code', 'Missing authorization code');

	const storedState = sessionStorage.getItem(SK.STATE) || '';
	const verifier = sessionStorage.getItem(SK.PKCE) || '';
	const cid = sessionStorage.getItem(SK.CID) || '';

	// State is always JSON: { csrf, redirect }
	let oauthRedirectTarget: string | null = null;
	const rawState = q.get('state');
	if (rawState) {
		try {
			const parsed = JSON.parse(rawState);
			if (parsed.csrf && parsed.csrf === storedState) {
				oauthRedirectTarget = parsed.redirect || null;
			} else if (parsed.csrf) {
				throw new OAuthCallbackError(
					'oauth.state_mismatch',
					'State mismatch — possible CSRF attack',
				);
			}
		} catch (e) {
			if (e instanceof OAuthCallbackError) throw e;
			// Backward compat: plain string state (should not happen after Fix 3)
			if (rawState !== storedState) {
				throw new OAuthCallbackError(
					'oauth.state_mismatch',
					'State mismatch — possible CSRF attack',
				);
			}
		}
	}

	if (!verifier) {
		throw new OAuthCallbackError(
			'oauth.pkce_cleared',
			'Missing PKCE verifier — page reload may have cleared storage',
		);
	}

	// Derive redirectUri from getConfig() for consistency with initiateOAuthLogin
	const cbCfg = getConfig();
	const redirectUri = cbCfg.redirectUri;

	const res = await apiClient.post(
		'/oauth/api/v1/oauth/token', // @generated-api-exempt
		new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: cid,
			client_secret: '',
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}).toString(),
		{ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
	);

	// 用毕即焚（AUTH-08）：兑换请求已消费 code_verifier/state/client_id，立即清除；
	// 原清理点在 userinfo、/auth/me 多次 await 之后，明文 verifier 驻留窗口被无谓拉长。
	sessionStorage.removeItem(SK.PKCE);
	sessionStorage.removeItem(SK.STATE);
	sessionStorage.removeItem(SK.CID);

	const t = res.data as any;
	const accessToken = t.access_token;
	const refreshToken = t.refresh_token || null;

	// Prefer id_token for user info, fallback to /auth/me.
	// IMPORTANT: loginWithTokens (which populates the auth store) runs AFTER this block,
	// so the interceptor would send NO Authorization header here. Attach the freshly
	// exchanged access_token explicitly — otherwise /auth/me 401s and the apiClient
	// interceptor routes it through onUnauthorized (no refresh token yet) → bounce back
	// to the login page with the now-consumed code → infinite redirect loop.
	// oauth 服务的 id_token（oidc_signer.go SignIDToken）只含 sub/aud/iss/exp 等标准 claim，
	// 不含 email/username。若直接采信，/auth/me 兜底被短路 → store 落残缺 user →
	// UserMenu 等消费方显示「未登录」。缺身份字段的解析结果视为信息不足，交棒 /auth/me。
	let user: User | null = parseUserFromToken(t.id_token);
	if (user && !user.username && !user.email) {
		user = null;
	}
	if (!user && accessToken) {
		try {
			const me = await apiClient.get('/identity/api/v1/auth/me', {
				// @generated-api-exempt
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			user = parseUserFromToken(undefined, me.data);
		} catch {
			// /auth/me may fail; loginWithTokens will still succeed with partial user
		}
	}
	if (!user && accessToken) {
		// 最后兜底：/auth/me 也失败时用 access_token JWT 解析 user
		// (identity 签发，payload 实测含 sub/tenant_id/custom.*，可能无 email/username)
		user = parseUserFromToken(accessToken);
	}
	if (!user) {
		user = { id: '', username: '', email: '' } as User;
	}

	// OIDC userinfo（oauth 服务经 BFF：/bff/oauth/api/v1/oauth/userinfo）补充展示身份：
	// id_token 与 /auth/me 都不含展示名（name/nickname/picture）。同样须显式带 access_token
	// （loginWithTokens 尚未执行，拦截器无 token 可用）。失败静默降级——缺 displayName 时
	// 消费方按 displayName → username → email 链回落，不影响登录。
	if (accessToken) {
		try {
			const res = await apiClient.get('/oauth/api/v1/oauth/userinfo', {
				// @generated-api-exempt
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			const info = res.data as { nickname?: string; name?: string; picture?: string };
			const displayName = (info?.nickname || '').trim() || (info?.name || '').trim();
			if (displayName) user.displayName = displayName;
			if (info?.picture) user.avatarUrl = info.picture;
		} catch {
			// userinfo 失败不阻断登录（同上，按缺省链回落）
		}
	}

	// 兑换成功后落持久层（同 TASK-09 / D8；兑换前的持久值可能来自旧租户）
	persistOAuthClientId(cid);

	// Persist to Zustand store (in-memory).
	// Zustand persist subscriber will automatically write to localStorage
	// via partialize — no manual localStorage.setItem needed.
	loginWithTokens(accessToken, refreshToken, user);

	// OAuth access_token 由身份服务签发，payload 含 tenant_id claim。
	// 登录成功后初始化 currentTenantId，供 useTenantId()/useTenantIdOr() 等
	// 页面使用真实租户（否则 fallback 'default-tenant' 导致 data-classification 等 404）。
	const parsedToken = accessToken ? decodeJwtPayload(accessToken) : null;
	const tokenTenantId = parsedToken?.tenant_id || (parsedToken as any)?.tenantId;
	if (tokenTenantId) {
		AuthService.updateCurrentTenant(tokenTenantId as string);
	}

	// Compute navigation target
	let target: string;
	if (oauthRedirectTarget) {
		target = oauthRedirectTarget;
	} else {
		// Fallback to BASE_PATH from app config or root
		const fallbackBase = (window as any).__APP_CONFIG__?.BASE_PATH || '/';
		target = fallbackBase === '/' ? '/' : `${window.location.origin}${fallbackBase}/`;
	}

	// Full page navigation to the target (auth gateway will route to dashboard)
	// funnel：登录成功回跳（预期行为，静默直跳，assign 保持原语义）；仅记 trace。
	traceRedirect(target, { reason: 'oauth-callback', assign: true });
}
