/**
 * Autional 统一 API Client
 * - 所有前端应用共用同一个 axios 实例
 * - 自动注入 Bearer token + X-Tenant-ID
 * - 自动 unwrap 后端响应 + PascalCase→camelCase 转换
 * - 自动 token refresh + 401 处理
 */

import axios, { AxiosError } from 'axios';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { camelCaseKeys, snakeCaseKeys } from '../utils/case';
import { API_NAMESPACE, getApiBaseUrl } from '../config';
import { getTraceParentHeader } from './trace';
import { ENTRY_PLANE_HEADER, resolveEntryPlane } from './entry-plane';
import { NAMESPACE_HEADER, needsNamespaceHeader } from './namespace';
import { AuthService } from '../auth/service';

function setupInterceptors(instance: AxiosInstance) {
	// ============ Request Interceptor ============
	instance.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
		// 预判式 Token 刷新：如果 Token 已过期或即将过期（60s 缓冲），先刷新再发请求
		// U352：刷新成功只替换本次 bearer —— 不得提前 return，否则跳过后方全部注入
		// （X-Tenant-ID / namespace / body·params snakeCase / entry-plane / traceparent）。
		const token = AuthService.getAccessToken();
		let bearer = token;
		if (token && AuthService.isTokenExpired(token)) {
			try {
				const newToken = await AuthService.refreshToken();
				if (newToken) bearer = newToken;
			} catch (e) {
				console.warn('[API] token pre-refresh failed', (e as Error)?.message || '');
			}
		}
		if (bearer) {
			config.headers.Authorization = `Bearer ${bearer}`;
		}

		// 无 token 的公开认证入口（登录/OAuth/QR/恢复）以地址栏租户为唯一权威：
		// 此时 localStorage 里的 currentTenantId 可能是上次会话残留，注入会覆盖显式租户。
		// 有 token 才注入（内部调用链沿用它）；调用方显式设置的 X-Tenant-ID 不受影响。
		const tenantId = AuthService.getCurrentTenantId();
		if (bearer && tenantId) {
			config.headers['X-Tenant-ID'] = tenantId;
		}

		// secret 管理面（§13-A P1-B）：admin 组端点 fail-closed 要求 X-Namespace ∈ S
		if (needsNamespaceHeader(config.url)) {
			config.headers[NAMESPACE_HEADER] = API_NAMESPACE;
		}

		// 请求体 camelCase → snake_case 转换（后端 Go 期望 snake_case）
		// 【契约指针】请求参数/体构造一律用 camel 书面写，键名转换由本拦截器承担；
		// 分页参数请经 shared `toPageParams`（utils/page.ts）构造，勿手写 snake 键字面量。
		if (config.data && typeof config.data === 'object' && !(config.data instanceof FormData)) {
			config.data = snakeCaseKeys(config.data);
		}

		// 查询参数 camelCase → snake_case 转换（后端 Go 期望 snake_case form tag）
		if (config.params && typeof config.params === 'object') {
			config.params = snakeCaseKeys(config.params);
		}

		// 按入口登录（P5）：登录端点声明入口平面，identity 据此签发 entry_plane claim
		// （admin./platform. 门户的 redirect 目标决定平面；缺省 api）
		if (config.url?.includes('/api/v1/auth/login') && typeof window !== 'undefined') {
			const redirect = new URLSearchParams(window.location.search).get('redirect');
			config.headers[ENTRY_PLANE_HEADER] = resolveEntryPlane(redirect, window.location.hostname);
		}

		const traceparent = getTraceParentHeader();
		if (traceparent) {
			config.headers['traceparent'] = traceparent;
		}

		return config;
	});

	// ============ Response Interceptor ============
	instance.interceptors.response.use(
		(res) => {
			const data = res.data;

			// 只处理后端标准响应格式 { code, message, ... }
			if (data && typeof data === 'object' && 'code' in data) {
				let payload: unknown;

				// 嵌套 data 格式: { code, message, data: {...}, timestamp }
				if ('data' in data && data.data !== undefined) {
					payload = data.data;
				}
				// 扁平列表格式: { code, message, items, total, pagination, timestamp }
				else if ('items' in data) {
					payload = {
						items: data.items,
						total: data.total,
						pagination: data.pagination,
					};
				}
				// 无 data/items 的简单响应 (如删除成功)
				else {
					payload = data;
				}

				// PascalCase → camelCase 转换
				// 【契约指针】响应键名转换单点在拦截器；页面读取形状请用
				// `extractList` / `extractItem`（唯一形状适配点，utils/response.ts），
				// 分页归一用 `fromPageResult`（utils/page.ts）——勿在页面里手写转换/解包。
				res.data = camelCaseKeys(payload);
			}

			return res;
		},
		async (err: AxiosError) => {
			const originalRequest = err.config as InternalAxiosRequestConfig & {
				_retry?: boolean;
				_tenantRetry?: boolean;
			};
			if (!originalRequest) return Promise.reject(err);

			// 401 → token refresh (skip for login & refresh endpoints — no token to refresh / avoid loops)
			// Also skip OAuth token-exchange: a 401 there is a business error (invalid_grant / invalid_client),
			// NOT session expiry. Treating it as one routes through refreshToken() → onUnauthorized → login
			// page bounce while the auth code is already consumed → infinite redirect loop.
			if (
				err.response?.status === 401 &&
				!originalRequest._retry &&
				!originalRequest.url?.includes('/api/v1/auth/login') &&
				!originalRequest.url?.includes('/api/v1/auth/refresh') &&
				!originalRequest.url?.includes('/oauth/api/v1/oauth/token') &&
				// oauth refresh 端点自身的 401（无效/过期 refresh token）是业务性失败，
				// 不走 refresh 重试（避免 oauth refresh → 401 → 再 refresh 的循环）
				!originalRequest.url?.includes('/oauth/api/v1/oauth/refresh') &&
				// P1-4: export-data 的业务性 401（step-up 拒绝）不是会话过期，
				// 不走 refresh 重试/登出，由页面 catch 展示错误。
				!originalRequest.url?.includes('/auth/me/export-data') &&
				// AUTH-42: delete-account 的 401 是业务性失败（step-up 缺失/过期 40800251、
				// 密码错误 40000502），不是会话过期；走 refresh 重试会掩盖真因（审计现场
				// 即 401→refresh 200→重试 401 双跳后误报「请检查密码是否正确」）。
				!originalRequest.url?.includes('/auth/me/delete-account') &&
				// re-authenticate 同理：密码错误 401（40000502）须由页面按 code 分流文案。
				!originalRequest.url?.includes('/auth/re-authenticate')
			) {
				originalRequest._retry = true;

				// 尝试刷新 token（refreshToken 内部处理无 refresh token / 刷新失败 / onUnauthorized）
				const newToken = await AuthService.refreshToken();
				if (newToken) {
					originalRequest.headers.Authorization = `Bearer ${newToken}`;
					return instance(originalRequest);
				}

				// 刷新失败 → 已由 refreshToken 内部调用 onUnauthorized
				return Promise.reject(err);
			}

			// 404 + tenant not found (ErrCodeDomainTenantNotFound=40000102)
			// → clear tenant from store → retry without X-Tenant-ID
			const data = err.response?.data as any;
			if (
				err.response?.status === 404 &&
				data?.code === '40000102' &&
				!originalRequest._tenantRetry
			) {
				originalRequest._tenantRetry = true;
				AuthService.updateCurrentTenant('');
				// Remove X-Tenant-ID header and retry
				const headers = originalRequest.headers as Record<string, unknown>;
				delete headers['X-Tenant-ID'];
				return instance(originalRequest);
			}

			return Promise.reject(err);
		},
	);
}

/**
 * 创建自定义 baseURL 的 API client 实例
 * 适用于需要访问多个不同服务前缀的场景（如 admin-console）
 */
export function createApiClient(baseUrl: string): AxiosInstance {
	const instance = axios.create({
		baseURL: baseUrl,
		timeout: 30000,
		// 平台跨源只认 Authorization 头（网关 cors.allow_credentials=false）：
		// 显式关闭凭证，避免将来默认值/调用方改动把 cookie 带进跨源请求
		// （带凭证的跨源要求网关回写 ACAC，而动态租户 origin 永不回写）。
		withCredentials: false,
		headers: { 'Content-Type': 'application/json' },
	});
	setupInterceptors(instance);
	return instance;
}

/**
 * 默认 API client 实例，baseURL 从 API_BASE_URL 配置读取，fallback '/api/v1'
 */
export const apiClient: AxiosInstance = createApiClient(getApiBaseUrl());
