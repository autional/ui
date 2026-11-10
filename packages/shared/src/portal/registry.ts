/**
 * 门户注册表 —— **门户元数据的单一真源**。
 *
 * 过去「门户清单」被写了十几次（`PORTAL_DEFAULTS` / `SLUG_PORTALS` /
 * `getAppPortalSlugs()` / 重定向白名单 / `isPortalVisible` 的角色集 /
 * `DEFAULT_EXCLUDE` / `PORTAL_KEY_MAP`，以及 6 个站点各持一份 `CONSOLE_PORTALS`）。
 * 每加一个门户要改 7 个仓，且靠"进名单"才可见（小圈子）。
 *
 * 现在只有这张表。其余全部由它派生：
 *
 *   表字段            →  派生
 *   host / base       →  config.PORTAL_DEFAULTS、getPortalUrl()
 *   slugScoped        →  config.SLUG_PORTALS（入口是否拼 /<tenantSlug>）
 *   routerSlug        →  config.getAppPortalSlugs()（/<tenant>/<portal> 路由 basename）
 *   legacyEnvKey      →  config.PORTAL_KEY_MAP（旧 env.js VITE_*_URL）
 *   —                 →  getAllowedRedirectOrigins()（redirect 白名单 = 全部 code）
 *   audience          →  hooks.isPortalVisible()（谁能看见：入口门禁的镜像）
 *   inSwitcher        →  usePortalCatalog DEFAULT_EXCLUDE（默认排除 = !inSwitcher）
 *   family='console'  →  getConsolePortalCodes()（控制台切换器全集，替代各站白名单）
 *
 * 新增门户 = 在这里加一行（若后端目录已透出 host/base，则连这一行都可省）。
 * **禁止**在其它文件再写门户 code 字面量数组/Set。
 */

/** 可见性受众 = 登录入口门禁的镜像（谁能登录，谁才看见）。 */
export type PortalAudience = 'public' | 'admin' | 'platform';

/**
 * 门户族群：
 * - `console`：管理面/用户面控制台（互相出现在切换器里）
 * - `content`：内容站（developer / status / trust / brand / docs …）
 * - `app`：App 形态（authenticator：TOTP/push，不列入桌面切换器）
 * - `auth` / `landing`：认证与落地站，非切换目标
 */
export type PortalFamily = 'console' | 'content' | 'app' | 'auth' | 'landing';

export interface PortalDefinition {
	/** 门户 code（后端 applications.code，全环境同值） */
	code: string;
	/** 子域前缀；空串 = 落在根域（landing） */
	host: string;
	/** 子域下的固定路径前缀（env 可覆盖，如 admin 的 '/admin'） */
	base: string;
	/** 入口是否拼租户段 `/<slug>`（拼错会命中不存在的路由 ⇒ 空白/404） */
	slugScoped: boolean;
	/** 是否参与 `/<tenant>/<portal>` 路由 basename 解析 */
	routerSlug: boolean;
	/**
	 * `getAppPortalSlugs()` 的返回顺序（历史上是 `admin, developer, security, platform, status, trust`）。
	 * 该数组是导出 API，顺序可观测 ⇒ 用显式序号保序，而不是依赖表顺序。
	 */
	routerOrder?: number;
	family: PortalFamily;
	audience: PortalAudience;
	/** 默认进入 `usePortalCatalog` 的门户清单（false ⇒ 进 DEFAULT_EXCLUDE） */
	inSwitcher: boolean;
	/** 旧 env.js 直连 URL 键（VITE_*_URL）→ 向后兼容映射用 */
	legacyEnvKey?: string;
	/** 备注（为什么这个门户这样配置） */
	note?: string;
}

/** 管理面平面角色集（admin / security / config / secret 的门户 = 登录入口门禁同集）。 */
export const ADMIN_PLANE_ROLES: readonly string[] = [
	'super_admin',
	'admin',
	'security_admin',
	'user_manager',
];

/**
 * 注册表本体（顺序 = 重定向白名单推导顺序）。
 *
 * 前 13 项与迁移前 `PORTAL_DEFAULTS` 逐项等价（见 `__tests__/registry.test.ts` 的 oracle 断言）；
 * 后 4 项（docs / wiki / reference / consent）是此前**漏登记**的内容站 —— 之前 `getPortalUrl('docs')`
 * 会退化成 `${origin}/docs`，任何控制台都链不到文档中心。这里补齐，属新增能力，不改变前 13 项行为。
 */
