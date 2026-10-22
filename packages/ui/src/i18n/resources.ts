/**
 * @autional/ui 组件文案的单一出处（i18n 资源形态，扁平点键——对齐消费站
 * `keySeparator: false` 的扁平键约定）。
 *
 * 消费站在自己的 i18n 初始化时调用 `registerUiI18n(i18n)` 注册本表；未注册时
 * 组件按站点当前语言直接回落本表（i18next defaultValue），行为一致。
 * 门户名措辞对齐 auth dashboard 的 `dashboard.*` 口径（同一门户一处名字）。
 */

export const UI_I18N_NS = 'autional-ui';

export const uiI18nResources: Record<'zh-CN' | 'en-US', Record<string, string>> = {
	'zh-CN': {
		'portal.switcher': '切换门户',
		'portal.names.admin': '管理后台',
		'portal.names.auth': '登录中心',
		'portal.names.security': '安全中心',
		'portal.names.user': '用户中心',
		'portal.names.authenticator': '身份验证器应用',
		'portal.names.status': '状态页',
		'portal.names.trust': '信任中心',
		'portal.names.platform': '平台控制台',
		'portal.names.developer': '开发者门户',
		'portal.names.landing': '门户首页',
		'portal.names.brand': '品牌站',
		// 整页占位（控制台的 PageLoading / PageError）。文案与 admin 站点里原有的
		// pageStatus.* 三键**逐字一致** —— 合并只许改实现，不许顺手改用户看到的字。
		'modal.close': '关闭',
		'pageStatus.loading': '加载中…',
		'pageStatus.loadError': '数据加载失败',
		'pageStatus.retry': '重试',
		// ErrorState 默认标题与描述（原组件硬编码中文）；重试按钮复用 pageStatus.retry。
		'errorState.title': '加载失败',
		'errorState.description': '请稍后重试',
		// ThemeToggle 默认文案（UP-04：原为组件内硬编码中文，EN 站点顶栏出现中文标签）
		'theme.toggleDark': '切换到深色模式',
		'theme.toggleLight': '切换到浅色模式',
		// 组件默认文案（语言问题审计 2026-10-13）：原为组件内硬编码中文默认 ——
		// EN 站裸露中文（trust 加载态「加载中...」线上实测）。文案逐字保留原硬编码值。
		'loadingScreen.message': '加载中...',
		'emptyState.title': '暂无数据',
		'emptyState.description': '当前没有可显示的内容。',
		'confirmDialog.confirm': '确认',
		'confirmDialog.cancel': '取消',
		'alert.close': '关闭',
	},
	'en-US': {
		'portal.switcher': 'Switch portal',
		'portal.names.admin': 'Admin Console',
		'portal.names.auth': 'Sign-in',
		'portal.names.security': 'Security Dashboard',
		'portal.names.user': 'End-User Portal',
		'portal.names.authenticator': 'Authenticator App',
		'portal.names.status': 'Status Page',
		'portal.names.trust': 'Trust Center',
		'portal.names.platform': 'Platform Console',
		'portal.names.developer': 'Developer Portal',
		'portal.names.landing': 'Home',
		'portal.names.brand': 'Brand Site',
		'modal.close': 'Close',
		'pageStatus.loading': 'Loading...',
		'pageStatus.loadError': 'Data loading failed',
		'pageStatus.retry': 'Retry',
		'errorState.title': 'Failed to load',
		'errorState.description': 'Please try again later',
		'theme.toggleDark': 'Switch to dark mode',
		'theme.toggleLight': 'Switch to light mode',
		// EN 词汇对齐舰队既有口径（Loading... / No data / Confirm / Cancel / Close）
		'loadingScreen.message': 'Loading...',
		'emptyState.title': 'No data',
		'emptyState.description': 'Nothing to display yet.',
		'confirmDialog.confirm': 'Confirm',
		'confirmDialog.cancel': 'Cancel',
		'alert.close': 'Close',
	},
};
