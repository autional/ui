import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleAuthOptions, ConsoleSession } from '@autional/shared/console-auth';
import { createConsoleAuth } from '@autional/shared/console-auth';

/**
 * 引擎测试：两站流程合并成一份后，这里的行为就是**两站的行为**。
 * 用假 window（storage / location）+ 假 fetch，覆盖：
 * mock 演示会话、PKCE 跳转、state/nonce 校验、续期单飞、4xx 清会话 / 5xx 保活、
 * 过期判定、storage 策略参数、旧 key 迁移、登出吊销。
 */

type MemStorage = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
};

function memoryStorage(): MemStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, String(value)),
		removeItem: (key: string) => void map.delete(key),
	};
}

/** 造一个 payload 可解的最小 JWT。 */
function jwt(payload: Record<string, unknown>): string {
	const b64 = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const KEYS = { session: 'test:auth', pkce: 'test:pkce', mockSignedOut: 'test:signed-out' };

let local: MemStorage;
let session: MemStorage;
let assigned: string[];

function installWindow() {
	local = memoryStorage();
	session = memoryStorage();
	assigned = [];
	vi.stubGlobal('window', {
		localStorage: local,
		sessionStorage: session,
		location: { origin: 'https://test.local', search: '', assign: (url: string) => assigned.push(url) },
	});
}

function options(overrides: Partial<ConsoleAuthOptions> = {}): ConsoleAuthOptions {
	return {
		authMode: 'oidc',
		storage: 'local',
		keys: KEYS,
		oidc: {
			authorizeUrl: 'https://idp.test/authorize',
			tokenUrl: 'https://idp.test/token',
			clientId: 'client-1',
			scope: 'openid profile',
			redirectUri: 'https://test.local/oauth/callback',
		},
		mockSession: () => ({
			mode: 'mock',
			accessToken: '',
			expiresAt: 0,
			user: { sub: 'demo', name: '演示', email: '', tenantId: 't-demo', appId: '', roles: ['super_admin'] },
		}),
		assign: (url: string) => assigned.push(url),
		...overrides,
	};
}

function tokenResponse(extra: Record<string, unknown> = {}) {
	return new Response(
		JSON.stringify({
			access_token: jwt({ sub: 'u1', exp: 1_900_000_000, tenant_id: 't-1', roles: ['admin'] }),
			refresh_token: 'r-2',
			id_token: jwt({ sub: 'u1', name: '张三', nonce: 'n-1', exp: 1_900_000_000 }),
			expires_in: 3600,
			...extra,
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
}

function seedSession(overrides: Record<string, unknown> = {}) {
	const target = local;
	target.setItem(
		KEYS.session,
		JSON.stringify({
			mode: 'oidc',
			accessToken: 'access-token',
			refreshToken: 'r-1',
			expiresAt: Date.now() + 3_600_000,
			user: { sub: 'u1', name: 'QA', email: 'q@e.test', tenantId: 't-1', appId: 'a-1', roles: ['admin'] },
			...overrides,
		}),
	);
}

beforeEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	installWindow();
});

describe('mock 模式', () => {
	it('未退出 → 演示会话；退出后 → null（不自动回填）', async () => {
		const auth = createConsoleAuth(options({ authMode: 'mock' }));
		expect(auth.currentSession()?.mode).toBe('mock');
		await auth.signOut();
		expect(auth.currentSession()).toBeNull();
	});

	it('signOut 不发网络请求（mock 没有可吊销的令牌）', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const auth = createConsoleAuth(options({ authMode: 'mock' }));
		await auth.signOut();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('startLogin（授权跳转）', () => {
	it('生成 PKCE 并跳转，参数齐全', async () => {
		const auth = createConsoleAuth(options());
		expect(await auth.startLogin()).toBeNull();

		expect(assigned).toHaveLength(1);
		const url = new URL(assigned[0]);
		expect(url.origin + url.pathname).toBe('https://idp.test/authorize');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('client_id')).toBe('client-1');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(url.searchParams.get('state')).toBeTruthy();
		expect(url.searchParams.get('nonce')).toBeTruthy();
		expect(url.searchParams.get('redirect_uri')).toBe('https://test.local/oauth/callback');

		// PKCE 上下文落盘（含 verifier，供回调时换取令牌）
		const pkce = JSON.parse(local.getItem(KEYS.pkce) as string);
		expect(pkce.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
		expect(pkce.redirectUri).toBe('https://test.local/oauth/callback');
	});

	it('缺 clientId → 抛错且不跳转', async () => {
		const auth = createConsoleAuth(options({ oidc: { ...options().oidc, clientId: '' } }));
		await expect(auth.startLogin()).rejects.toThrow(/VITE_OIDC_CLIENT_ID/);
		expect(assigned).toEqual([]);
	});
});

describe('completeLogin（回调换票）', () => {
	function seedPkce(state = 's-1', nonce = 'n-1') {
		local.setItem(KEYS.pkce, JSON.stringify({ verifier: 'v', state, nonce, redirectUri: 'https://test.local/cb', at: Date.now() }));
	}

	it('正常换票 → 会话落盘；tenant_id 来自 access_token（声明合并）', async () => {
		seedPkce();
		vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
		const auth = createConsoleAuth(options());

		const session = await auth.completeLogin('?code=c&state=s-1');
		expect(session.mode).toBe('oidc');
		expect(session.user.name).toBe('张三'); // 来自 id_token
		expect(session.user.tenantId).toBe('t-1'); // 只在 access_token 里，靠合并拿到
		expect(session.user.roles).toEqual(['admin']);
		expect(session.expiresAt).toBe(1_900_000_000 * 1000);
		expect(local.getItem(KEYS.session)).not.toBeNull();
		expect(local.getItem(KEYS.pkce)).toBeNull();
	});

	it('state 不匹配 → 抛错且不落会话', async () => {
		seedPkce('expected');
		vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
		const auth = createConsoleAuth(options());
		await expect(auth.completeLogin('?code=c&state=other')).rejects.toThrow(/state/);
		expect(local.getItem(KEYS.session)).toBeNull();
	});

	it('nonce 不匹配 → 抛错且清 PKCE（防重放）', async () => {
		seedPkce('s-1', 'expected-nonce');
		vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
		const auth = createConsoleAuth(options());
		await expect(auth.completeLogin('?code=c&state=s-1')).rejects.toThrow(/nonce/);
		expect(local.getItem(KEYS.pkce)).toBeNull();
	});

	it('授权端点回 error → 抛错带错误码', async () => {
		const auth = createConsoleAuth(options());
		await expect(auth.completeLogin('?error=access_denied')).rejects.toThrow(/access_denied/);
	});

	it('缺 code → 抛错', async () => {
		const auth = createConsoleAuth(options());
		await expect(auth.completeLogin('?state=s')).rejects.toThrow(/code/);
	});

	it('缺 PKCE 上下文 → 抛错', async () => {
		const auth = createConsoleAuth(options());
		await expect(auth.completeLogin('?code=c&state=s')).rejects.toThrow(/PKCE/);
	});
});

describe('refreshSession（续期）', () => {
	it('并发只发一次令牌请求（单飞）', async () => {
		seedSession();
		const fetchMock = vi.fn(async () => tokenResponse());
		vi.stubGlobal('fetch', fetchMock);
		const auth = createConsoleAuth(options());

		const [a, b] = await Promise.all([auth.refreshSession(), auth.refreshSession()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a?.refreshToken).toBe('r-2');
		expect(b?.refreshToken).toBe('r-2');
	});

	it('4xx（invalid_grant）→ 返回 null 并清会话', async () => {
		seedSession();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
		const auth = createConsoleAuth(options());
		await expect(auth.refreshSession()).resolves.toBeNull();
		expect(local.getItem(KEYS.session)).toBeNull();
	});

	it('5xx → 不清会话，并把有效期延长约 transientGraceMs', async () => {
		seedSession();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
		const auth = createConsoleAuth(options({ transientGraceMs: 30_000 }));

		const before = Date.now();
		const kept = await auth.refreshSession();
		expect(kept).not.toBeNull();
		expect(local.getItem(KEYS.session)).not.toBeNull();
		expect(kept?.expiresAt).toBeGreaterThanOrEqual(before + 29_000);
	});

	it('网络异常 → 同样不清会话（瞬时）', async () => {
		seedSession();
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))));
		const auth = createConsoleAuth(options());
		await expect(auth.refreshSession()).resolves.not.toBeNull();
		expect(local.getItem(KEYS.session)).not.toBeNull();
	});

	it('没有 refresh_token → null 并清会话', async () => {
		seedSession({ refreshToken: undefined });
		vi.stubGlobal('fetch', vi.fn());
		const auth = createConsoleAuth(options());
		await expect(auth.refreshSession()).resolves.toBeNull();
		expect(local.getItem(KEYS.session)).toBeNull();
	});

	it('续期保留上一轮的租户/应用与补全过的展示名', async () => {
		seedSession({
			user: { sub: 'u1', name: '平台管理员', email: 'p@e.test', tenantId: 't-keep', appId: 'a-keep', roles: ['admin'] },
		});
		// 令牌里既没有 tenant/app，也没有 name → 展示名会落到「…<sub 尾段>」
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: jwt({ sub: 'u1', exp: 1_900_000_000 }),
							id_token: jwt({ sub: 'u1', exp: 1_900_000_000 }),
							expires_in: 3600,
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					),
			),
		);
		const auth = createConsoleAuth(options());
		const next = await auth.refreshSession();
		expect(next?.user.name).toBe('平台管理员');
		expect(next?.user.tenantId).toBe('t-keep');
		expect(next?.user.appId).toBe('a-keep');
	});
});

