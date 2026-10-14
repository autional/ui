// API
export { apiClient, createApiClient } from './api/client';
export {
	setTraceParentProvider,
	getTraceParentHeader,
	resetSessionTraceId,
	enableOtelBridge,
} from './api/trace';
export { bffLogin, bffRefresh, bffLogout, isBFFAvailable } from './api/bff-client';

// Auth
export {
	useAuthStore,
	getAccessToken,
	getRefreshToken,
	getCurrentTenantId,
	getCurrentRole,
	loginWithTokens,
	logout,
	isTokenExpired,
	refreshAccessToken,
} from './auth/store';
export { AuthService } from './auth/service';
export { generatePKCE, generateCodeChallenge } from './auth/pkce';
export type { PKCEPair } from './auth/pkce';
export {
	initiateOAuthLogin,
	handleOAuthCallback,
	isOAuthEnabled,
	OAuthCallbackError,
} from './auth/oauth-login';
export { decodeJwtPayload } from './auth/jwt-payload';
export { buildLoginUrl } from './auth/roles';
export { traceRedirect, traceEvent, traceDump } from './auth/auth-trace';
export type { AuthTraceEntry, AuthTraceRedirectOptions } from './auth/auth-trace';

// Types
export type {
	User,
	LoginRequest,
	LoginResponse,
	RegisterRequest,
	Tenant,
	TenantMember,
	Role,
	Permission,
	Application,
	AuditLog,
	Session,
	Department,
	ListResponse,
	PageRequest,
	ApiError,
	ApiResponse,
} from './types';

// Hooks
export {
	useAuth,
	useAuthActions,
	useIsAuthenticated,
	useUser,
	useUserId,
	useAccessToken,
	useAuthPermissions,
	useCurrentTenantId,
	useTenants,
} from './hooks/useAuth';
export { useCurrentTenantIdOr } from './hooks/useCurrentTenantIdOr';
export type { AuthSnapshot, AuthActions } from './hooks/useAuth';
export { usePermission } from './hooks/usePermission';
export type { PermissionResult } from './hooks/usePermission';
export { useLogout } from './hooks/useLogout';
export { useBootstrap } from './hooks/useBootstrap';
export type { BootstrapState } from './hooks/useBootstrap';
export { useSodMode, useIsAuditRestricted } from './hooks/useSodMode';
export type { SodMode } from './hooks/useSodMode';
export { useCurrentRole } from './hooks/useCurrentRole';
export {
	usePortalCatalog,
	isPortalVisible,
	PLATFORM_TENANT_ID,
	ADMIN_PLANE_ROLES,
} from './hooks/usePortalCatalog';
export type {
	PortalCatalogEntry,
	PortalCatalogAudience,
	UsePortalCatalogOptions,
	UsePortalCatalogResult,
} from './hooks/usePortalCatalog';

// Constants
export { API as API_PATHS } from './constants/api-paths';

// Config
export {
	// U351：AUTH_PAGES_URL 别名导出已移除（字符串模板误用会静默产出函数源码）；
	// 消费方一律 `getAUTH_PAGES_URL()`（其余别名族 93 行起保留，登记为同族潜伏面）。
	getAUTH_PAGES_URL,
	getADMIN_CONSOLE_URL as ADMIN_CONSOLE_URL,
	getADMIN_CONSOLE_URL,
	getDEVELOPER_PORTAL_URL as DEVELOPER_PORTAL_URL,
	getDEVELOPER_PORTAL_URL,
	getEND_USER_PORTAL_URL as END_USER_PORTAL_URL,
	getEND_USER_PORTAL_URL,
	getSECURITY_DASHBOARD_URL as SECURITY_DASHBOARD_URL,
	getSECURITY_DASHBOARD_URL,
	getSTATUS_PAGE_URL as STATUS_PAGE_URL,
	getSTATUS_PAGE_URL,
	getLANDING_SITE_URL as LANDING_SITE_URL,
	getLANDING_SITE_URL,
	getAUTHENTICATOR_APP_URL as AUTHENTICATOR_APP_URL,
	getAUTHENTICATOR_APP_URL,
	getTRUST_CENTER_URL as TRUST_CENTER_URL,
	getTRUST_CENTER_URL,
	getPLATFORM_CONSOLE_URL as PLATFORM_CONSOLE_URL,
	getPLATFORM_CONSOLE_URL,
	API_BASE_URL,
	BASE_PATH,
	ROUTER_BASENAME,
	getRouterBasename,
	VITE_BASE,
	appPath,
	navigateTo,
	crossAppUrl,
	isValidRedirect,
	// Portal URL resolver (VITE_PORTAL_CONFIG driven)
	getRootDomain,
	getPortalUrl,
	getAppPortalSlugs,
} from './config';
export {
	SITE_DOMAIN,
	SITE_EMAIL,
	SITE_BASE_URL,
	AUTH_DOMAIN,
	USER_DOMAIN,
	APP_DOMAIN,
	AUTHENTICATOR_DOMAIN,
	AUTH_BASE_URL,
	USER_BASE_URL,
	APP_BASE_URL,
	AUTHENTICATOR_BASE_URL,
	DEFAULT_OG_IMAGE,
	DEFAULT_LOGO,
} from './config/constants';

