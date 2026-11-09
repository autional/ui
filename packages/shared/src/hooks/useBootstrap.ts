'use client';

import { useEffect } from 'react';
import { useAuthStore } from '../auth/store';
import { AuthService } from '../auth/service';
import { usePermissionsQuery, useTenantsQuery } from '../auth/auth-queries';

export type BootstrapState = 'idle' | 'loading' | 'ready' | 'error';

// 头像补读的 in-flight 去重：useBootstrap 被多个消费组件同时调用时（顶栏/侧栏/页面），
// 同一个 userId+tenantId 只发一次 GET /profile/avatar；请求结束即释放，
// 后续挂载/切换用户或租户会重新补读（与原实现同语义，只是去掉并发重复）。
const avatarRequests = new Map<string, Promise<string | null>>();

function fetchAvatarOnce(key: string): Promise<string | null> {
	const existing = avatarRequests.get(key);
	if (existing) return existing;

	const promise = import('../generated/api')
		.then(({ profileAvatar }) => profileAvatar())
		.then((res) => (((res as { avatarUrl?: string } | undefined)?.avatarUrl ?? '').trim() || null))
		.catch(() => null) // 忽略：缺头像不影响启动
		.finally(() => {
			avatarRequests.delete(key);
		});

	avatarRequests.set(key, promise);
	return promise;
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
	// 并发去重见 fetchAvatarOnce：同一 userId+tenantId 只发一次请求。
	const userId = useAuthStore((s) => s.user?.id);
	useEffect(() => {
		if (!hasToken) return;
		const cacheKey = `${userId ?? ''}|${currentTenantId ?? ''}`;
		let cancelled = false;
		void fetchAvatarOnce(cacheKey).then((avatarUrl) => {
			if (cancelled || !avatarUrl) return;
			const current = useAuthStore.getState().user;
			if (current && current.avatarUrl !== avatarUrl) {
				useAuthStore.getState().setUser({ ...current, avatarUrl });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [hasToken, userId, currentTenantId]);

	// 无会话 = 无数据可引导：返回 'idle'，登录交棒由 RequireAuth/守卫决策（见上）。
	// 不得返回 'loading'：Layout 消费者（platform-console）以 bootstrap==='loading'
	// 挡 Outlet，而 RequireAuth 在 Outlet 里 ⇒ 无会话冷启动永停 Spin、守卫永不挂载（F-W5b）。
	if (!hasToken) {
		return 'idle';
	}

	// 已缓存数据 → 立即 ready
	if (permissionsStore.length > 0 && tenantsStore.length > 0) {
		return 'ready';
	}

	// React Query 数据到达（即使是 stale）
	if (permsQuery.data || tentsQuery.data) {
		return 'ready';
	}

	// 两个请求都失败 —— 语义是「启动失败」，不是「仍在加载」。
	// 旧实现返回 'loading'（原注释：防重渲染循环），使状态机永停 bootstrap、
	// RequireAuth 恒 render null ⇒ 后端 5xx 时整站白屏（P1-2，2026-11-08 线上复现：
	// 四个 bootstrap 接口全 500 → #root 只剩空容器，无提示/无重试）。
	// 返回 'error' 是稳定值（不会抖动），由 RequireAuth 渲染可恢复错误页。
	if (permsQuery.isError && tentsQuery.isError) {
		return 'error';
	}

	// 等待中
	return 'loading';
}
