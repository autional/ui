/**
 * 统一的登出 Hook
 * 所有 portal 必须使用此 hook 处理登出，确保清理逻辑一致
 * 委托给 AuthService.logout() 统一实现
 */

import { useCallback } from 'react';
import { buildLogoutUrl } from '../auth/roles';
import { traceRedirect } from '../auth/auth-trace';

/**
 * 统一的登出 Hook
 * 委托 AuthService.logout() 执行清理（清除内存状态、localStorage、cookie、token 吊销），
 * 然后跳转到登录页。
 *
 * 落点口径（AUTH-40）：回程可用 `returnUrl` 显式覆盖——供当前 URL 无租户段、
 * 调用方另持租户上下文的场景（auth 域裸 `/logout` 用登录期锚定标记补回）；
 * 缺省用捕获的当前 URL。EntryRouter 据回程解析租户 → `/<slug>/login`，否则 brand。
 */
export function useLogout(opts?: { returnUrl?: string }) {
	const returnUrl = opts?.returnUrl;
	return useCallback(() => {
		const performLogout = async () => {
			// 在 clearAuth/跳转前捕获当前 URL，避免时序竞争：
			// AuthService.logout() 的 clearAuth 会触发 store 变化，
			// 页面可能因此先导航到 '/'，导致后续读到的 window.location.href 丢失租户 slug
			const currentUrl =
				returnUrl || (typeof window !== 'undefined' ? window.location.href : '');

			// AuthService.logout() 统一处理：clearAuth + LS 清理 + cookie 清理 + token 吊销
			const { AuthService } = await import('../auth/service');
			await AuthService.logout();

			// buildLogoutUrl（LS-08）：client_id 可得 → 同源标准端点整页导航（服务端无会话
			// 浏览器支 302 确认页承接，确认后回跳门户根）；不可得 → legacy auth 裸根 + `logout=1`
			// 意图标记（入口路由据此先终结会话再定落点：能解析出租户 → 裸 /<slug>/login；
			// 否则 brand 裸根）。两者都不会把带会话的回程当普通深链直送登录页（会静默重登）。
			// funnel：用户主动行为，静默直跳（assign 保持原 href 历史语义）；仅记 trace。
			traceRedirect(buildLogoutUrl(currentUrl), { reason: 'logout', assign: true });
		};
		performLogout();
	}, [returnUrl]);
}