describe('currentSession（过期判定）', () => {
	it('无会话 → null', () => {
		expect(createConsoleAuth(options()).currentSession()).toBeNull();
	});

	it('以 JWT exp 为准：exp 已过（即使记录值未过）→ null', () => {
		seedSession({ accessToken: jwt({ sub: 'u1', exp: Math.floor((Date.now() + 30_000) / 1000) }) });
		expect(createConsoleAuth(options()).currentSession()).toBeNull();
	});

	it('未过期 → 返回会话', () => {
		seedSession();
		expect(createConsoleAuth(options()).currentSession()?.refreshToken).toBe('r-1');
	});

	it('存储内容损坏 → 清掉并返回 null', () => {
		local.setItem(KEYS.session, '{not json');
		const auth = createConsoleAuth(options());
		expect(auth.currentSession()).toBeNull();
	});
});

describe('storage 策略参数（唯一参数）', () => {
	it("storage='session' → 只写 sessionStorage，localStorage 干净", async () => {
		session.setItem(KEYS.pkce, JSON.stringify({ verifier: 'v', state: 's', nonce: 'n-1', redirectUri: 'u', at: Date.now() }));
		vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
		const auth = createConsoleAuth(options({ storage: 'session' }));
		await auth.completeLogin('?code=c&state=s');

		expect(session.getItem(KEYS.session)).not.toBeNull();
		expect(local.getItem(KEYS.session)).toBeNull();
	});

	it("storage='local' → 写 localStorage", async () => {
		local.setItem(KEYS.pkce, JSON.stringify({ verifier: 'v', state: 's', nonce: 'n-1', redirectUri: 'u', at: Date.now() }));
		vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));
		const auth = createConsoleAuth(options({ storage: 'local' }));
		await auth.completeLogin('?code=c&state=s');

		expect(local.getItem(KEYS.session)).not.toBeNull();
		expect(session.getItem(KEYS.session)).toBeNull();
	});
});

