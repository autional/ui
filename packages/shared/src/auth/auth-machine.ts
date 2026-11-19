/**
 * AuthMachine — 认证流程状态机（轻量版）
 *
 * 统一管理认证流程的各个阶段：
 *   checking → authenticated → bootstrap → ready
 *           → unauthenticated → redirecting
 *
 * 替代 RequireAuth 中的手动 useEffect 链式调用。
 * 不依赖外部状态机库，使用 React hook + reducer 模式。
 *
 * @see docs/architecture/auth-next-issues-analysis.md
 */

'use client';

import { useReducer, useEffect, useMemo } from 'react';
import { AuthService } from './service';
import { useAuthDataStatus, type BootstrapState } from '../hooks/useBootstrap';
import { useCurrentRole } from '../hooks/useCurrentRole';

// ============ Types ============

export type AuthStatus =
	| 'checking' // 初始态：正在检查 token
	| 'authenticated' // token 有效
	| 'bootstrap' // token 有效，正在加载权限/租户
	| 'ready' // 全部就绪
	| 'unauthenticated' // 无有效 token
	| 'redirecting'; // 正在跳转到登录页

export interface AuthMachineState {
	status: AuthStatus;
	hasToken: boolean;
	bootstrapState: BootstrapState;
	/**
	 * 当前租户角色。来源优先 store（与 `AuthService.getCurrentRole()` 同源、同口径），
	 * store 尚未派生出来时用租户查询结果兜底 —— 消除「查询已返回 → store 写入 effect」
	 * 之间的一帧滞后，避免守卫把「角色马上到」误判成「确定无角色」。
	 */
	role: string | null;
	/**
	 * 角色是否已定型。true ⇒ `role === null` 就是「确定无角色」（可据此拒绝）；
	 * false ⇒ 仍在途（守卫必须等待，既不放行也不拒绝）。
	 */
	roleSettled: boolean;
}

/**
 * 状态机自身的核心状态（reducer 维护的部分）。
 * 角色/就绪判据是**派生值**（每次渲染由 store + 租户查询算出），不入 reducer，
 * 因此 reducer 与初始态只需这一层 —— 避免「派生值也进 reducer」造成两份真源。
 */
type AuthCoreState = Pick<AuthMachineState, 'status' | 'hasToken' | 'bootstrapState'>;

type AuthAction =
	| { type: 'TOKEN_FOUND' }
	| { type: 'NO_TOKEN' }
	| { type: 'BOOTSTRAP_LOADING' }
	| { type: 'BOOTSTRAP_READY' }
	| { type: 'BOOTSTRAP_ERROR' }
	| { type: 'SESSION_EXPIRED' }
	| { type: 'REDIRECT' };

// ============ Reducer ============

function authReducer(state: AuthCoreState, action: AuthAction): AuthCoreState {
	switch (action.type) {
		case 'TOKEN_FOUND':
			return { ...state, status: 'authenticated', hasToken: true };

		case 'NO_TOKEN':
			return { ...state, status: 'unauthenticated', hasToken: false };

		case 'BOOTSTRAP_LOADING':
			return state.status === 'authenticated' ? { ...state, status: 'bootstrap' } : state;

		case 'BOOTSTRAP_READY':
			return state.status === 'bootstrap'
				? { ...state, status: 'ready' }
				: state.status === 'authenticated'
					? { ...state, status: 'ready' }
					: state;

		case 'BOOTSTRAP_ERROR':
			// Bootstrap 失败仍应显示 UI（降级运行）
			return state.status === 'bootstrap' ? { ...state, status: 'ready' } : state;

		case 'SESSION_EXPIRED':
			return { ...state, status: 'unauthenticated', hasToken: false };

		case 'REDIRECT':
			return { ...state, status: 'redirecting' };

		default:
			return state;
	}
}

// ============ Initial State ============

function createInitialState(): AuthCoreState {
	const token = AuthService.getAccessToken();
	return {
		status: 'checking',
		hasToken: !!token,
		bootstrapState: 'idle' as const,
	};
}

// ============ Hook ============

/**
 * 认证流程状态机 Hook。
 *
 * 整合 token 检查 + bootstrap 加载为统一状态机，
 * 替代 RequireAuth + useBootstrap 的手动链式调用。
 *
 * 用法:
 * ```tsx
 * function App() {
 *   const machine = useAuthMachine();
 *   const { status, hasToken } = machine;
 *
 *   if (status === 'checking') return <Loading />;
 *   if (status === 'unauthenticated' || status === 'redirecting') return <LoginPage />;
 *   if (status === 'ready') return <Dashboard />;
 *   return <Loading />; // authenticated / bootstrap
 * }
 * ```
 */
export function useAuthMachine(): AuthMachineState {
	const [state, dispatch] = useReducer(authReducer, undefined, createInitialState);
	const authData = useAuthDataStatus();
	const bootstrapState: BootstrapState = authData.bootstrap;
	const storeRole = useCurrentRole();

	// Phase 1: 检查 token
	const hasToken = useMemo(() => {
		const token = AuthService.getAccessToken();
		return !!token && token !== 'undefined' && token !== 'null';
	}, []);

	// Phase 2: 根据 token 和 bootstrap 状态分发事件
	useEffect(() => {
		if (hasToken) {
			dispatch({ type: 'TOKEN_FOUND' });
		} else {
			dispatch({ type: 'NO_TOKEN' });
		}
	}, [hasToken]);

	// Phase 3: bootstrap 状态同步
	useEffect(() => {
		switch (bootstrapState) {
			case 'loading':
				dispatch({ type: 'BOOTSTRAP_LOADING' });
				break;
			case 'ready':
				dispatch({ type: 'BOOTSTRAP_READY' });
				break;
			case 'error':
				dispatch({ type: 'BOOTSTRAP_ERROR' });
				break;
		}
	}, [bootstrapState]);

	// 角色 + 就绪判据（供 RequireAuth 区分「未就绪」与「确定无角色」）
	const role = useMemo(() => {
		if (storeRole) return storeRole;
		const tenantId = AuthService.getCurrentTenantId();
		if (!tenantId) return null;
		return authData.tenants.find((t) => t.id === tenantId)?.role ?? null;
	}, [storeRole, authData.tenants]);
	const roleSettled = role !== null || authData.tenantsSettled;

	return {
		...state,
		hasToken,
		bootstrapState,
		role,
		roleSettled,
	};
}
