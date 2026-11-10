'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAccessToken, useAuthStore } from '../auth/store';
import { apiClient } from '../api/client';
import { getPortalUrl } from '../config';
import {
	ADMIN_PLANE_ROLES as ADMIN_PLANE_ROLES_REGISTRY,
	getSwitcherExcludedCodes,
	isPortalVisibleForAudience,
} from '../portal/registry';
import { useCurrentRole } from './useCurrentRole';

/** 平台租户 well-known ULID（service-core base/constant TenantPlatformID，全环境同值） */
export const PLATFORM_TENANT_ID = '01KSQCBNVMS6SX64PJS937CE33';

/**
 * 管理面平面角色集（admin/security/config/secret 门户）——与登录入口门禁同集：
 * member/guest 登录被拒 40000503。定义在注册表（单一真源），此处保留导出以兼容既有 import。
 */
export const ADMIN_PLANE_ROLES: readonly string[] = ADMIN_PLANE_ROLES_REGISTRY;

/**
 * 门户可见性 = 入口门禁的镜像（谁能登录谁才看见）：
 * - `audience: 'platform'`：仅平台租户成员
 * - `audience: 'admin'`：仅管理面角色（admin / security / config / secret …）
 * - 其余（含未登记 code）：不限制（叠加原则，未知门户不误伤）
 *
 * 判定数据源 = 注册表 `audience`；本函数不再持有门户 code 字面量。
 */
export function isPortalVisible(
	code: string,
	ctx: { role: string | null; isPlatformMember: boolean },
): boolean {
	return isPortalVisibleForAudience(code, ctx);
}

/** 平台门户目录项（映射自 tenant-service 应用列表响应，is_platform=true） */
export interface PortalCatalogEntry {
	code: string;
	name: string;
	description?: string;
	/** getPortalUrl 按 code 拼装（slug 白名单门户带租户段，域根门户落根 URL） */
	url: string;
	order: number;
}

/**
 * 数据面端点平面（网关路由隔离矩阵 §3.3）：
 * - `self`：user 受众自视图端点 `/tenants/{id}/applications`（entry_plane=api；auth/user 门户）
 * - `admin`：管理面双入口端点 `/admin/tenants/{id}/applications`（audiences [admin, platform]；
 *   admin/security/platform 控制台共用。api 平面在该路由上 403，反之亦然）
 */
export type PortalCatalogAudience = 'self' | 'admin';

export interface UsePortalCatalogOptions {
	tenantId?: string | null;
	/** 拼门户 URL 的第二参 slug（非 slug 白名单门户自动忽略，见 config.getPortalUrl） */
	slug?: string | null;
	/**
	 * 可见性/角色判定用（缺省回退 store 当前角色 useCurrentRole）。
	 * 显式 null = 按“无角色”过滤（管理面门户与 allowed_roles 门槛均不可见）。
	 */
	role?: string | null;
	audience?: PortalCatalogAudience;
	enabled?: boolean;
	exclude?: readonly string[];
}

export interface UsePortalCatalogResult {
	/** exclude + 可见性（入口门禁镜像）+ allowed_roles → order 升序（门户切换器 / 磁贴网格用） */
	portals: PortalCatalogEntry[];
	/** 同一可见集合、保持服务端顺序（偏好配置面板用） */
	allPortals: PortalCatalogEntry[];
	isLoading: boolean;
	isError: boolean;
	refetch: () => void;
}

// 「切换门户」清单默认排除 = 注册表 `inSwitcher === false` 的门户
// （auth/landing 非切换目标；authenticator 为移动 App 形态 TOTP/push，不列入桌面清单）。
// 派生结果与迁移前字面量逐项等价（oracle 测试锁定）。
const DEFAULT_EXCLUDE: readonly string[] = getSwitcherExcludedCodes();
const PORTAL_CATALOG_STALE_TIME = 60_000;

interface RawPortalApplication {
	code: string;
	name: string;
	description?: string;
	order?: number;
	/** allowedRoles 为 apiClient camelCase 归一后的键（snake 形态兼容后端透出前的原始键） */
	config?: {
		portal?: { allowedRoles?: readonly string[]; allowed_roles?: readonly string[] };
	} | null;
}

