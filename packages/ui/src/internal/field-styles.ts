// 表单控件的外观只有一份 —— Input atom 与 @autional/ui/rhf 的绑定控件都用它。
// 各自复制一份类名串的后果不是「看起来一样」，而是「改了一处、另一处没变」：
// 那正是这一层要消灭的东西（与 antd 组件级令牌同理，只是这里是一段 Tailwind 类）。
//
// 第 61 轮加了尺寸与形状两轴 —— 起因是舰队里手写的搜索框有**三种几何**
// （py-2 / py-2.5 / py-3.5 + rounded-full），而组件层只有一种，于是站点只能各自写材质。
// 关键纪律：**高度/内边距/圆角只由一个地方发出来**（这里），调用方的 className 不得与它冲突 ——
// 否则胜负由 Tailwind 的生成顺序决定，那是无声的。

// ⚠️ 拆 BASE 的时候差点丢掉两个状态样式（focus-visible 环、disabled）——
// 「重写一个常量的整行」时最容易漏掉的就是**行尾那几个**。它们与尺寸/形状不冲突，
// 所以留在 STRUCT 里，一处不少。
const STRUCT =
	'flex w-full border bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] ' +
	'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 ' +
	'disabled:cursor-not-allowed disabled:opacity-50';

/** 尺寸档：高度是**定值**（不是 padding 撑出来的）—— 同一行里的控件要对齐，定值才可预测。 */
export type FieldSize = 'sm' | 'md' | 'lg';
const SIZE: Record<FieldSize, string> = {
	sm: 'h-9 px-3 text-sm',
	md: 'h-10 px-3 text-sm',
	lg: 'h-14 px-4 text-base',
};

/** 形状档。pill 是给「搜索框」一类大圆角控件用的，不是给表单控件的默认。 */
export type FieldShape = 'default' | 'pill';
const SHAPE: Record<FieldShape, string> = {
	default: 'rounded-md',
	pill: 'rounded-full',
};

/** 单行控件的默认高度。textarea 不给（它要能长高）。 */
export const fieldControlHeight = 'h-10';

export function fieldControlClassFor(
	size: FieldSize = 'md',
	shape: FieldShape = 'default',
	invalid?: boolean,
	extra = '',
): string {
	const border = invalid ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-strong)]';
	return `${STRUCT} ${SIZE[size]} ${SHAPE[shape]} ${border} ${extra}`.trim();
}

/** 旧签名（默认 md + default）—— **逐字节不变**，既有消费方零影响。 */
export function fieldControlClass(invalid?: boolean, extra = ''): string {
	return fieldControlClassFor('md', 'default', invalid, extra);
}
