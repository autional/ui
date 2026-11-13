import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '../Button';
import { Toggle } from '../Toggle';
import { Input } from '../Input';
import { fieldControlClass, fieldControlClassFor } from '../../internal/field-styles';

// 回归锁（焦点环走 tokens 规范）。
//
// 为什么需要这个文件：组件层的焦点样式刚从「自绘 ring」改成 tokens 规范
// （2px outline + 2px offset + --focus-ring-color），但当时 189 条测试里**没有一条**断言焦点类名 ——
// 也就是说，任何人把 focus-visible:ring-2 抄回去，全套测试依旧全绿，回归无声。
//
// 为什么必须**按整类名（token）**比对而不是子串：`focus-visible:outline` 是
// `focus-visible:outline-2` 的前缀，用 toContain 做子串匹配时前者会被后者顺带满足，
// 于是「outline 宽度丢了」这种回归照样绿。这里把 className 切成 token 再比对。

/** 把类名串切成**整类名**列表；空串 / null 安全。 */
function toTokens(raw: string | null | undefined): string[] {
	return (raw ?? '').split(/\s+/).filter(Boolean);
}

/** 取元素上的整类名列表。 */
function classTokens(el: Element | null): string[] {
	return toTokens(el?.getAttribute('class'));
}

/** 焦点环的四个组成部分（缺一不可：宽度 / 偏移 / 颜色 / outline 本身）。 */
const FOCUS_RING_TOKENS = [
	'focus-visible:outline',
	'focus-visible:outline-2',
	'focus-visible:outline-offset-2',
	'focus-visible:outline-[var(--focus-ring-color)]',
];

/** 自绘 ring 的任意形态：`ring-2` / `focus-visible:ring-2` / `ring-offset-2` …
 *
 *  ⚠️ 这里**不能**用 `expect(cls).not.toContain('ring-')`：焦点环的令牌名
 *  `--focus-ring-color` 本身就含 `ring-`，那样写会把**正确实现**判红 ——
 *  属于「按子串迁就实现」的反面：断言必须描述意图（自绘 ring 工具类），不是字面碎片。
 *  所以限定在 token 边界上：`ring-` 出现在串首或某个变体前缀 `:` 之后才算工具类。 */
const RING_UTILITY = /(^|:)ring-/;

/** 从 token 列表里挑出自绘 ring 工具类；非空即回归。 */
function ringUtilities(tokens: string[]): string[] {
	return tokens.filter((t) => RING_UTILITY.test(t));
}

// ---------------------------------------------------------------------------
// 1) Button：base 串里的焦点环
// ---------------------------------------------------------------------------
describe('焦点环回归锁 · Button', () => {
	it('焦点环走 tokens 规范（outline 2px + 2px offset + 品牌色），且不回退到自绘 ring', () => {
		render(<Button>确定</Button>);
		const btn = screen.getByRole('button');
		const tokens = classTokens(btn);

		// 正面：四段都在，且是**独立类名**。
		expect(tokens).toEqual(expect.arrayContaining(FOCUS_RING_TOKENS));

		// 反面：自绘 ring 一个都不许出现。
		// 理由：ring-offset 的白色间隙在深色主题上是错的，且 ring 不带 --focus-ring-color ⇒ 失去品牌色。
		expect(tokens).not.toContain('focus-visible:ring-2');
		expect(ringUtilities(tokens)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2) Toggle：与 Button 同一套焦点语言（同类控件不能有两套焦点观感）
// ---------------------------------------------------------------------------
describe('焦点环回归锁 · Toggle', () => {
	it('焦点环走 tokens 规范，且不回退到自绘 ring', () => {
		render(<Toggle checked={false} onChange={vi.fn()} />);
		const sw = screen.getByRole('switch');
		const tokens = classTokens(sw);

		expect(tokens).toEqual(expect.arrayContaining(FOCUS_RING_TOKENS));

		// 理由同 Button：开关与按钮在同一个工具条里并排出现，焦点样式分叉会被一眼看出。
		expect(tokens).not.toContain('focus-visible:ring-2');
		expect(ringUtilities(tokens)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3) Input（有 prefix 的分支）：环画在**容器**上，内层 input 必须透明
// ---------------------------------------------------------------------------
describe('焦点环回归锁 · Input（有槽形态）', () => {
	it('焦点环挂在容器上（focus-within），内层 input 保持 outline-none', () => {
		render(<Input prefix={<span>@</span>} />);
		const input = screen.getByRole('textbox');
		const wrapper = input.parentElement;
		expect(wrapper).not.toBeNull();
		const wrapperTokens = classTokens(wrapper);

		// 有槽形态的可见焦点只能来自容器：真正被聚焦的是内层 <input>，
		// 容器上的 focus-visible 永不触发 ⇒ 必须用 focus-within，否则这个分支完全没有可见焦点。
		expect(wrapperTokens).toEqual(
			expect.arrayContaining([
				'focus-within:outline',
				'focus-within:outline-2',
				'focus-within:outline-offset-2',
				'focus-within:outline-[var(--focus-ring-color)]',
			])
		);

		// 内层 input 的 outline-none 是**有意**的：环由容器画，两处都画会出现双层环。
		expect(classTokens(input)).toContain('outline-none');
		expect(classTokens(input)).not.toContain('focus-visible:outline');
	});
});

// ---------------------------------------------------------------------------
// 4) field-styles：单一真源（Input 与 rhf 绑定控件共用这一份）
// ---------------------------------------------------------------------------
describe('焦点环回归锁 · field-styles 单一真源', () => {
	it('fieldControlClass 的返回值带 tokens 焦点环，且不含自绘 ring 工具类', () => {
		const cls = fieldControlClass(false);

		expect(toTokens(cls)).toEqual(expect.arrayContaining(FOCUS_RING_TOKENS));

		// 理由：这份串被 Input 与 @autional/ui/rhf 同时消费；只要它退化回 ring-，
		// 舰队里所有表单控件的焦点环会**一起**退化，而且不会有任何测试变红 —— 除了这条。
		expect(ringUtilities(toTokens(cls))).toEqual([]);
	});

	it('fieldControlClassFor 走同一份 STRUCT（尺寸/形状轴不复制焦点样式）', () => {
		// 焦点样式若被抄进 SIZE/SHAPE 之类分支，就会出现「换尺寸后焦点环变了」的静默分歧。
		const cls = fieldControlClassFor('md', 'default', false);
		expect(toTokens(cls)).toEqual(expect.arrayContaining(FOCUS_RING_TOKENS));
		expect(ringUtilities(toTokens(cls))).toEqual([]);
	});
});
