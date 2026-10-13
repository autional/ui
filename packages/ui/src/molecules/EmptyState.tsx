import React from 'react';
import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UI_I18N_NS, uiText } from '../i18n';

interface EmptyStateProps {
	title?: string;
	description?: string;
	icon?: React.ReactNode;
}

export const EmptyState = React.memo(function EmptyState({
	title,
	description,
	icon,
}: EmptyStateProps) {
	const { t, i18n } = useTranslation();
	// 文案解析链与 Modal / ThemeToggle 同构（语言问题审计 2026-10-13）：原为硬编码中文默认。
	const resolve = (key: string, fallback: string): string =>
		t(key, { ns: UI_I18N_NS, defaultValue: uiText(i18n.language, key) ?? fallback });
	const titleText = title ?? resolve('emptyState.title', '暂无数据');
	const descriptionText = description ?? resolve('emptyState.description', '当前没有可显示的内容。');

	return (
		<div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] px-4 py-12 text-center">
			<div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-bg-muted)] text-[var(--color-text-muted)]">
				{icon ?? <Inbox className="h-6 w-6" />}
			</div>
			<h3 className="mt-4 text-base font-semibold text-[var(--color-text-primary)]">{titleText}</h3>
			<p className="mt-1 text-sm text-[var(--color-text-secondary)]">{descriptionText}</p>
		</div>
	);
});
