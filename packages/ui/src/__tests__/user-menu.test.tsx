import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserMenu, deriveUserInitials } from '../molecules/UserMenu';

const i18nState = vi.hoisted(() => ({ language: 'zh-CN' }));
vi.mock('react-i18next', () => ({
	useTranslation: () => ({ i18n: i18nState }),
}));

const USER = { username: 'acme_admin', email: 'admin@autional.com' };

function renderMenu(overrides: Partial<React.ComponentProps<typeof UserMenu>> = {}) {
	const onLogout = vi.fn();
	const onSettings = vi.fn();
	const utils = render(
		<UserMenu
			user={USER}
			items={[
				{ key: 'settings', type: 'settings', onClick: onSettings },
				{ key: 'logout', type: 'logout', onClick: onLogout },
			]}
			{...overrides}
		/>,
	);
	return { ...utils, onLogout, onSettings };
}

const trigger = () => screen.getByRole('button', { name: /用户菜单|User menu/ });
const menu = () => screen.queryByRole('menu');

describe('deriveUserInitials', () => {
	it('用户名首字母大写', () => {
		expect(deriveUserInitials({ username: 'acme_admin' })).toBe('A');
	});
	it('无用户名回落邮箱', () => {
		expect(deriveUserInitials({ email: 'demo@localhost' })).toBe('D');
	});
	it('displayName 优先于 username/email', () => {
		expect(
			deriveUserInitials({ displayName: 'Demo Admin', username: 'acme_admin', email: 'a@b.c' }),
		).toBe('D');
	});
	it('displayName 空白串回落 username', () => {
		expect(deriveUserInitials({ displayName: '   ', username: 'acme_admin' })).toBe('A');
	});
	it('空用户回落 U', () => {
		expect(deriveUserInitials(null)).toBe('U');
		expect(deriveUserInitials({})).toBe('U');
	});
});