describe('旧 key 迁移', () => {
	it('新 key 为空时把旧值搬过来，并删掉旧 key', () => {
		session.setItem('old:auth', JSON.stringify({ mode: 'oidc', accessToken: 'x', expiresAt: Date.now() + 600_000, user: { sub: 'u' } }));
		const auth = createConsoleAuth(options({ legacy: { key: 'old:auth', from: 'session' } }));
		expect(auth.currentSession()).not.toBeNull();
		expect(local.getItem(KEYS.session)).not.toBeNull();
		expect(session.getItem('old:auth')).toBeNull();
	});

	it('新 key 已有值时不覆盖', () => {
		seedSession({ accessToken: 'current' });
		session.setItem('old:auth', JSON.stringify({ mode: 'oidc', accessToken: 'legacy', expiresAt: 0, user: { sub: 'u' } }));
		const auth = createConsoleAuth(options({ legacy: { key: 'old:auth', from: 'session' } }));
		expect(auth.currentSession()?.accessToken).toBe('current');
		expect(JSON.parse(local.getItem(KEYS.session) as string).accessToken).toBe('current');
	});
});

describe('signOut（登出）', () => {
	it('默认吊销 refresh + access，并清本地会话', async () => {
		seedSession();
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const auth = createConsoleAuth(options());

		await auth.signOut();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls.every((u) => u.endsWith('/revoke'))).toBe(true);
		expect(local.getItem(KEYS.session)).toBeNull();
	});

	it('revoke:false（401 强制登出）→ 不发请求', async () => {
		seedSession();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const auth = createConsoleAuth(options());
		await auth.signOut({ revoke: false });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(local.getItem(KEYS.session)).toBeNull();
	});

	it('revoke 网络失败不阻塞本地登出', async () => {
		seedSession();
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
		const auth = createConsoleAuth(options());
		await expect(auth.signOut()).resolves.toBeUndefined();
		expect(local.getItem(KEYS.session)).toBeNull();
	});
});

describe('ensureFreshSession（主动续期）', () => {
	it('剩余 > 阈值 → 不请求', async () => {
		seedSession({ accessToken: jwt({ sub: 'u1', exp: Math.floor((Date.now() + 3_600_000) / 1000) }) });
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const auth = createConsoleAuth(options());
		expect(await auth.ensureFreshSession()).not.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('剩余 < 阈值 → 续期', async () => {
		seedSession({ accessToken: jwt({ sub: 'u1', exp: Math.floor((Date.now() + 120_000) / 1000) }) });
		const fetchMock = vi.fn(async () => tokenResponse());
		vi.stubGlobal('fetch', fetchMock);
		const auth = createConsoleAuth(options());
		const next = (await auth.ensureFreshSession()) as ConsoleSession;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(next.refreshToken).toBe('r-2');
	});
});