export const PORTALS: readonly PortalDefinition[] = [
	{
		code: 'auth',
		host: 'auth',
		base: '',
		slugScoped: true,
		routerSlug: false,
		family: 'auth',
		audience: 'public',
		inSwitcher: false,
		legacyEnvKey: 'VITE_AUTH_PAGES_URL',
		note: '认证门户：授权码 + PKCE 入口',
	},
	{
		code: 'admin',
		host: 'admin',
		base: '',
		slugScoped: true,
		routerSlug: true,
		routerOrder: 1,
		family: 'console',
		audience: 'admin',
		inSwitcher: true,
		legacyEnvKey: 'VITE_ADMIN_CONSOLE_URL',
		note: '管理控制台；env 可覆盖为 app.<root>/admin',
	},
	{
		code: 'developer',
		host: 'developer',
		base: '',
		slugScoped: false,
		routerSlug: true,
		routerOrder: 2,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		legacyEnvKey: 'VITE_DEVELOPER_PORTAL_URL',
	},
	{
		code: 'user',
		host: 'user',
		base: '',
		slugScoped: true,
		routerSlug: false,
		family: 'console',
		audience: 'public',
		inSwitcher: true,
		legacyEnvKey: 'VITE_END_USER_PORTAL_URL',
		note: '用户门户：全角色可见（非管理面）',
	},
	{
		code: 'security',
		host: 'security',
		base: '',
		slugScoped: true,
		routerSlug: true,
		routerOrder: 3,
		family: 'console',
		audience: 'admin',
		inSwitcher: true,
		legacyEnvKey: 'VITE_SECURITY_DASHBOARD_URL',
	},
	{
		code: 'status',
		host: 'status',
		base: '',
		slugScoped: false,
		routerSlug: true,
		routerOrder: 5,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		legacyEnvKey: 'VITE_STATUS_PAGE_URL',
	},
	{
		code: 'landing',
		host: '',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'landing',
		audience: 'public',
		inSwitcher: false,
		legacyEnvKey: 'VITE_LANDING_SITE_URL',
		note: '落根域（无子域前缀）',
	},
	{
		code: 'authenticator',
		host: 'authenticator',
		base: '',
		slugScoped: true,
		routerSlug: false,
		family: 'app',
		audience: 'public',
		inSwitcher: false,
		legacyEnvKey: 'VITE_AUTHENTICATOR_APP_URL',
		note: 'App 形态（TOTP/push），不做桌面门户切换目标',
	},
	{
		code: 'trust',
		host: 'trust',
		base: '',
		slugScoped: false,
		routerSlug: true,
		routerOrder: 6,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		legacyEnvKey: 'VITE_TRUST_CENTER_URL',
	},
	{
		code: 'platform',
		host: 'platform',
		base: '',
		slugScoped: true,
		routerSlug: true,
		routerOrder: 4,
		family: 'console',
		audience: 'platform',
		inSwitcher: true,
		legacyEnvKey: 'VITE_PLATFORM_CONSOLE_URL',
		note: '仅平台租户成员；租户段挂载（OAuth client 按 slug 解析）',
	},
	{
		code: 'brand',
		host: 'brand',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		note: '选品牌落地站；无旧 env 键',
	},
	{
		code: 'secret',
		host: 'secret',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'console',
		audience: 'admin',
		inSwitcher: true,
	},
	{
		code: 'config',
		host: 'config',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'console',
		audience: 'admin',
		inSwitcher: true,
	},
	{
		code: 'docs',
		host: 'docs',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		note: '此前未登记（getPortalUrl 退化成 <origin>/docs）',
	},
	{
		code: 'wiki',
		host: 'wiki',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		note: '此前未登记',
	},
	{
		code: 'reference',
		host: 'reference',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		note: '此前未登记',
	},
	{
		code: 'consent',
		host: 'consent',
		base: '',
		slugScoped: false,
		routerSlug: false,
		family: 'content',
		audience: 'public',
		inSwitcher: true,
		note: '此前未登记',
	},
];

const BY_CODE: ReadonlyMap<string, PortalDefinition> = new Map(
	PORTALS.map((p) => [p.code, p] as const),
);

/** 全部门户 code（顺序同表）。 */
export const PORTAL_CODES: readonly string[] = PORTALS.map((p) => p.code);

/** 取门户定义；未登记返回 undefined（调用方按旧口径兜底）。 */
export function getPortalDefinition(code: string): PortalDefinition | undefined {
	return BY_CODE.get(code);
}

/** 入口是否拼租户段 `/<slug>`。 */
export function isSlugScopedPortal(code: string): boolean {
	return BY_CODE.get(code)?.slugScoped === true;
}

/** 是否控制台族（控制台切换器的候选集）。 */
export function isConsolePortal(code: string): boolean {
	return BY_CODE.get(code)?.family === 'console';
}

/** 控制台族 code 清单（替代各站 `CONSOLE_PORTALS` 字面量）。 */
export function getConsolePortalCodes(): string[] {
	return PORTALS.filter((p) => p.family === 'console').map((p) => p.code);
}

/** 默认进入切换器清单的 code（`usePortalCatalog` 不传 exclude 时的基线）。 */
export function getSwitcherIncludedCodes(): string[] {
	return PORTALS.filter((p) => p.inSwitcher).map((p) => p.code);
}

/** 默认不进切换器清单的 code（`usePortalCatalog` 的 DEFAULT_EXCLUDE）。 */
export function getSwitcherExcludedCodes(): string[] {
	return PORTALS.filter((p) => !p.inSwitcher).map((p) => p.code);
}

/** 参与 `/<tenant>/<portal>` 路由 basename 解析的 code（按历史顺序 routerOrder 升序）。 */
export function getRouterPortalCodes(): string[] {
	return PORTALS.filter((p) => p.routerSlug)
		.slice()
		.sort((a, b) => (a.routerOrder ?? Number.MAX_SAFE_INTEGER) - (b.routerOrder ?? Number.MAX_SAFE_INTEGER))
		.map((p) => p.code);
}

/** 旧 env.js 直连 URL 键（VITE_*_URL）→ code 的反向映射源。 */
export function getLegacyEnvKey(code: string): string | undefined {
	return BY_CODE.get(code)?.legacyEnvKey;
}

/** 门户可见性（入口门禁镜像）：未登记的门户默认放行（叠加原则，不误伤）。 */
export function isPortalVisibleForAudience(
	code: string,
	ctx: { role: string | null; isPlatformMember: boolean },
): boolean {
	const audience = BY_CODE.get(code)?.audience ?? 'public';
	if (audience === 'platform') return ctx.isPlatformMember;
	if (audience === 'admin') return ctx.role !== null && ADMIN_PLANE_ROLES.includes(ctx.role);
	return true;
}
