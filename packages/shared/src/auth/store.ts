/**
 * Autional 全局认证状态管理 (Zustand)
 * 所有前端应用共用同一个 auth store
 *
 * 职责划分（AC-008）：前端角色（tenants[].role 派生）仅用于 UX 呈现；
 * 安全判断由后端 rbac-backed 授权强制，前端不做凭角色放行的敏感操作。
 *
 * 存储位置（docs/CONSOLE-KIT-DECISION.md §4-1）：
 * 默认 localStorage（与迁移前完全一致）；需要 sessionStorage 的站（配置中心）在**入口最早期**
 * 调用 `configureAuthStore({ storage: 'session' })`，此后所有 shared 导出（含 AuthService、
 * useAuth / usePermission / usePortalCatalog）都读同一个实例。
 */

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import type { User } from '../types';
import { traceRedirect } from './auth-trace';
import { decodeJwtPayload } from './jwt-payload';
import {
	createAuthStore,
	type AuthState,
	type AuthStorageMode,
	type CreateAuthStoreOptions,
} from './create-auth-store';

export type { AuthState, AuthStorageMode, CreateAuthStoreOptions } from './create-auth-store';

export type AuthStoreApi = StoreApi<AuthState>;

/**
 * 当前生效实例 + 其存储模式。
 * 惰性创建：首次访问时才实例化，保证 `configureAuthStore()` 能先于任何读取生效。
 */
let activeStore: AuthStoreApi | null = null;
let activeStorageMode: AuthStorageMode | null = null;

/**
 * 配置并返回认证 store（**幂等**：已创建则原样返回，不重复建实例）。
 *
 * 必须在应用入口、任何认证态读取之前调用；形态：
 *
 *   configureAuthStore({ storage: 'session' });  // 配置中心
 *   // 其余站不调用即可 —— 默认 local，行为与迁移前一致
 *
 * 若在 store 已创建后再以不同 storage 调用：**生产也告警**并沿用已创建实例
 * （避免"两套 auth 同时写 token"导致一半页面登出；静默降级等于悄悄退回 localStorage）。
 */
export function configureAuthStore(options: CreateAuthStoreOptions = {}): AuthStoreApi {
	const mode = options.storage ?? 'local';
	if (activeStore) {
		if (activeStorageMode !== mode) {
			// **生产也告警**：静默降级等于把 sessionStorage 的安全取舍悄悄退回 localStorage
			// （关标签仍存活），日志里必须留痕。
			console.warn(
				`[auth] configureAuthStore({ storage: '${mode}' }) 早于 store 创建才生效；` +
					`当前实例已是 '${String(activeStorageMode)}'，本次忽略。` +
					'请在应用入口最早期调用。',
			);
		}
		return activeStore;
	}
	activeStore = createAuthStore({ ...options, storage: mode });
	activeStorageMode = mode;
	return activeStore;
}

/** 当前生效 store（未配置则按默认 local 惰性创建）。 */
export function getAuthStore(): AuthStoreApi {
	return activeStore ?? configureAuthStore();
}

/** 当前生效存储模式（测试与诊断用）。 */
export function getAuthStorageMode(): AuthStorageMode {
	getAuthStore();
	return activeStorageMode ?? 'local';
}

/** 丢弃当前实例（**仅测试**：隔离用例之间的存储/状态串扰）。 */
export function resetAuthStore(): void {
	activeStore = null;
	activeStorageMode = null;
}

/** 兼容旧调用点的 hook 形状：可当 hook 用，也可 `.getState()` / `.setState()` / `.subscribe()`。 */
export type AuthStoreHook = {
	<T>(selector: (state: AuthState) => T): T;
	(): AuthState;
	getState: () => AuthState;
	getInitialState: () => AuthState;
	setState: AuthStoreApi['setState'];
	subscribe: AuthStoreApi['subscribe'];
	/** persist 中间件附加 API（rehydrate / hasHydrated …）；未使用 persist 时为 undefined。 */
	persist?: unknown;
};

const identity = (state: AuthState): AuthState => state;

