import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UI_I18N_NS, uiText } from '../i18n';

export interface LoadingScreenProps {
	message?: string;
	fullScreen?: boolean;
	className?: string;
}

export function LoadingScreen({
	message,
	fullScreen = false,
	className = '',
}: LoadingScreenProps) {
	const { t, i18n } = useTranslation();
	// 文案解析链与 Modal / ThemeToggle 同构（语言问题审计 2026-10-13）：
	// 原为硬编码中文默认，EN 站加载态裸露「加载中...」（trust 线上实测）。
	const text =
		message ??
		t('loadingScreen.message', {
			ns: UI_I18N_NS,
			defaultValue: uiText(i18n.language, 'loadingScreen.message') ?? '加载中...',
		});

	const content = (
		<div className="flex flex-col items-center justify-center gap-3">
			<Loader2 size={fullScreen ? 32 : 24} className="animate-spin text-[var(--color-brand)]" />
			<p className="text-sm text-[var(--color-text-secondary)]">{text}</p>
		</div>
	);

	if (fullScreen) {
		return (
			<div className={`flex min-h-screen items-center justify-center px-4 ${className}`}>
				{content}
			</div>
		);
	}

	return <div className={`flex h-40 items-center justify-center ${className}`}>{content}</div>;
}
