import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from '../atoms/Avatar';

describe('Avatar', () => {
	it('有 src 时渲染图片并带上尺寸', () => {
		const { container } = render(
			<Avatar src="https://cdn.example.com/a.png" fallbackText="A" size={40} alt="头像" />,
		);
		const img = container.querySelector('img');
		expect(img).not.toBeNull();
		expect(img).toHaveAttribute('src', 'https://cdn.example.com/a.png');
		expect(img).toHaveAttribute('width', '40');
		expect(img).toHaveAttribute('height', '40');
	});

	it('无 src 时直接回落首字母', () => {
		const { container } = render(<Avatar fallbackText="demo" />);
		expect(screen.getByText('D')).toBeTruthy();
		expect(container.querySelector('img')).toBeNull();
	});

	it('图片加载失败（404/ORB）时切到首字母', () => {
		const { container } = render(
			<Avatar src="https://avatars.invalid/admin.png" fallbackText="U" />,
		);
		fireEvent.error(container.querySelector('img')!);
		expect(screen.getByText('U')).toBeTruthy();
		expect(container.querySelector('img')).toBeNull();
	});

	it('自定义回落节点优先于文本', () => {
		render(<Avatar fallback={<span data-testid="logo-fallback">🔐</span>} />);
		expect(screen.getByTestId('logo-fallback')).toBeTruthy();
	});

	it('src 变化后重新尝试加载', () => {
		const { container, rerender } = render(
			<Avatar src="https://cdn.example.com/old.png" fallbackText="A" />,
		);
		fireEvent.error(container.querySelector('img')!);
		expect(screen.getByText('A')).toBeTruthy();

		rerender(<Avatar src="https://cdn.example.com/new.png" fallbackText="A" />);
		expect(container.querySelector('img')).toHaveAttribute(
			'src',
			'https://cdn.example.com/new.png',
		);
	});

	it('透传 referrerPolicy（第三方图标不泄露来源）', () => {
		const { container } = render(
			<Avatar src="https://cdn.example.com/a.png" fallbackText="A" referrerPolicy="no-referrer" />,
		);
		expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
	});

	it('装饰性图片（无 alt）标记 aria-hidden', () => {
		const { container } = render(
			<Avatar src="https://cdn.example.com/a.png" fallbackText="A" />,
		);
		expect(container.querySelector('img')).toHaveAttribute('aria-hidden', 'true');
	});
});
