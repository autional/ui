import React, { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UI_I18N_NS, uiText } from '../i18n';

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	description: string;
	confirmText?: string;
	cancelText?: string;
	variant?: 'danger' | 'warning' | 'neutral';
	onConfirm: () => void;
	onCancel: () => void;
}

const variantStyles = {
	danger: {
		icon: 'bg-danger-soft text-danger-text',
		confirm: 'bg-danger text-white hover:opacity-90',
	},
	warning: {
		icon: 'bg-warning-soft text-warning-text',
		confirm: 'bg-warning text-white hover:opacity-90',
	},
	neutral: {
		icon: 'bg-brand-soft text-brand',
		confirm: 'bg-[var(--color-brand)] text-white hover:opacity-90',
	},
};

export const ConfirmDialog = React.memo(function ConfirmDialog({
	open,
	title,
	description,
	confirmText,
	cancelText,
	variant = 'neutral',
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const { t, i18n } = useTranslation();
	// 文案解析链与 Modal / ThemeToggle 同构（语言问题审计 2026-10-13）：原为硬编码
	// 中文默认（'确认' / '取消' / X 按钮 '关闭'）—— user 门户 5 处裸调用 EN 站裸露中文。
	const resolve = (key: string, fallback: string): string =>
		t(key, { ns: UI_I18N_NS, defaultValue: uiText(i18n.language, key) ?? fallback });
	const confirmLabel = confirmText ?? resolve('confirmDialog.confirm', '确认');
	const cancelLabel = cancelText ?? resolve('confirmDialog.cancel', '取消');
	// X 按钮与 Modal 同键（同为对话框关闭，文案一致）
	const closeLabel = resolve('modal.close', '关闭');

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === 'Escape') onCancel();
		},
		[onCancel],
	);

	useEffect(() => {
		if (open) {
			document.addEventListener('keydown', handleKeyDown);
			document.body.style.overflow = 'hidden';
		}
		return () => {
			document.removeEventListener('keydown', handleKeyDown);
			document.body.style.overflow = '';
		};
	}, [open, handleKeyDown]);

	if (!open) return null;

	const style = variantStyles[variant];

	// 与 Modal 同因同解（第 63 轮补·四）：portal 到 body，否则「有 backdrop-filter 的祖先」
	// 会成为 fixed 后代的包含块，遮罩只覆盖那一小块。
	const content = (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<div className="absolute inset-0 bg-scrim/50 backdrop-blur-sm" onClick={onCancel} />
			<div className="relative w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-6 shadow-brand">
				<button
					onClick={onCancel}
					className="absolute right-4 top-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
					aria-label={closeLabel}
				>
					<X className="h-4 w-4" />
				</button>
				<div className="flex items-start gap-4">
					<div
						className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${style.icon}`}
					>
						<AlertTriangle className="h-5 w-5" />
					</div>
					<div>
						<h3 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h3>
						<p className="mt-1 text-sm text-[var(--color-text-secondary)]">{description}</p>
					</div>
				</div>
				<div className="mt-6 flex justify-end gap-3">
					<button
						onClick={onCancel}
						className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-muted)]"
					>
						{cancelLabel}
					</button>
					<button
						onClick={onConfirm}
						className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${style.confirm}`}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);

	if (typeof document === 'undefined') return content;
	return createPortal(content, document.body);
});
