'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SOFT_BORDER, SOFT_TEXT, type SemanticVariant } from '../internal/semantic-styles';
import { UI_I18N_NS, uiText } from '../i18n';

// Alert —— 区块级提示（着色块）。
//
// 为什么要有它（第 31 轮实测）：
//   · user 门户 **30 处手写**着色提示块，是 26 种排列组合（`bg-info-soft border-info-soft`、
//     `bg-amber-50 border-amber-200 text-amber-800`、`bg-primary-50`…），
//     其中「警告」有三种写法（amber-50 / warning-soft / amber-800 文字）；
//   · 其余站在用 antd 的 `<Alert>`（security 14 / platform 19 / admin 9 / status 18 / authenticator 15 /
//     trust 9）—— 那是**组件**，但它给的是 antd 出厂的四档配色，而不是设计系统自己的语义槽位。
//   两边合起来 = 同一个语义（一句提示）在舰队里有六七种长相。
//
// 配色只走 internal/semantic-styles.ts 那一份 `-soft` / `-text` 配对（与 StatusBadge 同源）：
// 那一份是模式感知的、且每一档都做过对比度验证（success 5.51 / warning 4.85 / danger 4.65 / info 6.70）。
// 这也是为什么**不提供** `variant="brand"`：品牌色不是语义色，硬塞进来会让「提示的语义」和「品牌曝光」
// 混成一个属性，而且 brand 那一档没有配过 -text。
//
// 刻意不做的事：不做 `banner`（整条横幅）、不做 `action` 槽（antd 有，但 fleet 里 0 处用它）。
// 没有消费者的能力不进设计系统。
export type AlertVariant = SemanticVariant;

export interface AlertProps {
	/** 语义档位，默认 info。amber（品牌色阶里的暖色）在语义上属于 warning。 */
	variant?: AlertVariant;
	/** 加粗的第一行（可选）。 */
	title?: React.ReactNode;
	/** 正文。 */
	children?: React.ReactNode;
	/** 图标：默认按档位给一个；显式传 `null` 可以不要图标。 */
	icon?: React.ReactNode | null;
	/**
	 * 右侧动作区（一个按钮/链接）。
	 *
	 * 第 39 轮补上：D18 当初写的是「`action` 在舰队里 0 处使用」，**那条证据是错的** ——
	 * 它来自「数 `<Alert` 出现次数」，而从没数过这些 Alert 用了哪些属性。
	 * 按属性数过之后：三个控制台里 `action` 有 **5 个**真实消费者（security 4 + admin 1），
	 * 那 5 处因此一直收不过来（它们不是配色不同，是形态不同）。够「≥2 份」的口径，所以补上。
	 */
	action?: React.ReactNode;
	/** 是否可关闭（受控：真正的关闭动作在 onClose 里）。 */
	closable?: boolean;
	/** 点关闭按钮时调用。 */
	onClose?: () => void;
	/** 关闭按钮的无障碍标签。 */
	closeLabel?: string;
	/** 追加类名（间距归调用方，配色归组件）。 */
	className?: string;
}

const DEFAULT_ICONS: Record<AlertVariant, React.ReactNode> = {
	success: <CheckCircle2 className="h-4 w-4" />,
	warning: <AlertTriangle className="h-4 w-4" />,
	danger: <XCircle className="h-4 w-4" />,
	info: <Info className="h-4 w-4" />,
	neutral: <Info className="h-4 w-4" />
};

export const Alert = React.memo(function Alert({
	variant = 'info',
	title,
	children,
	icon,
	action,
	closable = false,
	onClose,
	closeLabel,
	className = ''
}: AlertProps) {
	const { t, i18n } = useTranslation();
	// 文案解析链与 Modal / ThemeToggle 同构（语言问题审计 2026-10-13）：原为硬编码中文默认。
	const closeLabelText =
		closeLabel ??
		t('alert.close', { ns: UI_I18N_NS, defaultValue: uiText(i18n.language, 'alert.close') ?? '关闭' });
	const glyph = icon === null ? null : (icon ?? DEFAULT_ICONS[variant]);
	return (
		// role="alert" 与 antd 的 Alert 一致：这些块绝大多数是**动作之后**才出现的（结果/失败原因），
		// 屏幕阅读器应当主动播报；这与「静态的一行说明」不同，所以调用方若把它当纯装饰用，
		// 应当显式传 role={undefined}。
		<div
			role="alert"
			className={`flex items-start gap-3 rounded-lg border p-4 ${SOFT_TEXT[variant]} ${SOFT_BORDER[variant]} ${className}`}
		>
			{glyph ? <span className="mt-0.5 shrink-0">{glyph}</span> : null}
			<div className="min-w-0 flex-1">
				{title ? <p className="font-semibold">{title}</p> : null}
				{children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
			</div>
			{action ? <div className="ml-auto shrink-0 self-center pl-2">{action}</div> : null}
			{closable ? (
				<button
					type="button"
					onClick={onClose}
					aria-label={closeLabelText}
					className="-mr-1 -mt-1 shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2"
				>
					<X className="h-4 w-4" />
				</button>
			) : null}
		</div>
	);
});
