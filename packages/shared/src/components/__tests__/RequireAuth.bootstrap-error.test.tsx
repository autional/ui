// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// ============================================================
// P1-2 回归锁（2026-11-08 用户门户线上复现）
//  后端 bootstrap 接口全 5xx 时，useBootstrap 曾返回 'loading' ⇒ 状态机永停
//  bootstrap ⇒ RequireAuth 恒 render null ⇒ 整站白屏（无提示/无重试/不跳登录）。
//  修复后：bootstrapState==='error' 必须渲染可恢复错误页，且不得渲染子路由。
// ============================================================

const { mockState } = vi.hoisted(() => ({
	mockState: {
		machineStatus: 'ready' as string,
		bootstrapState: 'error' as string,
		tenantRoute: {
			slug: 'acme-corp',
			tenantId: 't1',
			oauthClientId: null as string | null,
			loading: false,
			notFound: false,
			unknownSlug: false,
		},
	},
}));

vi.mock('../../auth/auth-machine', () => ({
	useAuthMachine: () => ({
		status: mockState.machineStatus,
		bootstrapState: mockState.bootstrapState,
	}),
}));

vi.mock('../../auth/tenant-route-middleware', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/tenant-route-middleware')>()),
	useTenantRoute: () => mockState.tenantRoute,
}));

// 部分 mock：保留真实 scope 常量/判定（RequireAuth 的 scope 升级 effect 依赖它们）。
vi.mock('../../auth/oauth-login', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../auth/oauth-login')>()),
	initiateOAuthLogin: vi.fn(),
}));

vi.mock('../../auth/service', () => ({
	AuthService: {
		getAccessToken: () => 'token-xyz',
		getCurrentRole: () => 'member',
		getPermissions: () => ['user.read'],
	},
	setBootstrapLock: vi.fn(),
}));

import { RequireAuth } from '../RequireAuth';

describe('RequireAuth（P1-2 启动失败不得白屏）', () => {
	beforeEach(() => {
		mockState.machineStatus = 'ready';
		mockState.bootstrapState = 'error';
		document.documentElement.lang = 'zh-CN';
	});

	afterEach(() => cleanup());

	it('bootstrapState=error → 渲染错误页 + 重试按钮，且不渲染子路由', () => {
		render(
			<RequireAuth>
				<div data-testid="protected">受保护内容</div>
			</RequireAuth>,
		);

		expect(screen.getByRole('alert')).toBeInTheDocument();
		expect(screen.getByText('加载失败')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
		expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
	});

	it('英文界面错误页文案（<html lang="en">）', () => {
		document.documentElement.lang = 'en-US';
		render(
			<RequireAuth>
				<div data-testid="protected">protected</div>
			</RequireAuth>,
		);
		expect(screen.getByText('Failed to load')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('bootstrapState=ready → 正常渲染子路由（修复不得误伤正常路径）', () => {
		mockState.bootstrapState = 'ready';
		render(
			<RequireAuth>
				<div data-testid="protected">受保护内容</div>
			</RequireAuth>,
		);
		expect(screen.getByTestId('protected')).toBeInTheDocument();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});
});
