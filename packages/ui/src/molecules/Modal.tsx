import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UI_I18N_NS, uiText } from '../i18n';

// UP-19：dialog 语义与焦点管理此前整体缺失（裸 div 覆盖层 —— 屏幕阅读器读不到
// 「这是一个对话框」，Tab 能溜到背后的页面，关闭后焦点丢到 body）。
// 列在这里的只含可聚焦元素；弹窗内元素在渲染时必然可见，无需再做可见性过滤
// （jsdom 算不出布局，加了过滤器反而把测试和真实浏览器行为拉开差距）。
const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: string;
	/** 标题下的一行说明。多个页面原本把它写在自绘表头里（如「授权同意」弹窗），收进 API 才不用各自拼表头。 */
	description?: string;
	/** 正文。**可以不给** —— 「标题 + 说明 + 按钮」的确认框是常见形状，不该被逼着塞一个空正文（那会留一段 32px 的空白）。 */
	children?: React.ReactNode;
	footer?: React.ReactNode;
	maxWidth?: 'sm' | 'md' | 'lg';
	className?: string;
}

const maxWidthClasses: Record<string, string> = {
	sm: 'max-w-sm',
	md: 'max-w-md',
	lg: 'max-w-lg',
};

export const Modal = React.memo(function Modal({
	open,
	onClose,
	title,
	description,
	children,
	footer,
	maxWidth = 'md',
	className = '',
}: ModalProps) {
	const { t, i18n } = useTranslation();
	// 关闭按钮的无障碍标签此前是写死的中文 —— 与 PortalSwitcher / PageStatus 走同一条解析链：
	// 站点注册过就用站点的，没注册回落内置表。
	const closeLabel = t('modal.close', {
		ns: UI_I18N_NS,
		defaultValue: uiText(i18n.language, 'modal.close') ?? '关闭',
	});

	const panelRef = useRef<HTMLDivElement>(null);
	const previouslyFocused = useRef<HTMLElement | null>(null);
	const wasOpen = useRef(false);
	const dialogId = useId();
	const titleId = `${dialogId}-title`;
	const descriptionId = `${dialogId}-description`;

	// 打开的那次渲染里记下「开弹窗前的焦点」。必须赶在提交之前 —— 消费方若在弹窗里标了
	// autoFocus，React 会在提交期就把焦点送进输入框，效果函数里再读就晚了（读到的是输入框自己，
	// 我们就把「从哪来」弄丢了，关闭时也无处归还）。读 activeElement 无副作用，重复渲染幂等。
	if (open && !wasOpen.current) {
		previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
	}
	wasOpen.current = open;

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
				return;
			}
			if (e.key !== 'Tab') return;
			const panel = panelRef.current;
			if (!panel) return;
			const focusable = getFocusableElements(panel);
			if (focusable.length === 0) {
				e.preventDefault();
				panel.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement as HTMLElement | null;
			const inside = active != null && panel.contains(active);
			if (e.shiftKey) {
				if (!inside || active === first) {
					e.preventDefault();
					last.focus();
				}
			} else if (!inside || active === last) {
				e.preventDefault();
				first.focus();
			}
		},
		[onClose],
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

	useEffect(() => {
		if (!open) return;
		const panel = panelRef.current;
		if (panel) {
			// 焦点已在面板内（React 提交期把 autoFocus 元素聚焦了）就不动它；否则移入首个可聚焦元素。
			const active = document.activeElement as HTMLElement | null;
			if (!active || !panel.contains(active)) {
				const focusable = getFocusableElements(panel);
				(focusable[0] ?? panel).focus();
			}
		}
		return () => {
			// 焦点归还只在元素还在文档里时做 —— 触发按钮随页面跳转消失的场景静默跳过。
			if (previouslyFocused.current?.isConnected) previouslyFocused.current.focus();
		};
	}, [open]);

	if (!open) return null;

	// ⚠ 必须 portal 到 document.body（第 63 轮补·四实测）：
	// `position: fixed` 的包含块**不是视口**，而是最近的「有 transform / filter / backdrop-filter /
	// will-change / contain」的祖先。站点的顶栏内层写了 `backdrop-blur-xl`，于是**在顶栏里打开的浮层**
	// 的 inset-0 只覆盖顶栏那一小块 —— 实测 www.autional.cn 的搜索面板：遮罩是 976x135 的一条，
	// 而不是整屏（用户的原话是「弹出一个黑色遮罩，怪怪的」）。
	// 浮层属于顶层，不属于触发它的那棵子树；portal 是这条规则的结构性实现。
	const content = (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4">
			<div className="absolute inset-0" onClick={onClose} />
			{/*
			 * 刻意 outline-none：本面板是 role="dialog" + tabIndex={-1} 的**程序化焦点目标**
			 * （打开时把焦点移进来做焦点陷阱），不是可交互控件 —— 给它画焦点环会盖住内容，
			 * 也与内部控件自己的焦点环重复。可交互控件（Button/Input/Toggle）一律走 tokens 焦点环，
			 * 回归锁见 atoms/__tests__/focus-ring.test.tsx。
			 */}
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={title ? titleId : undefined}
				aria-describedby={title && description ? descriptionId : undefined}
				tabIndex={-1}
				className={`relative w-full ${maxWidthClasses[maxWidth]} rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-brand outline-none ${className}`}
			>
				{title && (
					<div className="flex items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] px-6 py-4">
						<div>
							<h3 id={titleId} className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h3>
							{description && (
								<p id={descriptionId} className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{description}</p>
							)}
						</div>
						<button
							onClick={onClose}
							className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
							aria-label={closeLabel}
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				)}
				{!title && (
					<button
						onClick={onClose}
						className="absolute right-4 top-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
						aria-label={closeLabel}
					>
						<X className="h-4 w-4" />
					</button>
				)}
				{children != null && <div className="px-6 py-4">{children}</div>}
				{footer && (
					<div className="flex justify-end gap-3 border-t border-[var(--color-border-subtle)] px-6 py-4">
						{footer}
					</div>
				)}
			</div>
		</div>
	);

	// SSR / 测试环境没有 document 时退回就地渲染（portal 的目标不存在）
	if (typeof document === 'undefined') return content;
	return createPortal(content, document.body);
});
