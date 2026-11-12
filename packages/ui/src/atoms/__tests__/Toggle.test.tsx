import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toggle } from '../Toggle';

// UP-81 / U4 回归锁：Toggle 是 role="switch" 的按钮，必须能被屏幕阅读器读出用途。
// 此前组件不接受 aria-label，调用方只能用 <label> 包（对 button 无效）→ 开关无可访问名。
describe('Toggle a11y', () => {
	it('默认不设置可访问名（保持旧行为，避免误报）', () => {
		render(<Toggle checked={false} onChange={vi.fn()} />);
		const sw = screen.getByRole('switch');
		expect(sw).not.toHaveAttribute('aria-label');
		expect(sw).not.toHaveAttribute('aria-labelledby');
	});

	it('ariaLabel 透传为 aria-label', () => {
		render(<Toggle checked onChange={vi.fn()} ariaLabel="通知：故障" />);
		expect(screen.getByRole('switch', { name: '通知：故障' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
	});

	it('ariaLabelledBy 优先于 ariaLabel（指向可见标题）', () => {
		render(
			<>
				<span id="pref-label">通知：维护</span>
				<Toggle
					checked={false}
					onChange={vi.fn()}
					ariaLabel="应被忽略"
					ariaLabelledBy="pref-label"
				/>
			</>
		);
		const sw = screen.getByRole('switch', { name: '通知：维护' });
		expect(sw).toHaveAttribute('aria-labelledby', 'pref-label');
		expect(sw).not.toHaveAttribute('aria-label');
	});
});
