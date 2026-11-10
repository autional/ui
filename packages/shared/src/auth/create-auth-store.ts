/**
 * 认证 store 工厂 —— **存储位置可选择**（配置中心需要 sessionStorage 的安全取舍）。
 *
 * 背景（docs/CONSOLE-KIT-DECISION.md §3-1）：
 * 认证态此前固定 `zustand/persist` 默认的 localStorage；配置中心出于「管理面降低长期驻留风险」
 * 只落 sessionStorage（关标签即失效）。直接迁移到 shared 会把安全策略改回去 —— 不可接受。
 * 因此把「存哪」变成**显式参数**，而不是让每个站复制一套 auth：
 *
 *   // 应用入口（**推荐**）：安装式单例，全部 shared 导出共用同一实例
 *   configureAuthStore({ storage: 'session' });   // 配置中心
 *   configureAuthStore({ storage: 'local' });     // 密钥中心（其余 9 个消费方不调用 = 默认 local）
 *
 *   // 工厂本身只在两种场景直接用：测试、或一个进程里要多个独立实例
 *   const store = createAuthStore({ storage: 'session' });
 *
 * 默认 `local` ⇒ 现有消费方行为不变（纯增量）。注意：直接 `createAuthStore()` 造出的实例
 * **不会**被 `useAuthStore` / `AuthService` 看到 —— 应用侧请用 `configureAuthStore()`。
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import type { StoreApi } from 'zustand';
import type { User } from '../types';
import { decodeJwtPayload } from './jwt-payload';

/** 认证态持久化位置。 */
export type AuthStorageMode = 'local' | 'session';

export interface AuthState {
	// State
	user: User | null;
	accessToken: string | null;
	refreshToken: string | null;
	tenants: Array<{ id: string; name: string; role: string }>;
	currentTenantId: string | null;
	permissions: string[];
	isAuthenticated: boolean;

	// Actions
	setAuth: (accessToken: string, refreshToken: string, user: User) => void;
	setTokens: (accessToken: string, refreshToken: string) => void;
	setUser: (user: User) => void;
	setTenants: (tenants: Array<{ id: string; name: string; role: string }>) => void;
	setCurrentTenant: (tenantId: string) => void;
	switchTenant: (tenantId: string) => void;
	setPermissions: (permissions: string[]) => void;
	clearAuth: () => void;
}

export interface CreateAuthStoreOptions {
	/** 持久化位置，默认 `local`（与迁移前一致）。 */
	storage?: AuthStorageMode;
	/** persist key，默认 `autional-auth-v1`（与迁移前一致）。 */
	name?: string;
	/** persist version，默认 `1`。 */
	version?: number;
}

/** 内存兜底：隐私模式 / 禁用存储时不抛到 UI，只是不持久化。 */
function createMemoryStorage(): StateStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

/**
 * 按 mode 取浏览器存储。**每次调用惰性解析**（不在模块加载期读 window）：
 * - SSR / 单测无 window ⇒ 内存兜底
 * - 隐私模式读 `window.localStorage` 本身会抛 ⇒ 内存兜底
 */
export function resolveAuthStorage(mode: AuthStorageMode): StateStorage {
	const fallback = createMemoryStorage();
	try {
		if (typeof window === 'undefined') return fallback;
		const backing = mode === 'session' ? window.sessionStorage : window.localStorage;
		if (!backing) return fallback;
		return {
			getItem: (key) => {
				try {
					return backing.getItem(key);
				} catch {
					return fallback.getItem(key) as string | null;
				}
			},
			setItem: (key, value) => {
				try {
					backing.setItem(key, value);
				} catch {
					fallback.setItem(key, value);
				}
			},
			removeItem: (key) => {
				try {
					backing.removeItem(key);
				} catch {
					fallback.removeItem(key);
				}
			},
		};
	} catch {
		return fallback;
	}
}

/** 认证 store 实例类型（zustand bound store 的 API 面）。 */
export type AuthStoreApi = StoreApi<AuthState>;

