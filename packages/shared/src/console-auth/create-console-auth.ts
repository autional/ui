/**
 * 控制台认证引擎（唯一实现）。
 *
 * 背景：配置中心与密钥中心原本各写一份 ~450/540 行的 OIDC PKCE 流程，逐段相同。
 * 差异只有一处是**策略**（令牌存 sessionStorage 还是 localStorage），其余差异都是
 * 事故修复，不该做成开关：
 *   1. 5xx / 网络故障 → 会话延长 30s 再试（否则网关抖一下就把人踢下线）；
 *   2. 登出时吊销 refresh + access（否则登出后 refresh_token 还能换新票）；
 *   3. 兜底有效期 30 分钟（`exp` 与 `expires_in` 都缺时才用）；
 *   4. identity 补全过的展示名不被令牌里的 sub 尾段覆盖（否则每 5 分钟顶栏闪一次）；
 *   5. 令牌里没有 tenant/app 声明时保留上一轮已知值（否则 X-Tenant-ID 丢 → 403）。
 *
 * 设计约束：
 *   - **不改安全姿态**：`storage` 是唯一参数，由各站自己决定；
 *   - 纯副作用集中在此（storage / fetch / location），便于用假 window 测试；
 *   - 对外 API 与原两站的 `lib/auth.ts` 一一对应，站点侧只做薄绑定。
 */
import { decodeJwtPayload } from '../auth/jwt-payload';
import { generatePKCE } from '../auth/pkce';
import {
	expiresAtFromToken,
	mergeTokenClaims,
	pickClaimString,
	sessionExpiryAt,
	userFromClaims,
	type ConsoleSessionUser,
} from './claims';

export interface ConsoleSession {
	mode: 'mock' | 'oidc';
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	/** epoch ms；0 = 不过期（mock） */
	expiresAt: number;
	user: ConsoleSessionUser;
}

export interface ConsoleAuthOptions {
	authMode: 'mock' | 'oidc';
	/** **唯一策略参数**：令牌放 localStorage（跨标签页/刷新保持）还是 sessionStorage（关标签页失效）。 */
	storage: 'local' | 'session';
	keys: {
		/** 会话落盘 key */
		session: string;
		/** PKCE 上下文 key（state/nonce/verifier） */
		pkce: string;
		/** mock 模式下点过「退出」的标记 key */
		mockSignedOut: string;
	};
	oidc: {
		authorizeUrl: string;
		tokenUrl: string;
		clientId: string;
		scope: string;
		redirectUri: string;
	};
	/** 演示会话工厂（`authMode === 'mock'` 时使用） */
	mockSession: () => ConsoleSession;
	/** 旧会话迁移：仅当新 key 为空时，把旧 storage 里的值搬过来（只做一次）。 */
	legacy?: { key: string; from: 'local' | 'session' };
	/** `exp` 与 `expires_in` 都缺时的兜底有效期，默认 30 分钟。 */
	expiryFallbackMs?: number;
	/** 瞬时故障（5xx / 网络）时把会话延长多久，默认 30s。 */
	transientGraceMs?: number;
	/** 登出时是否调服务端 revoke，默认 true。 */
	revokeOnSignOut?: boolean;
	/** 跳转实现（默认 `window.location.assign`），测试可注入。 */
	assign?: (url: string) => void;
}

export interface ConsoleAuth {
	sessionKey: string;
	mockSession: () => ConsoleSession;
	currentSession: () => ConsoleSession | null;
	restoreSession: () => Promise<ConsoleSession | null>;
	startLogin: () => Promise<ConsoleSession | null>;
	completeLogin: (search?: string) => Promise<ConsoleSession>;
	refreshSession: (stored?: ConsoleSession | null) => Promise<ConsoleSession | null>;
	/** 剩余有效期 < 阈值时主动续期（App 定时器 / 页面重新可见时调用）。 */
	ensureFreshSession: (thresholdMs?: number) => Promise<ConsoleSession | null>;
	signOut: (options?: { revoke?: boolean }) => Promise<void>;
	renewAfterUnauthorized: () => Promise<ConsoleSession | null>;
	patchUser: (patch: Partial<ConsoleSessionUser>) => ConsoleSession | null;
}

