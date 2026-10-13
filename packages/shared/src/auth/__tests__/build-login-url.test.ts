import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildLoginUrl, buildLogoutUrl, isAuthLoginSurface } from '../roles';

const MOCK_CONFIG = {
	VITE_PORTAL_CONFIG: {
		auth: { host: 'auth', base: '' },
	},
};

function mockWindow(
	hostname: string,
	protocol: string,
	origin: string,
	config: any = MOCK_CONFIG,
): void {
	vi.stubGlobal('window', {
		location: { hostname, protocol, origin },
		__APP_CONFIG__: config,
	});
}

describe('buildLoginUrl', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('basic URL construction', () => {
		it('builds base login URL pointing to auth domain', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl();
			expect(url).toBe('https://auth.iam.tianv.local');
		});

		it('includes redirect param when returnUrl provided', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl('https://app.iam.tianv.com/admin');
			expect(url).toContain('redirect=');
			expect(url).toContain(encodeURIComponent('https://app.iam.tianv.com/admin'));
		});
	});

	describe('fromRequireAuth parameter', () => {
		it('appends from_requireauth=1 when fromRequireAuth is true', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl(undefined, true);
			expect(url).toContain('from_requireauth=1');
		});

		it('appends from_requireauth=1 with redirect param', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl('https://app.iam.tianv.com/admin', true);
			expect(url).toContain('redirect=');
			expect(url).toContain('from_requireauth=1');
			expect(url).toContain('&from_requireauth=1');
		});

		it('does not include from_requireauth when fromRequireAuth is false', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl('https://app.iam.tianv.com/admin', false);
			expect(url).not.toContain('from_requireauth');
		});

		it('does not include from_requireauth when fromRequireAuth is undefined', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl('https://app.iam.tianv.com/admin');
			expect(url).not.toContain('from_requireauth');
		});

		it('returns only from_requireauth=1 when no returnUrl but fromRequireAuth is true', () => {
			mockWindow('app.iam.tianv.local', 'https:', 'https://app.iam.tianv.local');
			const url = buildLoginUrl(undefined, true);
			expect(url).toContain('?from_requireauth=1');
			expect(url).not.toContain('redirect=');
		});
	});

	describe('domain-agnostic', () => {
		it('works with .com domain', () => {
			mockWindow('app.iam.tianv.com', 'https:', 'https://app.iam.tianv.com');
			const url = buildLoginUrl();
			expect(url).toBe('https://auth.iam.tianv.com');
		});

		it('works with autional.com domain', () => {
			mockWindow('app.autional.com', 'https:', 'https://app.autional.com');
			const url = buildLoginUrl();
			expect(url).toBe('https://auth.autional.com');
		});
	});

	describe('tenant-slug preservation', () => {
		const AUTH_CONFIG = {
			VITE_PORTAL_CONFIG: {
				auth: { host: 'auth', base: '' },
			},
		};

		it('redirects to {slug}/login when returnUrl is tenant-scoped on auth domain', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://auth.autional.local/acme-corp/dashboard');
			expect(url).toBe(
				'https://auth.autional.local/acme-corp/login?redirect=' +
					encodeURIComponent('https://auth.autional.local/acme-corp/dashboard'),
			);
		});

		it('keeps from_requireauth on tenant-scoped login url', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://auth.autional.local/acme-corp/dashboard', true);
			expect(url).toBe(
				'https://auth.autional.local/acme-corp/login?redirect=' +
					encodeURIComponent('https://auth.autional.local/acme-corp/dashboard') +
					'&from_requireauth=1',
			);
		});

		it('does not treat reserved auth routes as tenant slug', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://auth.autional.local/reset-password');
			expect(url).toBe(
				'https://auth.autional.local?redirect=' +
					encodeURIComponent('https://auth.autional.local/reset-password'),
			);
		});

		it('preserves cross-domain returnUrl behavior (app domain)', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://app.autional.com/admin');
			expect(url).toBe(
				'https://auth.autional.local?redirect=' +
					encodeURIComponent('https://app.autional.com/admin'),
			);
		});

		it('does not truncate cross-domain returnUrl containing /login substring (regression P1-2)', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://app.autional.com/admin/login');
			expect(url).toBe(
				'https://auth.autional.local?redirect=' +
					encodeURIComponent('https://app.autional.com/admin/login'),
			);
		});

		it('truncates auth-domain login page itself (no nested redirect)', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://auth.autional.local/acme-corp/login');
			expect(url).toBe('https://auth.autional.local/acme-corp/login');
		});
	});

	describe('useLogout unification (logout → login redirect)', () => {
		const AUTH_CONFIG = {
			VITE_PORTAL_CONFIG: {
				auth: { host: 'auth', base: '' },
			},
		};

		it('logout from auth-domain tenant page keeps tenant slug (bug scenario)', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://auth.autional.local/acme-corp/dashboard');
			expect(url).toBe(
				'https://auth.autional.local/acme-corp/login?redirect=' +
					encodeURIComponent('https://auth.autional.local/acme-corp/dashboard'),
			);
		});

		it('logout from auth root (tenant select page) does not add redirect', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
			const url = buildLoginUrl('https://auth.autional.local/');
			expect(url).toBe('https://auth.autional.local');
		});

		it('logout from portal domain falls back to generic auth login (no slug misjudge)', () => {
			// useLogout 在 portal app 中跨域调用：returnUrl origin ≠ auth origin，
			// 首段 /admin 不会被误判为租户 slug，跳转 {base}?redirect=<portal-url>
			mockWindow('app.autional.com', 'https:', 'https://app.autional.com', AUTH_CONFIG);
			const url = buildLoginUrl('https://app.autional.com/admin');
			expect(url).toBe(
				'https://auth.autional.com?redirect=' +
					encodeURIComponent('https://app.autional.com/admin'),
			);
		});
	});

	describe('buildLogoutUrl（TASK-LS-08 同源标准端点 + legacy 兜底）', () => {
		const AUTH_CONFIG = {
			VITE_PORTAL_CONFIG: {
				auth: { host: 'auth', base: '' },
			},
		};
		/** env 级 client_id（三级来源之二） */
		const CID_CONFIG = {
			...AUTH_CONFIG,
			VITE_OAUTH_CLIENT_ID: 'cid-env',
		};

		beforeEach(() => {
			// localStorage 桩按需设置；测试间清掉全局桩防跨用例泄漏（node 环境无真 localStorage）
			vi.unstubAllGlobals();
		});

		it('门户域登出：同源标准端点 + client_id + post_logout_redirect_uri=<origin>/ + state=returnUrl', () => {
			mockWindow('app.autional.com', 'https:', 'https://app.autional.com', CID_CONFIG);
			const url = buildLogoutUrl('https://app.autional.com/demo/');
			expect(url).toBe(
				'https://app.autional.com/oauth/api/v1/oauth/logout?client_id=cid-env&post_logout_redirect_uri=' +
					encodeURIComponent('https://app.autional.com/') +
					'&state=' +
					encodeURIComponent('https://app.autional.com/demo/'),
			);
		});

		it('auth 域租户页登出同样走同源标准端点（不再裸根 / 不经 /<slug>/login）', () => {
			mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', CID_CONFIG);
			const url = buildLogoutUrl('https://auth.autional.local/acme-corp/dashboard');
			expect(url).toBe(
				'https://auth.autional.local/oauth/api/v1/oauth/logout?client_id=cid-env&post_logout_redirect_uri=' +
					encodeURIComponent('https://auth.autional.local/') +
					'&state=' +
					encodeURIComponent('https://auth.autional.local/acme-corp/dashboard'),
			);
			expect(url).not.toContain('/acme-corp/login');
		});

		it('无回程：仅 client_id + post_logout_redirect_uri，不产 state', () => {
			mockWindow('app.autional.com', 'https:', 'https://app.autional.com', CID_CONFIG);
			const url = buildLogoutUrl();
			expect(url).toBe(
				'https://app.autional.com/oauth/api/v1/oauth/logout?client_id=cid-env&post_logout_redirect_uri=' +
					encodeURIComponent('https://app.autional.com/'),
			);
		});

		describe('client_id 三级来源（会话持久化 → env → 空）', () => {
			it('localStorage 会话值优先于 env', () => {
				vi.stubGlobal('localStorage', { getItem: () => 'cid-session' });
				mockWindow('app.autional.com', 'https:', 'https://app.autional.com', CID_CONFIG);
				const url = buildLogoutUrl('https://app.autional.com/demo/');
				expect(url).toContain('client_id=cid-session');
				expect(url).not.toContain('cid-env');
			});

			it('localStorage 空 → env 兜底', () => {
				vi.stubGlobal('localStorage', { getItem: () => null });
				mockWindow('app.autional.com', 'https:', 'https://app.autional.com', CID_CONFIG);
				expect(buildLogoutUrl()).toContain('client_id=cid-env');
			});

			it('双空 → legacy 兜底：auth 裸根 + redirect 回程 + logout=1', () => {
				mockWindow('app.autional.com', 'https:', 'https://app.autional.com', AUTH_CONFIG);
				const url = buildLogoutUrl('https://app.autional.com/demo/');
				expect(url).toBe(
					'https://auth.autional.com/?redirect=' +
						encodeURIComponent('https://app.autional.com/demo/') +
						'&logout=1',
				);
			});

			it('双空 + 无回程 → legacy 裸根 + logout=1（现行为保持）', () => {
				mockWindow('auth.autional.local', 'https:', 'https://auth.autional.local', AUTH_CONFIG);
				const url = buildLogoutUrl();
				expect(url).toBe('https://auth.autional.local/?logout=1');
			});
		});
	});
});

