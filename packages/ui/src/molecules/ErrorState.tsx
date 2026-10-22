import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UI_I18N_NS, uiText } from '../i18n';

export interface ErrorStateProps {
	title?: string;
	description?: string;
	message?: string;
	onRetry?: () => void;
	action?: { label: string; onClick: () => void };
	className?: string;
}

export function ErrorState({
	title,
	description,
	message,
	onRetry,
	action,
	className = '',
}: ErrorStateProps) {
	const { t, i18n } = useTranslation();
	// 文案解析链与 LoadingScreen / EmptyState 同构（语言问题审计 2026-10-13 家族）：
	// 原为硬编码中文默认，EN 站错误态裸露「加载失败 / 请稍后重试 / 重试」。
	const resolve = (key: string, fallback: string): string =>
		t(key, { ns: UI_I18N_NS, defaultValue: uiText(i18n.language, key) ?? fallback });
	const displayTitle = title || resolve('errorState.title', '加载失败');
	const displayMessage = description || message || resolve('errorState.description', '请稍后重试');

	return (
		<div
			className={`flex flex-col items-center justify-center gap-3 rounded-lg border border-danger-soft bg-danger-soft px-4 py-8 text-center ${className}`}
		>
			<div className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-soft">
				<AlertTriangle className="h-7 w-7 text-danger" />
			</div>
			<div>
				<p className="text-sm font-medium text-[var(--color-text-primary)]">{displayTitle}</p>
				<p className="mt-1 text-xs text-[var(--color-text-secondary)]">{displayMessage}</p>
			</div>
			{action ? (
				<button
					onClick={action.onClick}
					className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-muted)]"
				>
					{action.label}
				</button>
			) : onRetry ? (
				<button
					onClick={onRetry}
					className="inline-flex items-center gap-1.5 rounded-md border border-danger-soft bg-[var(--color-bg-surface)] px-3 py-1.5 text-xs text-danger-text hover:bg-danger-soft"
				>
					<RefreshCw className="h-3.5 w-3.5" />
					{resolve('pageStatus.retry', '重试')}
				</button>
			) : null}
		</div>
	);
}