// SEO
export * from './seo';

// Components
export { RequireAuth } from './components/RequireAuth';
export { TenantRootRedirect } from './components/TenantRootRedirect';
export { OAuthCallbackPage } from './components/OAuthCallbackPage';
export { TenantSlugProvider, useTenantSlug } from './auth/tenant-slug-context';
export { useTenantSlugFromUrl, extractSlugFromPath, registerNonTenantSegments, clearNonTenantSegments } from './auth/slug-from-url';
export { useOAuthClientIdFromUrl, fetchOAuthClientIdBySlug } from './auth/oauth-client-from-slug';
export {
	useTenantRoute,
	resolveEffectiveClientId,
	isSameDomainOAuth,
} from './auth/tenant-route-middleware';
export {
	usePermissionsQuery,
	useTenantsQuery,
	useMeQuery,
	AUTH_DATA_STALE_TIME,
} from './auth/auth-queries';
export { authQueryKeys } from './auth/auth-queries';
export type { TenantRouteResult } from './auth/tenant-route-middleware';
export {
	AdminGuard,
	UserMgmtGuard,
	SecurityGuard,
	SecurityAdminGuard,
	AuditorGuard,
	PlatformGuard,
	AuthGuard,
} from './components/PortalGuard';
export { AuditStatsOnly } from './components/AuditStatsOnly';
export { TenantIndexGuard, usePublicTenantSlugs } from './components/TenantIndexGuard';
export type { TenantIndexGuardProps } from './components/TenantIndexGuard';
export { buildTenantUrls } from './auth/build-tenant-urls';
export { resolvePortalBasename } from './config/resolve-basename';

// 生成代码的命名空间再导出（GeneratedApi / ApiGenerated / GeneratedTypes / ApiTypes）。
// 说明：这 4 行原先指向 @autional/api-generated —— 那是各站逐站副本里用
// file:../../scripts/generate/api-generated-package 提供的本地包，一旦 shared 走 npm 发布
// 就必然解析不到（authenticator / security 的 tsc 就是这么炸的：TS2305 has no exported member）。
// 本包内的 src/generated/* 是同一份生成结果，因此改指包内相对路径；
// 消费方实际用到的类型面由逐站 tsc 验证。
export * as GeneratedApi from './generated/api';
export * as GeneratedTypes from './generated/types';
export * as ApiGenerated from './generated/api';
export * as ApiTypes from './generated/types';

// Branding（租户品牌 → CSS 变量 / favicon / customCss）
export {
	useBranding,
	applyBrandColors,
	BrandingInitializer,
	useTenantBrandingStore,
	extractBranding,
	readCachedBranding,
	writeCachedBranding,
	BRANDING_CACHE_PREFIX,
} from './branding';
export type { Branding } from './branding';

// Lib
export { getVapidPublicKey, subscribeBrowserPush, unsubscribeBrowserPush } from './lib/push';

// Utils
export { urlBase64ToUint8Array } from './utils/browser';
export { camelCaseKeys, snakeCaseKeys } from './utils/case';
// 分页/形状单点（H008 收敛口径）：新页面一律经 toPageParams / fromPageResult 适配
export { toPageParams, fromPageResult } from './utils/page';
export type { PageParams, PageResult } from './utils/page';
export { extractApiErrorMessage, extractApiError, createHandleApiError } from './utils/error';
// 查询状态分类单点（RC-B4-01 / ADR-B4-01）：error/空/无权判定的唯一语义源
export {
	classifyQueryState,
	getHttpStatus,
	isForbiddenError,
	isRetryableError,
	isEmptyData,
} from './utils/query-state';
export type { QueryState, QueryStateInput } from './utils/query-state';
export {
	extractList,
	extractItem,
	extractPagination,
	extractListResult,
	fetchList,
	fetchItem,
	fetchListResult,
} from './utils/response';
export { formatTime, formatDate, formatRelativeTime, setLocaleGetter } from './utils/format';
export { normalizeViteBase } from './utils/vite';
export {
	processPasswordForTransmission,
	hashPasswordForTransmission,
} from './utils/password-transmission';
export type { TransmissionResult } from './utils/password-transmission';
export type { ExtractedApiError } from './utils/error';
export type { PaginationInfo, ListResult } from './utils/response';
// force rebuild 1781616516

export {
	EMPTY_STATE_CODES,
	ERROR_SEMANTICS,
	ERROR_SEMANTICS_META,
	MAX_RETRIES,
	UNPROVISIONED_CODES,
	errorCodeOf,
	isEmptyStateError,
	isNotFoundError,
	isRetryableErrorContractFirst,
	isUnprovisionedError,
	semanticsOfCode,
	semanticsOfError,
	shouldRetry,
} from './utils/error-semantics';
export type { Absence, ErrorClass, ErrorSemantics, UIObservation } from './utils/error-semantics';
