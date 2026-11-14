// @vitest-environment jsdom
// ============================================================
// TASK-AB1-29 · RequireAuth 对抗测试 6 类（RC-4 / A-445）
// 修复前基线（2026-10-04）：本文件对未修复代码运行，组①③必须红（fail-open 实证）；
// 修复（TASK-AB1-01）后 6 类全绿，即 A-445 子串穿透永久钉死。
// 14 条 `*:admin` 弹药清单以 findings §1.1 实扫枚举为准（防清单漂移）。
// ============================================================
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockState } = vi.hoisted(() => ({
	mockState: {
		machineStatus: 'ready' as string,
		role: 'admin' as string | null,
		permissions: [] as string[],
	},
}));

vi.mock('../../auth/auth-machine', () => ({
	useAuthMachine: () => ({ status: mockState.machineStatus }),
}));

vi.mock('../../auth/tenant-route-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/tenant-route-middleware')>()),
	useTenantRoute: () => ({
		slug: null,
		tenantId: null,
		oauthClientId: null,
		loading: false,
		notFound: false,
		unknownSlug: false,
	}),
}));

// 部分 mock：保留真实 scope 常量/判定（RequireAuth 的 scope 升级 effect 依赖它们）。
vi.mock('../../auth/oauth-login', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/oauth-login')>()),
	initiateOAuthLogin: vi.fn(),
}));

vi.mock('../../auth/service', () => ({
	AuthService: {
		getAccessToken: () => null,
		getCurrentRole: () => mockState.role,
		getPermissions: () => mockState.permissions,
	},
	setBootstrapLock: vi.fn(),
}));

import { RequireAuth } from '../RequireAuth';

/** findings §1.1：security_admin 存量持有的 14 条 `*:admin` 弹药（实扫自 platform_rbac.go catalog） */
const AMMO_14 = [
	'tenant:admin',
	'saml:admin',
	'mfa:admin',
	'billing:admin',
	'notification:admin',
	'pay:admin',
	'compliance:admin',
	'wallet:admin',
	'point:admin',
	'oauth:admin',
	'secret:admin',
	'status:admin',
	'identity:admin',
	'storage:admin',
];

const ADMIN_ONLY = ['super_admin', 'admin'] as const;
const SECURITY_READ = ['super_admin', 'admin', 'security_admin'] as const;

function renderGuard(checkpoint: string, props: Record<string, unknown>) {
	return render(
		<RequireAuth
			fallback={<div data-testid={`forbidden-${checkpoint}`}>forbidden</div>}
			{...props}
		>
			<div data-testid={`protected-${checkpoint}`}>protected</div>
		</RequireAuth>,
	);
}

beforeEach(() => {
	mockState.machineStatus = 'ready';
	mockState.role = 'admin';
	mockState.permissions = [];
	delete (window as any).__APP_CONFIG__;
});

afterEach(() => {
	cleanup();
});

describe('RequireAuth 对抗 6 类（A-445 / RC-4）', () => {
	it('① security_admin + 14 条 *:admin 弹药 + Admin 白名单 ⇒ 拦截（子串穿透不得成立）', () => {
		mockState.role = 'security_admin';
		mockState.permissions = [...AMMO_14];

		renderGuard('c1', { allowedRoles: ADMIN_ONLY });

		expect(screen.getByTestId('forbidden-c1')).toBeInTheDocument();
		expect(screen.queryByTestId('protected-c1')).toBeNull();
	});

	it('② admin / super_admin ⇒ 放行', () => {
		mockState.role = 'admin';
		const r1 = renderGuard('c2a', { allowedRoles: ADMIN_ONLY });
		expect(screen.getByTestId('protected-c2a')).toBeInTheDocument();
		r1.unmount();

		mockState.role = 'super_admin';
		renderGuard('c2b', { allowedRoles: ADMIN_ONLY });
		expect(screen.getByTestId('protected-c2b')).toBeInTheDocument();
	});

	it('③ user_manager / 空权限 ⇒ fail-closed 拦截', () => {
		mockState.role = 'user_manager';
		mockState.permissions = [];

		renderGuard('c3', { allowedRoles: ADMIN_ONLY });

		expect(screen.getByTestId('forbidden-c3')).toBeInTheDocument();
		expect(screen.queryByTestId('protected-c3')).toBeNull();
	});

	it('④ role=null ⇒ 穿透（现语义锁定，防误改）', () => {
		mockState.role = null;
		mockState.permissions = [];

		renderGuard('c4', { allowedRoles: ADMIN_ONLY });

		expect(screen.getByTestId('protected-c4')).toBeInTheDocument();
	});

	it('⑤ 持 \"*\" 的非白名单角色 ⇒ 放行（豁免对照组）', () => {
		mockState.role = 'operator';
		mockState.permissions = ['*'];

		renderGuard('c5', { allowedRoles: ADMIN_ONLY });

		expect(screen.getByTestId('protected-c5')).toBeInTheDocument();
	});

	it('⑥ security_admin + SecurityRead（含 security_admin）白名单 ⇒ 放行（对照组）', () => {
		mockState.role = 'security_admin';
		mockState.permissions = ['audit:read', 'compliance:read'];

		renderGuard('c6', { allowedRoles: SECURITY_READ });

		expect(screen.getByTestId('protected-c6')).toBeInTheDocument();
	});

	it('⑦ allowedRoles 未配置 ⇒ 直通 children（AC-AB1-04 回归锁）', () => {
		mockState.role = 'member';
		mockState.permissions = ['user:read'];

		render(
			<RequireAuth>
				<div data-testid="protected-c7">protected</div>
			</RequireAuth>,
		);

		expect(screen.getByTestId('protected-c7')).toBeInTheDocument();
	});
});
