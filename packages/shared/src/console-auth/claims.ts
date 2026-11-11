/**
 * 控制台会话的声明映射（JWT claims → 会话用户 / 过期时刻）。
 *
 * 为什么放在 shared：
 *   配置中心与密钥中心的 `lib/auth.ts` 曾各自维护一份**逐字相同**的实现
 *   （`pickString` / `pickRoles` / `userFromClaims` / `expiresAtFromToken`）。
 *   同一决策写两遍必然漂移——本项目已经出现过「一处改了 name 回落、另一处没改」
 *   导致顶栏显示不一致的先例。这里收敛成唯一真源。
 *
 * 边界：本模块**只做纯映射**，不含流程（登录/续期/登出仍在各站，因为两站的
 * 存储位置、吊销策略、瞬时故障处置各不相同，强行合并会把事故修复揉成开关）。
 */
import { decodeJwtPayload } from '../auth/jwt-payload';

/** 控制台会话里的用户形状（各站以此结构扩展或直接引用）。 */
export interface ConsoleSessionUser {
	/** JWT sub / OIDC subject */
	sub: string;
	/** 展示名（name / preferred_username / nickname / email 依次回落，最后用 sub 尾段或调用方兜底） */
	name: string;
	email: string;
	/** 令牌内租户；空 = 需要站点的 VITE_TENANT_ID 或由后端拒绝 */
	tenantId: string;
	/** 令牌内应用；空 = 平台应用 */
	appId: string;
	roles: string[];
}

/** 取第一个非空字符串声明（去首尾空白）。 */
export function pickClaimString(source: Record<string, unknown> | null, ...keys: string[]): string {
	if (!source) return '';
	for (const key of keys) {
		const value = source[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	return '';
}

/**
 * 取角色声明：兼容数组（`roles: ['a','b']`）与字符串（`role: 'a b'` / `'a,b'`）。
 * 三种键名都认（roles / role / authorities），因为不同签发方口径不同。
 */
export function pickClaimRoles(source: Record<string, unknown> | null): string[] {
	if (!source) return [];
	for (const key of ['roles', 'role', 'authorities']) {
		const value = source[key];
		if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
		if (typeof value === 'string' && value !== '') return value.split(/[,\s]+/).filter(Boolean);
	}
	return [];
}

/**
 * 从声明构造会话用户。
 *
 * 展示名回落顺序：name → preferred_username → nickname → email → `…<sub 尾 6 位>` → fallbackName。
 * 之所以保留 `…尾段` 而不是直接用兜底文案：兜底文案（如「已登录用户」）会在顶栏
 * 拼成「已 已登录用户」这种既重复又不提供身份的文案。
 */
export function userFromClaims(
	claims: Record<string, unknown> | null,
	fallbackName: string,
): ConsoleSessionUser {
	const sub = pickClaimString(claims, 'sub', 'user_id', 'userId');
	const name =
		pickClaimString(claims, 'name', 'preferred_username', 'nickname', 'email') ||
		(sub ? `…${sub.slice(-6)}` : fallbackName);
	return {
		sub,
		name,
		email: pickClaimString(claims, 'email'),
		tenantId: pickClaimString(claims, 'tenant_id', 'tenantId', 'tenant'),
		appId: pickClaimString(claims, 'app_id', 'appId', 'application_id'),
		roles: pickClaimRoles(claims),
	};
}

/**
 * 过期时刻（epoch ms）。
 *
 * 优先级：access_token 的 `exp`（服务端真实 TTL，权威） → `expires_in` → 兜底值。
 * 用 `exp` 而不是只信 `expires_in`：`expires_in` 是相对秒数，落到本地时钟后
 * 一旦设备时钟偏移就会提前/滞后掉登录。
 *
 * @param fallbackMs `exp` 与 `expires_in` 都缺时的兜底有效期；各站不同（配置中心 5 分钟、密钥中心 30 分钟）。
 */
export function expiresAtFromToken(
	accessToken: string,
	expiresIn?: number,
	fallbackMs: number = 5 * 60_000,
): number {
	const claims = accessToken ? decodeJwtPayload(accessToken) : null;
	const exp = claims && typeof claims.exp === 'number' ? claims.exp : 0;
	if (exp > 0) return exp * 1000;
	const sec = Number(expiresIn);
	if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
	return Date.now() + fallbackMs;
}

/**
 * 会话的真实过期时刻：优先 JWT `exp`，回落到会话里记录的 `expiresAt`。
 *
 * 用于兼容「旧存储按 expires_in 估算、与真实 exp 有偏差」的会话，
 * 避免续期判断卡在错误的时间点上。
 */
export function sessionExpiryAt(accessToken: string, recordedExpiresAt: number): number {
	const claims = accessToken ? decodeJwtPayload(accessToken) : null;
	const exp = claims && typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
	return exp > 0 ? exp : recordedExpiresAt;
}