/** 提前 60s 视为过期，避免请求途中失效。 */
const EXPIRY_SKEW_MS = 60_000;

type PkceState = {
	verifier: string;
	state: string;
	nonce: string;
	redirectUri: string;
	at: number;
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
	error?: string;
	error_description?: string;
};

/** 令牌端点错误：区分「瞬时（网络/5xx）」与「确定失败（4xx invalid_grant 等）」。 */
class TokenError extends Error {
	constructor(
		message: string,
		readonly transient: boolean,
	) {
		super(message);
		this.name = 'TokenError';
	}
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
	try {
		const win = (globalThis as unknown as { window?: Window & typeof globalThis }).window;
		return (win?.[kind === 'local' ? 'localStorage' : 'sessionStorage'] ?? null) as Storage | null;
	} catch {
		// 隐私模式/被禁用：降级为「无存储」，绝不抛到 UI
		return null;
	}
}

export function createConsoleAuth(options: ConsoleAuthOptions): ConsoleAuth {
	const {
		authMode,
		storage: storageKind,
		keys,
		oidc,
		mockSession,
		legacy,
		expiryFallbackMs = 30 * 60_000,
		transientGraceMs = 30_000,
		revokeOnSignOut = true,
		assign = (url: string) => window.location.assign(url),
	} = options;

	const store = () => safeStorage(storageKind);

	function read(key: string): string | null {
		try {
			return store()?.getItem(key) ?? null;
		} catch {
			return null;
		}
	}

	function write(key: string, value: string): void {
		try {
			store()?.setItem(key, value);
		} catch {
			/* 忽略：无存储时退化为「每次刷新都要重新登录」 */
		}
	}

	function remove(key: string): void {
		try {
			store()?.removeItem(key);
		} catch {
			/* 忽略 */
		}
	}

	/** 旧 key 迁移（只做一次，避免升级后强制重登）。 */
	function migrateLegacy(): void {
		if (!legacy) return;
		try {
			const current = store();
			if (!current || current.getItem(keys.session)) return;
			const old = safeStorage(legacy.from);
			const value = old?.getItem(legacy.key);
			if (!value) return;
			current.setItem(keys.session, value);
			old?.removeItem(legacy.key);
		} catch {
			/* 忽略 */
		}
	}

	function saveSession(session: ConsoleSession): void {
		write(keys.session, JSON.stringify(session));
	}

	function clearSession(): void {
		remove(keys.session);
	}

	function readStored(): ConsoleSession | null {
		const raw = read(keys.session);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as ConsoleSession;
			return parsed?.accessToken !== undefined ? parsed : null;
		} catch {
			clearSession();
			return null;
		}
	}

	function isFresh(session: ConsoleSession): boolean {
		const expiry = sessionExpiryAt(session.accessToken, session.expiresAt);
		return expiry === 0 || Date.now() <= expiry - EXPIRY_SKEW_MS;
	}

	function readPkce(): PkceState | null {
		const raw = read(keys.pkce);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as PkceState;
			return parsed?.verifier && parsed?.state ? parsed : null;
		} catch {
			return null;
		}
	}

	async function postToken(body: URLSearchParams): Promise<TokenResponse> {
		let res: Response;
		try {
			res = await fetch(oidc.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: body.toString(),
			});
		} catch (cause) {
			throw new TokenError(`无法连接令牌端点（${oidc.tokenUrl}）：${(cause as Error).message}`, true);
		}
		const data = (await res.json().catch(() => null)) as TokenResponse | null;
		if (!res.ok || !data?.access_token) {
			const reason = data?.error_description || data?.error || `HTTP ${res.status}`;
			// 5xx / 0 = 瞬时；4xx（invalid_grant 等）= 确定失败
			throw new TokenError(`换取令牌失败：${reason}`, res.status >= 500 || res.status === 0);
		}
		return data;
	}

	function toSession(
		data: TokenResponse,
		base?: ConsoleSession | null,
	): ConsoleSession {
		const claims = mergeTokenClaims(data.access_token, data.id_token);
		const session: ConsoleSession = {
			mode: 'oidc',
			accessToken: data.access_token as string,
			refreshToken: data.refresh_token ?? base?.refreshToken,
			idToken: data.id_token ?? base?.idToken,
			expiresAt: expiresAtFromToken(data.access_token as string, data.expires_in, expiryFallbackMs),
			user: userFromClaims(claims, base?.user?.name || '已登录用户'),
		};
		if (base) {
			// identity 补全过的展示名（如 platform_admin）不要被令牌里的 sub 尾段覆盖，
			// 否则每 5 分钟续期一次，顶栏就闪回「…XXXXXX」并重复查一次资料。
			if (session.user.name.startsWith('…') && base.user?.name && !base.user.name.startsWith('…')) {
				session.user = { ...session.user, name: base.user.name, email: session.user.email || base.user.email };
			}
			// 令牌内没有租户/应用声明时，保留上一轮已知值，避免 X-Tenant-ID 丢失。
			if (!session.user.tenantId) session.user.tenantId = base.user?.tenantId ?? '';
			if (!session.user.appId) session.user.appId = base.user?.appId ?? '';
		}
		return session;
	}

	// ── 对外 API ────────────────────────────────────────────────────────────

	function currentSession(): ConsoleSession | null {
		if (authMode === 'mock') {
			migrateLegacy();
			return read(keys.mockSignedOut) === '1' ? null : mockSession();
		}
		migrateLegacy();
		const session = readStored();
		if (!session?.accessToken) return null;
		return isFresh(session) ? session : null;
	}

	async function restoreSession(): Promise<ConsoleSession | null> {
		if (authMode === 'mock') return currentSession();
		migrateLegacy();
		const stored = readStored();
		if (!stored) return null;
		if (stored.accessToken && isFresh(stored)) return stored;
		return refreshSession(stored);
	}

	async function startLogin(): Promise<ConsoleSession | null> {
		if (authMode === 'mock') {
			remove(keys.mockSignedOut);
			const session = mockSession();
			saveSession(session);
			return session;
		}
		if (!oidc.clientId) {
			throw new Error('缺少 VITE_OIDC_CLIENT_ID：请先在 OAuth 客户端登记回调地址并配置客户端 ID');
		}

		// PKCE（RFC 7636）：verifier 43–128 字符，challenge = base64url(sha256(verifier))
		const { verifier, challenge } = await generatePKCE();
		const state = randomToken(16);
		const nonce = randomToken(16);

		write(
			keys.pkce,
			JSON.stringify({ verifier, state, nonce, redirectUri: oidc.redirectUri, at: Date.now() } satisfies PkceState),
		);

		const url = new URL(oidc.authorizeUrl);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', oidc.clientId);
		url.searchParams.set('redirect_uri', oidc.redirectUri);
		url.searchParams.set('scope', oidc.scope);
		url.searchParams.set('state', state);
		url.searchParams.set('nonce', nonce);
		url.searchParams.set('code_challenge', challenge);
		url.searchParams.set('code_challenge_method', 'S256');

		assign(url.toString());
		return null;
	}

	async function completeLogin(search: string = window.location.search): Promise<ConsoleSession> {
		const query = new URLSearchParams(search);
		const error = query.get('error');
		if (error) {
			const desc = query.get('error_description');
			throw new Error(`授权被拒绝：${error}${desc ? ` · ${desc}` : ''}`);
		}
		const code = query.get('code');
		const state = query.get('state');
		if (!code) throw new Error('回调缺少 code 参数');

		const pkce = readPkce();
		if (!pkce) throw new Error('登录会话已失效（缺少 PKCE 上下文），请重新登录');
		if (!state || state !== pkce.state) throw new Error('state 校验失败（可能的 CSRF），请重新登录');
		if (Date.now() - pkce.at > 10 * 60_000) {
			remove(keys.pkce);
			throw new Error('登录超时，请重新登录');
		}
		if (!oidc.clientId) throw new Error('缺少 VITE_OIDC_CLIENT_ID');

		const data = await postToken(
			new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: pkce.redirectUri,
				client_id: oidc.clientId,
				code_verifier: pkce.verifier,
			}),
		);

		const nonceClaim = pickClaimString(mergeTokenClaims(data.access_token, data.id_token), 'nonce');
		if (nonceClaim && nonceClaim !== pkce.nonce) {
			remove(keys.pkce);
			throw new Error('nonce 校验失败（令牌可能被重放），请重新登录');
		}

		remove(keys.pkce);

		const session = toSession(data);
		saveSession(session);
		return session;
	}

	let refreshInFlight: Promise<ConsoleSession | null> | null = null;

	function refreshSession(stored?: ConsoleSession | null): Promise<ConsoleSession | null> {
		if (authMode === 'mock') return Promise.resolve(currentSession());
		if (refreshInFlight) return refreshInFlight;
		refreshInFlight = doRefresh(stored).finally(() => {
			refreshInFlight = null;
		});
		return refreshInFlight;
	}

	async function doRefresh(stored?: ConsoleSession | null): Promise<ConsoleSession | null> {
		const base = stored ?? readStored();
		if (!base) return null;
		if (!base.refreshToken || !oidc.clientId) {
			clearSession();
			return null;
		}
		try {
			const data = await postToken(
				new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: base.refreshToken,
					client_id: oidc.clientId,
				}),
			);
			const session = toSession(data, base);
			saveSession(session);
			return session;
		} catch (err) {
			if (err instanceof TokenError && err.transient) {
				// 网络/网关瞬时故障：不清会话，延长一小段让 UI 不立刻掉登录，下次再续。
				if (transientGraceMs > 0) {
					const keep: ConsoleSession = {
						...base,
						expiresAt: Math.max(base.expiresAt, Date.now() + transientGraceMs),
					};
					saveSession(keep);
					return keep;
				}
				return currentSession();
			}
			clearSession();
			return null;
		}
	}

	async function ensureFreshSession(thresholdMs: number = 5 * 60_000): Promise<ConsoleSession | null> {
		if (authMode === 'mock') return currentSession();
		migrateLegacy();
		const stored = readStored();
		if (!stored?.accessToken) return null;
		const expiry = sessionExpiryAt(stored.accessToken, stored.expiresAt);
		if (expiry === 0 || expiry - Date.now() > thresholdMs) return stored;
		return refreshSession(stored);
	}

	function revokeUrl(): string {
		// 与 token 同源：把 `/token` 换成 `/revoke`
		return oidc.tokenUrl.replace(/\/token(\?.*)?$/, '/revoke');
	}

	async function revokeToken(token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
		if (!oidc.clientId) return;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			await fetch(revokeUrl(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({ token, token_type_hint: hint, client_id: oidc.clientId }).toString(),
				signal: controller.signal,
				credentials: 'omit',
				keepalive: true,
			});
		} catch {
			/* 网络/超时忽略：本地会话仍会清除 */
		} finally {
			clearTimeout(timer);
		}
	}

	async function signOut(signOutOptions: { revoke?: boolean } = {}): Promise<void> {
		const shouldRevoke = revokeOnSignOut && authMode === 'oidc' && signOutOptions.revoke !== false;
		if (shouldRevoke) {
			const stored = readStored();
			if (stored) {
				const tasks: Promise<void>[] = [];
				if (stored.refreshToken) tasks.push(revokeToken(stored.refreshToken, 'refresh_token'));
				if (stored.accessToken) tasks.push(revokeToken(stored.accessToken, 'access_token'));
				if (tasks.length) await Promise.allSettled(tasks);
			}
		}
		clearSession();
		remove(keys.pkce);
		if (authMode === 'mock') write(keys.mockSignedOut, '1');
	}

	function patchUser(patch: Partial<ConsoleSessionUser>): ConsoleSession | null {
		const current = currentSession();
		if (!current) return null;
		const next: ConsoleSession = { ...current, user: { ...current.user, ...patch } };
		saveSession(next);
		return next;
	}

	return {
		sessionKey: keys.session,
		mockSession,
		currentSession,
		restoreSession,
		startLogin,
		completeLogin,
		refreshSession,
		ensureFreshSession,
		signOut,
		renewAfterUnauthorized: () => refreshSession(),
		patchUser,
	};
}

function b64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength = 32): string {
	const buf = new Uint8Array(byteLength);
	crypto.getRandomValues(buf);
	return b64url(buf);
}

/** 供站点复用的 JWT 解码（不验签：签名在后端，前端只取展示用声明）。 */
export { decodeJwtPayload };
