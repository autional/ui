/**
 * 控制台认证公共层（配置中心 / 密钥中心共用）。
 *
 * - `claims`：JWT 声明 → 会话用户 / 过期时刻的纯映射；
 * - `createConsoleAuth`：完整 OIDC PKCE 流程（登录 / 换票 / 续期 / 登出），
 *   「令牌存哪」是唯一策略参数，其余行为统一。
 */
export {
	expiresAtFromToken,
	mergeTokenClaims,
	pickClaimRoles,
	pickClaimString,
	sessionExpiryAt,
	userFromClaims,
	type ConsoleSessionUser,
} from './claims';
export {
	createConsoleAuth,
	decodeJwtPayload,
	type ConsoleAuth,
	type ConsoleAuthOptions,
	type ConsoleSession,
} from './create-console-auth';