describe('UserMenu', () => {
	beforeEach(() => {
		i18nState.language = 'zh-CN';
	});

	it('点击开合 + aria-expanded 跟随', async () => {
		const user = userEvent.setup();
		renderMenu();
		expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
		expect(trigger()).toHaveAttribute('aria-expanded', 'false');
		expect(menu()).not.toBeInTheDocument();

		await user.click(trigger());
		expect(trigger()).toHaveAttribute('aria-expanded', 'true');
		expect(menu()).toBeInTheDocument();

		await user.click(trigger());
		expect(menu()).not.toBeInTheDocument();
		expect(trigger()).toHaveAttribute('aria-expanded', 'false');
	});

	it('ArrowDown 打开并聚焦首项，菜单内 ArrowUp/Down 循环、Home/End 跳转', async () => {
		const user = userEvent.setup();
		renderMenu();
		trigger().focus();
		await user.keyboard('{ArrowDown}');
		const items = screen.getAllByRole('menuitem');
		expect(items).toHaveLength(2);
		expect(document.activeElement).toBe(items[0]);

		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(items[1]);
		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(items[0]);
		await user.keyboard('{ArrowUp}');
		expect(document.activeElement).toBe(items[1]);
		await user.keyboard('{Home}');
		expect(document.activeElement).toBe(items[0]);
		await user.keyboard('{End}');
		expect(document.activeElement).toBe(items[1]);
	});

	it('ArrowUp 从触发钮打开聚焦末项', async () => {
		const user = userEvent.setup();
		renderMenu();
		trigger().focus();
		await user.keyboard('{ArrowUp}');
		const items = screen.getAllByRole('menuitem');
		expect(document.activeElement).toBe(items[items.length - 1]);
	});

	it('Esc 关闭并还焦到触发钮', async () => {
		const user = userEvent.setup();
		renderMenu();
		trigger().focus();
		await user.keyboard('{ArrowDown}');
		expect(menu()).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(menu()).not.toBeInTheDocument();
		expect(document.activeElement).toBe(trigger());
	});

	it('鼠标打开后 Esc（焦点在触发钮）同样关闭', async () => {
		const user = userEvent.setup();
		renderMenu();
		await user.click(trigger());
		expect(menu()).toBeInTheDocument();
		await user.keyboard('{Escape}');
		expect(menu()).not.toBeInTheDocument();
	});

	it('Tab 移焦离开触发钮时菜单关闭（鼠标开菜单场景）', async () => {
		const user = userEvent.setup();
		renderMenu();
		await user.click(trigger());
		expect(menu()).toBeInTheDocument();
		await user.tab();
		expect(menu()).not.toBeInTheDocument();
	});

	it('键盘开菜单后 Tab 关闭并放行走位', async () => {
		const user = userEvent.setup();
		renderMenu();
		trigger().focus();
		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
		await user.tab();
		expect(menu()).not.toBeInTheDocument();
	});

	it('外部点击关闭', async () => {
		const user = userEvent.setup();
		render(
			<div>
				<UserMenu user={USER} items={[{ key: 'logout', type: 'logout' }]} />
				<span data-testid="outside">outside</span>
			</div>,
		);
		await user.click(trigger());
		expect(menu()).toBeInTheDocument();
		fireEvent.mouseDown(screen.getByTestId('outside'));
		expect(menu()).not.toBeInTheDocument();
	});

	it('logout 恒排在末位（传入顺序无关）', async () => {
		const user = userEvent.setup();
		const onLogout = vi.fn();
		render(
			<UserMenu
				user={USER}
				items={[
					{ key: 'logout', type: 'logout', onClick: onLogout },
					{ key: 'settings', type: 'settings' },
				]}
			/>,
		);
		await user.click(trigger());
		const items = screen.getAllByRole('menuitem');
		expect(items[0]).toHaveTextContent('个人设置');
		expect(items[1]).toHaveTextContent('退出登录');
	});

	it('logout 点击回调执行一次且菜单关闭', async () => {
		const user = userEvent.setup();
		const { onLogout, onSettings } = renderMenu();
		await user.click(trigger());
		await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
		expect(onLogout).toHaveBeenCalledTimes(1);
		expect(onSettings).not.toHaveBeenCalled();
		expect(menu()).not.toBeInTheDocument();
	});

	it('内置中文默认文案', async () => {
		const user = userEvent.setup();
		renderMenu();
		await user.click(trigger());
		expect(screen.getByRole('menuitem', { name: '个人设置' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: '退出登录' })).toBeInTheDocument();
	});

	it('内置英文默认文案（language=en-US）', async () => {
		i18nState.language = 'en-US';
		const user = userEvent.setup();
		renderMenu();
		expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'User menu' }));
		expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
	});

	it('labels 覆盖生效', async () => {
		const user = userEvent.setup();
		renderMenu({ labels: { logout: '退出' } });
		await user.click(trigger());
		expect(screen.getByRole('menuitem', { name: '退出' })).toBeInTheDocument();
	});

	it('空用户兜底：显示未登录，退出仍可达', async () => {
		const user = userEvent.setup();
		render(<UserMenu user={null} items={[{ key: 'logout', type: 'logout' }]} />);
		expect(screen.getByText('未登录')).toBeInTheDocument();
		await user.click(trigger());
		expect(screen.getByRole('menuitem', { name: '退出登录' })).toBeInTheDocument();
	});

	it('href 型条目渲染为链接', async () => {
		const user = userEvent.setup();
		render(
			<UserMenu
				user={USER}
				items={[{ key: 'profile', type: 'profile', href: 'https://user.autional.cn/acme-corp/profile' }]}
			/>,
		);
		await user.click(trigger());
		const link = screen.getByRole('menuitem', { name: '个人资料' });
		expect(link).toHaveAttribute('href', 'https://user.autional.cn/acme-corp/profile');
	});

	it('displayName 优先展示：触发钮与面板头均取 displayName，邮箱退为次行', async () => {
		const user = userEvent.setup();
		renderMenu({
			user: { displayName: 'Demo Admin', username: 'demo-admin', email: 'demo-admin@demo.localhost' },
		});
		expect(screen.getByText('Demo Admin')).toBeInTheDocument();
		expect(screen.queryByText('demo-admin')).not.toBeInTheDocument();
		await user.click(trigger());
		// 面板头：displayName + email 次行
		expect(screen.getAllByText('Demo Admin')).toHaveLength(2);
		expect(screen.getByText('demo-admin@demo.localhost')).toBeInTheDocument();
	});

	it('displayName 为空白串时回落 username（既有链保持）', async () => {
		const user = userEvent.setup();
		renderMenu({ user: { displayName: '   ', username: 'acme_admin', email: 'a@b.c' } });
		expect(screen.getByText('acme_admin')).toBeInTheDocument();
	});

	// U447 类：头像 URL 打不开（404 / ORB）时禁止落碎图，必须回落首字母。
	it('头像 URL 加载失败时回落首字母', () => {
		const { container } = renderMenu({
			user: { username: 'acme_admin', avatarUrl: 'https://avatars.invalid/admin.png' },
		});
		const img = container.querySelector('img');
		expect(img).not.toBeNull();
		fireEvent.error(img!);
		expect(container.querySelector('img')).toBeNull();
		expect(screen.getByText('A')).toBeInTheDocument();
	});
});
