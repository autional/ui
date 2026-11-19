'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../auth/store';
import { AuthService } from '../auth/service';
import { usePermissionsQuery, useTenantsQuery } from '../auth/auth-queries';

export type BootstrapState = 'idle' | 'loading' | 'ready' | 'error';

/** 启动数据的「角色可判据」视图（供守卫区分「未就绪」与「确定无角色」）。 */
export interface AuthDataStatus {
	/** 启动数据总体状态 —— 与 useBootstrap() 返回值逐字相同（既有语义不变）。 */
	bootstrap: BootstrapState;
	/**
	 * 租户名单的权威快照：**查询结果优先**，其次 store。
	 * 优先取查询结果是为了消除「查询已返回 → store 写入 effect」之间的一帧滞后
	 * （否则守卫会在这一帧把"角色即将到达"误判成"确定无角色"）。
	 */
	tenants: Array<{ id: string; name: string; role: string }>;
	/**
	 * 租户名单是否已定型（成功或失败都算定型）。
	 * true ⇒ 再看 store 派生角色仍为 null，即「确定无角色」；
	 * false ⇒ 仍在途，`role === null` 只代表「未知」（不得据此拒绝）。
	 */
	tenantsSettled: boolean;
}

/**
 * 应用启动数据加载 Hook。
 *
 * 使用 React Query 缓存权限和租户数据（5 分钟 staleTime），
 * 避免重复请求。首次加载时自动写入 AuthService。
 *
 * 返回 BootstrapState 用于 Portal Layout 展示加载状态。
 */
export function useBootstrap(): BootstrapState {
	return useAuthDataStatus().bootstrap;
}

/**
 * 启动数据的完整视图（useBootstrap 的超集，纯增量导出）。
 *
 * **为什么不把 `role === null` 一律判为拒绝**：`role === null` 有三种含义 ——
 * ① 租户/权限数据还在途（未就绪）；② 已成型但当前租户无角色；③ 未登录。
 * ① 判拒绝会把「角色马上到达」的合法用户闪成 forbidden（站点常接
 * `<ForbiddenRedirect/>`，等于误跳 403）；② 判放行则是 fail-open 穿透。
 * 因此守卫必须先拿到「是否已定型」，再决定「等待」还是「拒绝」。
 *
 * 就绪判据的取舍（无反例信号的说明见 RequireAuth 角色门控注释）：
 * - 租户查询 isSuccess/isError（React Query 已定型）→ 定型；
 * - 未定型且 store 也派不出角色 ⇒ 未就绪（渲染 loading，不放行也不拒绝）。
 */