// ============================================================
// F-W8b 修复②：登录承接面判定（onUnauthorized 抑制整页弹走的判据）
//  承接面（只清理不导航）：`/`、`/login`、`/<slug>/login`、`/error`
//  非承接面（照常弹登录页）：应用页、PKCE 发起页、其它静态路由
// ============================================================
function mockPathname(pathname: string): void {
	vi.stubGlobal('window', {
		location: { pathname, hostname: 'auth.autional.local', protocol: 'https:' },
		__APP_CONFIG__: MOCK_CONFIG,
	});
}

describe('isAuthLoginSurface', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		['裸根入口', '/', true],
		['/login 入口', '/login', true],
		['错误页', '/error', true],
		['租户登录页', '/demo/login', true],
		['带尾斜杠的租户登录页', '/demo/login/', true],
		['应用页 dashboard', '/demo/dashboard', false],
		['租户 index（守卫跳转页）', '/demo', false],
		['裸 dashboard', '/dashboard', false],
		['PKCE 发起页', '/oauth/api/v1/oauth/authorize', false],
		['重置密码页', '/reset-password', false],
		['注册页', '/demo/register', false],
	])('%s（%s）→ %s', (_name, pathname, expected) => {
		mockPathname(pathname as string);
		expect(isAuthLoginSurface()).toBe(expected);
	});

	it('服务端渲染（无 window）→ false，不抑制', () => {
		vi.stubGlobal('window', undefined);
		expect(isAuthLoginSurface()).toBe(false);
	});
});