function toEntry(app: RawPortalApplication, slug?: string): PortalCatalogEntry {
	return {
		code: app.code,
		name: app.name,
		description: app.description,
		url: getPortalUrl(app.code, slug),
		order: app.order ?? 0,
	};
}

/**
 * 平台门户目录（应用清单，is_platform=true 全租户同集）。
 * 消费侧按所在控制台平面传 audience；403/网络失败 → isError（不静默吞），
 * 调用方可据此降级（隐藏切换器或静态兜底）。401 由 apiClient 拦截器预刷新 + 重试自愈。
 */
export function usePortalCatalog(options: UsePortalCatalogOptions = {}): UsePortalCatalogResult {
	const {
		tenantId,
		slug,
		role: roleProp,
		audience = 'self',
		enabled = true,
		exclude = DEFAULT_EXCLUDE,
	} = options;
	const token = getAccessToken();
	const currentRole = useCurrentRole();
	const role = roleProp !== undefined ? roleProp : currentRole;
	const isPlatformMember = useAuthStore((s) =>
		s.tenants.some((t) => t.id === PLATFORM_TENANT_ID),
	);

	const query = useQuery({
		// slug 只影响 URL 拼装（memo 层），不进 key：同一份目录不随 slug 重复拉取
		queryKey: ['portal-catalog', audience, tenantId],
		staleTime: PORTAL_CATALOG_STALE_TIME,
		retry: false,
		enabled: enabled && !!tenantId && !!token,
		queryFn: async (): Promise<RawPortalApplication[]> => {
			// 走 apiClient：请求前预刷新 + 401→刷新→重试 + X-Tenant-ID 注入（裸 fetch 无此链路）
			const apiPrefix = audience === 'admin' ? '/tenant/api/v1/admin' : '/tenant/api/v1';
			const res = await apiClient.get(`${apiPrefix}/tenants/${tenantId}/applications`, {
				params: { type: 'portal', is_platform: 'true', status: 'active' },
			});
			// 响应拦截器已 unwrap {code,data}/{code,items} 并做 camelCase；此处只做形状容错
			const body: unknown = res.data;
			if (Array.isArray(body)) return body as RawPortalApplication[];
			if (body && typeof body === 'object') {
				const shaped = body as {
					items?: unknown;
					data?: unknown;
					code?: number;
					message?: string;
				};
				if (Array.isArray(shaped.items)) return shaped.items as RawPortalApplication[];
				if (Array.isArray(shaped.data)) return shaped.data as RawPortalApplication[];
				if (typeof shaped.code === 'number' && shaped.code !== 0) {
					throw new Error(shaped.message || `portal catalog request failed (code ${shaped.code})`);
				}
			}
			return [];
		},
	});

	// exclude 过滤后保持服务端顺序
	const excludedPortals = useMemo(() => {
		const excluded = new Set(exclude);
		return (query.data ?? []).filter((app) => !excluded.has(app.code));
	}, [query.data, exclude]);

	// 可见性（入口门禁镜像）+ allowed_roles 叠加
	// （allowed_roles 数据通路后端尚未透出——tenant-service 列表 DTO 无 config 字段；
	//   存在时叠加生效，见 usePortalCatalog 审计记录）
	const visiblePortals = useMemo(
		() =>
			excludedPortals.filter((app) => {
				if (!isPortalVisible(app.code, { role, isPlatformMember })) return false;
				const allowedRoles =
					app.config?.portal?.allowedRoles ?? app.config?.portal?.allowed_roles;
				return !allowedRoles || allowedRoles.includes(role ?? '');
			}),
		[excludedPortals, role, isPlatformMember],
	);

	const allPortals = useMemo(
		() => visiblePortals.map((app) => toEntry(app, slug || undefined)),
		[visiblePortals, slug],
	);

	const portals = useMemo(
		() =>
			visiblePortals
				.map((app) => toEntry(app, slug || undefined))
				.sort((a, b) => a.order - b.order),
		[visiblePortals, slug],
	);

	return {
		portals,
		allPortals,
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: query.refetch,
	};
}
