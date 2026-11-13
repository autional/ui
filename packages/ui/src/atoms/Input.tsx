import * as React from 'react';
import { fieldControlClass, fieldControlClassFor, fieldControlHeight, type FieldShape, type FieldSize } from '../internal/field-styles';

// 注：`prefix` 与 `size` 都与 HTML 自带的同名属性冲突（`prefix?: string`、`size?: number`，
// 而这里要的是 ReactNode 与 'sm'|'md'|'lg'）。两处都是 **tsc 当场报出来的** ——
// 所以显式 Omit 掉再重定义，保住最自然的调用名，而不是改成 `inputSize` 这种妥协名。
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'size'> {
	error?: string;
	/**
	 * 前缀槽：图标或极短的单位符号（如货币符号）。
	 *
	 * 为什么要有它（第 59 轮）：舰队里 5 个站在手写同一个模式 ——
	 * 一个 `relative` 容器 + 绝对定位的图标 + **算出来的**左内边距（`pl-9` = 12 起点 + 16 图标 + 8 间隙 = 36px）。
	 * 那是同一个几何被抄了 6 遍，而且抄出来的值不在档位上。
	 * 这里用 **flex 排布**而不是绝对定位：图标占真实布局空间，于是
	 * **不需要任何魔法内边距**，也不挑图标尺寸。
	 *
	 * 图标请守图标纪律：默认 `size="1em"`，显式字号时 `size={N}`。
	 */
	prefix?: React.ReactNode;
	/** 后缀槽：清除按钮、单位后缀一类。同样占真实布局空间。 */
	suffix?: React.ReactNode;
	/**
	 * 尺寸档（第 61 轮）：sm=h-9 / md=h-10（默认）/ lg=h-14。
	 * 舰队里手写的搜索框有三种几何，这个参数就是为它们准备的 —— **只影响有槽形态**，
	 * 无槽形态仍走默认高度（既有消费方零影响）。
	 */
	size?: FieldSize;
	/** 形状档：default=rounded-md / pill=rounded-full（大圆角搜索框）。同样只影响有槽形态。 */
	shape?: FieldShape;
}

// 外观来自 ../internal/field-styles —— 与 @autional/ui/rhf 的绑定控件同一份，不各自维护。
//
// 两种渲染形态（**无槽时逐字节不变**，既有消费方零影响）：
//   · 无 prefix/suffix：只有一个 <input>，外框在它自己身上（原样）；
//   · 有槽：外框交给 wrapper，<input> 变透明并占满剩余宽度 —— 高度/圆角由 `size` / `shape`
//     两轴决定（第 61 轮补：舰队里搜索框有三种几何 py-2 / py-2.5 / py-3.5 + rounded-full，
//     组件层若只有一种，站点就只能各自写材质 —— 那就是这条维度存在的原因）。
//     ⚠️ 调用方**不要**再传高度/内边距/圆角：同一批属性只能有一个来源，否则胜负由
//     Tailwind 的生成顺序决定，而那是无声的。
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className = '', error, prefix, suffix, size = 'md', shape = 'default', ...props }, ref) => {
		const hasSlot = prefix != null || suffix != null;
		return (
			<div className="w-full">
				{hasSlot ? (
					// ⚠️ 焦点环必须挂在**容器**上：点输入框时聚焦的是内层 <input>，
					// 外层 div 的 `focus-visible` 不触发 ⇒ 这个分支会完全没有可见焦点。用 focus-within 补。
					<div
						className={fieldControlClassFor(
							size,
							shape,
							!!error,
							'items-center gap-2 ' +
								className +
								' focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring-color)]',
						)}
					>
						{prefix != null && (
							<span className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">{prefix}</span>
						)}
						<input ref={ref} className="min-w-0 flex-1 bg-transparent p-0 text-inherit outline-none placeholder:text-[var(--color-text-muted)]" {...props} />
						{suffix != null && <span className="shrink-0">{suffix}</span>}
					</div>
				) : (
					<input ref={ref} className={fieldControlClass(!!error, fieldControlHeight + ' ' + className)} {...props} />
				)}
				{error && <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>}
			</div>
		);
	},
);
Input.displayName = 'Input';