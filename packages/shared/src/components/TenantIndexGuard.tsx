/**
 * TenantIndexGuard — 租户 slug 白名单守卫（TASK-425，AC-010）
 *
 * 从 end-user-portal App.tsx L65-111 抽取泛化，供 4 个租户门户复用
 * （不复制 4 份，违反 DRY）。
 *
 * - usePublicTenantSlugs: 调公开 tenants API（无认证端点），staleTime 5m 缓存，
 *   8s 超时（重试由消费方默认策略决定）；失败上抛（不吞成空数组成功）——放行语义由消费方
 *   （TenantIndexGuard / TenantRootRedirect）在失败态自行 fail-open（rc.35）。
 * - TenantIndexGuard: 租户 slug 白名单守卫（P0-2），防止未知 slug 被贪婪渲染为
 *   租户内容（index 首页与 /:slug/... 子路由通用）。404 页由各 portal 通过
 *   notFound prop 注入（shared 组件不能 import 具体 app 的 not-found/page）。
 *
 * ⚠️ 依赖约束: shared 包 dependencies 无 @autional/ui，禁止 import @autional/ui
 * （会引入未声明依赖/循环依赖）。loading 默认值用内联 div 骨架，
 * 样式用 CSS 变量 var(--color-*)，在 .dark 下自动反转（AGENTS.md 设计规范）。
 * ⚠️ useTenantSlugFromUrl 内部相对导入（'../auth/slug-from-url'），
 * 不要从包名 '@autional/shared' 导入自身。
 */

'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTenantSlugFromUrl } from '../auth/slug-from-url';

/** 公开租户信息（public tenants API 返回项） */
export interface PublicTenantInfo {
	name?: string;
	slug?: string;
	id?: string;
}

/** 公开租户名单请求超时（ms）。跨境链路（Vercel edge → 源站）实测新连接丢 ~45%，
 * 失败连接 edge 端要 ~31s 才吐 502；正常成功 ≤2s，8s 留 4x 余量，失败快速交由消费方的重试策略。
 * （rc.35：此前无超时 + catch 吞错 → retry 死码、失败被当"空名单"成功。） */
export const PUBLIC_TENANTS_FETCH_TIMEOUT_MS = 8000;

/**
 * 公开租户列表（无认证端点，用于校验 URL slug 有效性）。
 * 从 end-user-portal App.tsx 原样抽取。
 * - staleTime 5m（plan §5 资源列：public tenants API 有缓存）
 * - 非 2xx / 网络错 / 超时一律上抛（不吞成空数组成功）——
 *   error 态不落缓存，下次调用自然重试
 * - 消费方 fail-open：名单缺失（error 态 data=undefined 或空数组）→ 不拦截
 *   （TenantIndexGuard 渲染 children；TenantRootRedirect 漏斗 brand；
 *   resolveSlugAgainstList 信任传入 slug）
 *
 * ⚠️ 响应契约：tenant-service ListPublicTenants 返回 dto_base.ListResponse
 * （`{code, message, items, total, pagination, timestamp}`，items 才是数组）。
 * 解析顺序：items → data（旧兼容）→ 原始对象，均非数组则返回 []。
 */
export function usePublicTenantSlugs() {
	return useQuery<Array<PublicTenantInfo>>({
		queryKey: ['public-tenants'],
		queryFn: async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), PUBLIC_TENANTS_FETCH_TIMEOUT_MS);
			try {
				const res = await fetch('/bff/tenant/api/v1/tenant/public/tenants', {
					signal: controller.signal,
				});
				if (!res.ok) throw new Error(`public tenants API HTTP ${res.status}`);
				const json = await res.json();
				const list = json?.items ?? json?.data ?? json ?? [];
				return Array.isArray(list) ? list : [];
			} finally {
				clearTimeout(timer);
			}
		},
		staleTime: 5 * 60 * 1000,
		// 重试策略交给消费方 QueryClient 默认（本包不得有 per-query 覆盖）。
	});
}

export interface TenantIndexGuardProps {
	/** 白名单校验通过后渲染的 index 内容（各 portal 的 Dashboard/首页） */
	children?: ReactNode;
	/** 白名单校验失败渲染的 404 页（各 portal 注入自己的 NotFoundPage） */
	notFound?: ReactNode;
	/** loading 占位（缺省渲染内联简单骨架，不依赖 @autional/ui） */
	loading?: ReactNode;
}

/**
 * 默认 loading 占位 — 内联骨架（零依赖）。
 * 不使用 @autional/ui（shared 包无该依赖，避免未声明依赖/循环依赖）；
 * 样式用 CSS 变量 var(--color-*)，在 .dark 下自动反转。
 */
function DefaultLoadingSkeleton() {
	return (
		<>
			<style>{`@keyframes autional-guard-spin { to { transform: rotate(360deg); } }`}</style>
			<div
				role="status"
				aria-live="polite"
				aria-label={typeof document !== 'undefined' && (document.documentElement.lang || '').toLowerCase().startsWith('zh') ? '加载中' : 'Loading'}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					minHeight: '40vh',
					width: '100%',
				}}
			>
				<div
					style={{
						width: '2rem',
						height: '2rem',
						borderRadius: '9999px',
						border: '3px solid var(--color-border-subtle)',
						borderTopColor: 'var(--color-brand)',
						animation: 'autional-guard-spin 0.8s linear infinite',
					}}
				/>
			</div>
		</>
	);
}

/**
 * 租户 slug 白名单守卫（P0-2）：防止未知 slug 被贪婪渲染为租户内容。
 * - URL 首段经 extractSlugFromPath 取为 slug（保留段/已注册业务段返回 undefined，放行）。
 * - slug 命中公开租户列表 → children；未命中 → notFound（/nonexistent-tenant[/...] 均 404）。
 * - 只校验 slug 一段，不看路径深度 —— 子路径合法性（/acme-corp/terms 等）由路由表决定。
 *   2026-10-09 移除「URL 段数 > 1 → notFound」检查：它出自已废弃的动态 basename 方案
 *   （那时 basename 剥掉 slug，内部多段 = 未知路由）；basename 改为 '/' 后它对 index
 *   路由从未生效，却在包裹子路由处误杀 —— auth 站 /:tenantSlug/terms|privacy 曾因此恒 404。
 * - 白名单为空数组时放行（public tenants API 挂掉时退化为不拦截，与 end-user 现状一致）
 */
export function TenantIndexGuard({ children, notFound, loading }: TenantIndexGuardProps) {
	const { data: tenants, isLoading } = usePublicTenantSlugs();
	const slug = useTenantSlugFromUrl();

	if (isLoading && !tenants) return <>{loading ?? <DefaultLoadingSkeleton />}</>;

	if (slug && tenants && tenants.length > 0 && !tenants.some((t) => (t.name || t.slug) === slug)) {
		return <>{notFound}</>;
	}

	return <>{children}</>;
}