const authStoreHook = Object.assign(
	<T>(selector?: (state: AuthState) => T): T | AuthState => {
		// 始终只调一次 useStore（同一 hook 位置），避免选择器有无变化导致 hook 顺序不一致
		const store = getAuthStore();
		const pick = (selector ?? identity) as (state: AuthState) => T | AuthState;
		return useStore(store, pick);
	},
	{
		getState: () => getAuthStore().getState(),
		getInitialState: () => getAuthStore().getInitialState(),
		setState: ((partial: unknown, replace?: boolean) =>
			(0, getAuthStore().setState)(partial as never, replace as never)) as AuthStoreApi['setState'],
		subscribe: ((listener: Parameters<AuthStoreApi['subscribe']>[0]) =>
			getAuthStore().subscribe(listener)) as AuthStoreApi['subscribe'],
	},
);

// persist 中间件把 API 挂在 store api 上。
// **必须用 defineProperty 定义 getter** —— 若写成 `Object.assign(fn, { get persist() {…} })`，
// Object.assign 会在**模块求值期**读取该 getter，于是导入 store 就立刻创建了 store（默认 local），
// 之后站点再 `configureAuthStore({storage:'session'})` 只会命中"已建实例"分支 ⇒ sessionStorage 静默失效。
Object.defineProperty(authStoreHook, 'persist', {
	configurable: true,
	enumerable: false,
	get: () => (getAuthStore() as unknown as { persist?: unknown }).persist,
});

export const useAuthStore: AuthStoreHook = authStoreHook as unknown as AuthStoreHook;

/**
 * 获取 access token
 */
export function getAccessToken(): string | null {
	const state = useAuthStore.getState().accessToken;
	if (state && state !== 'undefined' && state !== 'null') return state;

	return null;
}

/**
 * 获取 refresh token
 */
export function getRefreshToken(): string | null {
	const state = useAuthStore.getState().refreshToken;
	if (state && state !== 'undefined' && state !== 'null') return state;
	return null;
}

/**
 * 获取当前租户 ID
 */
export function getCurrentTenantId(): string | null {
	return useAuthStore.getState().currentTenantId;
}

/**
 * 获取当前租户下的角色（userinfo-first，非响应式）
 * 派生自 store.tenants + currentTenantId —— 不解析 token 载荷。
 * 前端角色仅用于 UX 呈现；安全判断由后端 rbac-backed 授权强制（AC-008）。
 */
export function getCurrentRole(): string | null {
	const { tenants, currentTenantId } = useAuthStore.getState();
	if (!tenants || tenants.length === 0) return null;
	if (!currentTenantId) return null;
	return tenants.find((t) => t.id === currentTenantId)?.role ?? null;
}

/**
 * 使用 token 登录（设置认证状态）
 */
export function loginWithTokens(
	accessToken: string | null,
	refreshToken: string | null,
	user: User,
): void {
	useAuthStore.getState().setAuth(accessToken || '', refreshToken || '', user);
}

/**
 * 退出登录（清除认证状态 + localStorage/cookie）
 * 委托给 AuthService.logout() 统一实现
 * 使用动态 import 避免 circular dependency (service.ts → store.ts)
 *
 * redirectTo（U350）：显式落点（会话过期→auth /error、注销完成→/<slug>/login?account_deleted=true 等
 * 旗标页）——清理完成后整页前往。缺省仅清会话、不导航；注意与 useLogout 口径区分：该 hook 走
 * buildLogoutUrl 登出流（LS-08：同源标准端点；client_id 不可得时退 legacy logout=1 交入口路由），
 * 不得用于需要保留业务 query 旗标的目标。
 */
export async function logout(redirectTo?: string): Promise<void> {
	const { AuthService } = await import('./service');
	await AuthService.logout();
	if (redirectTo) {
		traceRedirect(redirectTo, { reason: 'logout', assign: true });
	}
}

export function isTokenExpired(token: string): boolean {
	const payload = decodeJwtPayload(token);
	const exp = payload?.exp as number | undefined;
	if (!exp) return true;
	return Date.now() >= exp * 1000;
}

export async function refreshAccessToken(): Promise<string | null> {
	// 统一委托 AuthService.refreshToken()（含并发去重 + JWT/opaque 分流 + onUnauthorized 处理），
	// 消除双实现：store 版不再持有重复的 refresh 逻辑（此前与 service 版不一致——无并发去重）。
	// 动态 import 避免 store.ts ↔ service.ts 循环依赖。
	const { AuthService } = await import('./service');
	return AuthService.refreshToken();
}