/**
 * 创建认证 store（可选择持久化位置）。
 *
 * 与旧实现的差异仅在 `storage`；`name` / `version` / `merge` / `migrate` / `partialize` /
 * `onRehydrateStorage` 逻辑逐行保留（坏数据自愈：有 token 无 isAuthenticated、无 token 有
 * isAuthenticated、有 token 无 user 时从 JWT 回填）。
 */
export function createAuthStore(options: CreateAuthStoreOptions = {}): AuthStoreApi {
	const { storage = 'local', name = 'autional-auth-v1', version = 1 } = options;

	// onRehydrateStorage 需要 api，但它在 persist 的 options 里（与 creator 平级）⇒ 用 ref 捕获。
	let storeRef: AuthStoreApi | null = null;

	const store = create<AuthState>()(
		persist(
			(set, _get, api) => {
				storeRef = api;
				return {
				user: null,
				accessToken: null,
				refreshToken: null,
				tenants: [],
				currentTenantId: null,
				permissions: [],
				isAuthenticated: false,

				setAuth: (accessToken, refreshToken, user) => {
					if (!user) return;
					const validToken = accessToken && accessToken !== 'undefined' && accessToken !== 'null';
					set({
						accessToken: validToken ? accessToken : null,
						refreshToken: validToken ? refreshToken : null,
						user,
						isAuthenticated: true,
					});
				},

				setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),

				setUser: (user) => set({ user }),

				setTenants: (tenants) => set({ tenants }),

				setCurrentTenant: (tenantId) => set({ currentTenantId: tenantId }),

				switchTenant: (tenantId) => set({ currentTenantId: tenantId }),

				setPermissions: (permissions) => set({ permissions }),

					clearAuth: () =>
						set({
							user: null,
							accessToken: null,
							refreshToken: null,
							tenants: [],
							currentTenantId: null,
							permissions: [],
							isAuthenticated: false,
						}),
				};
			},
			{
				name,
				version,
				storage: createJSONStorage(() => resolveAuthStorage(storage)),
				// Custom merge: validate persisted data integrity before merging into store.
				// This prevents corrupted storage entries from silently breaking auth.
				merge: (persisted, current) => {
					if (!persisted || typeof persisted !== 'object') return current;
					const state = { ...current, ...(persisted as Record<string, unknown>) } as AuthState;

					// Fix: has accessToken but isAuthenticated is false
					if (state.accessToken && !state.isAuthenticated) {
						state.isAuthenticated = true;
					}
					// Fix: no accessToken but isAuthenticated is true (token was evicted)
					if (!state.accessToken && state.isAuthenticated) {
						state.isAuthenticated = false;
					}
					// Fix: has accessToken but user is missing — recover from JWT
					if (state.accessToken && !state.user) {
						const payload = decodeJwtPayload(state.accessToken);
						if (payload) {
							state.user = {
								id: (payload.sub || payload.user_id) as string,
								username: ((payload.custom as Record<string, unknown> | undefined)?.username ||
									payload.username) as string,
								email: (payload.email as string) || '',
								status: 'active',
							};
						}
					}

					return state;
				},
				migrate: (persisted) => {
					// v0 → v1: no structural changes, data is compatible
					return persisted as unknown as AuthState;
				},
				partialize: (state) => {
					return {
						accessToken:
							state.accessToken && state.accessToken !== 'undefined' && state.accessToken !== 'null'
								? state.accessToken
								: null,
						refreshToken:
							state.refreshToken &&
							state.refreshToken !== 'undefined' &&
							state.refreshToken !== 'null'
								? state.refreshToken
								: null,
						user: state.user,
						tenants: state.tenants,
						currentTenantId: state.currentTenantId,
						permissions: state.permissions,
						isAuthenticated: state.isAuthenticated,
					};
				},
				onRehydrateStorage: () => (state, error) => {
					if (error || !state) return;
					// merge already handles all fixups; this is a safety net
					if (state.accessToken && !state.isAuthenticated) {
						storeRef?.setState({ isAuthenticated: true });
					}
				},
			},
		),
	);

	return store as AuthStoreApi;
}