export function useAuthDataStatus(): AuthDataStatus {
	const currentTenantId = useAuthStore((s) => s.currentTenantId);
	const permissionsStore = useAuthStore((s) => s.permissions);
	const tenantsStore = useAuthStore((s) => s.tenants);

	// 无有效 token 时不发起权限/租户查询。
	// 未登录时这些查询必然 401 → apiClient 401 拦截 → refreshToken() 无 refresh token
	// → onUnauthorized() 立即 buildLoginUrl 302，抢跑 RequireAuth 的 OAuth PKCE 决策
	// （跨域 admin 场景偶发：本应跳 authorize，实际却 302 回 auth 登录页）。
	// 未登录的跳转决策统一交给 RequireAuth（OAuth PKCE 或 buildLoginUrl）。
	const rawToken = AuthService.getAccessToken();
	const hasToken = !!rawToken && rawToken !== 'undefined' && rawToken !== 'null';

	// React Query: 5 分钟缓存，自动管理 loading/error
	// key 中包含 currentTenantId，切换租户时自动重新请求
	const permsQuery = usePermissionsQuery(currentTenantId, hasToken);
	const tentsQuery = useTenantsQuery(currentTenantId, hasToken);

	// 同步 React Query 结果到 AuthService（写入 store 触发 persist）
	useEffect(() => {
		if (permsQuery.data && permsQuery.data.length > 0) {
			AuthService.updatePermissions(permsQuery.data);
		}
	}, [permsQuery.data]);

	useEffect(() => {
		if (tentsQuery.data && tentsQuery.data.length > 0) {
			AuthService.updateTenants(tentsQuery.data);
		}
	}, [tentsQuery.data]);

	// U447：头像补读 —— 登录响应与 /auth/me 都不含 avatarUrl（头像存在 profile 服务），
	// 认证快照里的头像只在上传当次或同浏览器持久化后才有值。启动时补读一次
	// GET /profile/avatar 并写回快照，顶栏 UserMenu 才能显示账号真实头像；
	// 失败静默（展示层回落首字母，不影响任何业务流程）。
	// 用动态 import 引生成客户端：generated/api 反向 import '@autional/shared'，
	// 静态导入会在包入口形成循环，动态导入等入口初始化完再求值。
	// React Query 负责去重与缓存：同一 userId+tenantId 并发/重复挂载只发一次请求（5 分钟缓存）。
	const queryClient = useQueryClient();
	const userId = useAuthStore((s) => s.user?.id);
	useEffect(() => {
		if (!hasToken) return;
		let cancelled = false;
		void queryClient
			.fetchQuery({
				queryKey: ['profile-avatar', userId ?? '', currentTenantId ?? ''],
				queryFn: async () => {
					const { profileAvatar } = await import('../generated/api');
					const res = await profileAvatar();
					return ((res as { avatarUrl?: string } | undefined)?.avatarUrl ?? '').trim() || null;
				},
				staleTime: 5 * 60_000,
				retry: false, // 头像失败静默，不重试
			})
			.then((avatarUrl) => {
				if (cancelled || !avatarUrl) return;
				const current = useAuthStore.getState().user;
				if (current && current.avatarUrl !== avatarUrl) {
					useAuthStore.getState().setUser({ ...current, avatarUrl });
				}
			})
			.catch(() => {
				/* 忽略：缺头像不影响启动 */
			});
		return () => {
			cancelled = true;
		};
	}, [hasToken, userId, currentTenantId, queryClient]);

	// 无会话 = 无数据可引导：返回 'idle'，登录交棒由 RequireAuth/守卫决策（见上）。
	// 不得返回 'loading'：Layout 消费者（platform-console）以 bootstrap==='loading'
	// 挡 Outlet，而 RequireAuth 在 Outlet 里 ⇒ 无会话冷启动永停 Spin、守卫永不挂载（F-W5b）。
	const bootstrap: BootstrapState = (() => {
		if (!hasToken) return 'idle';

		// 已缓存数据 → 立即 ready
		if (permissionsStore.length > 0 && tenantsStore.length > 0) return 'ready';

		// React Query 数据到达（即使是 stale）
		if (permsQuery.data || tentsQuery.data) return 'ready';

		// 两个请求都失败 —— 语义是「启动失败」，不是「仍在加载」。
		// 旧实现返回 'loading'（原注释：防重渲染循环），使状态机永停 bootstrap、
		// RequireAuth 恒 render null ⇒ 后端 5xx 时整站白屏（P1-2，2026-11-08 线上复现：
		// 四个 bootstrap 接口全 500 → #root 只剩空容器，无提示/无重试）。
		// 返回 'error' 是稳定值（不会抖动），由 RequireAuth 渲染可恢复错误页。
		if (permsQuery.isError && tentsQuery.isError) return 'error';

		// 等待中
		return 'loading';
	})();

	// 租户名单是否定型：成功/失败都算定型（失败 = 拿不到名单，角色只能判为"未知→不可授权"）。
	// `data !== undefined` 兼容测试桩与 keepPreviousData 之外的自定义 query 形状。
	const tenantsSettled =
		!!tentsQuery.isSuccess || !!tentsQuery.isError || tentsQuery.data !== undefined;

	return {
		bootstrap,
		// 查询结果优先（同一次渲染内与 query 同步，不受 store 写入 effect 的一帧滞后影响）
		tenants: (tentsQuery.data ?? tenantsStore) as Array<{
			id: string;
			name: string;
			role: string;
		}>,
		tenantsSettled,
	};
}
