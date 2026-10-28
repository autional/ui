import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-react';
import { useMenuButton } from '../internal/use-menu-button';
import { Avatar } from '../atoms/Avatar';

export interface UserMenuUserInfo {
	displayName?: string | null;
	username?: string | null;
	email?: string | null;
	avatarUrl?: string | null;
}

export interface UserMenuItemSpec {
	key: string;
	type?: 'settings' | 'profile' | 'logout' | 'custom';
	label?: string;
	icon?: React.ReactNode;
	href?: string;
	onClick?: () => void;
	danger?: boolean;
}

export interface UserMenuLabels {
	settings: string;
	profile: string;
	logout: string;
	userMenu: string;
	emptyUser: string;
}

export interface UserMenuProps {
	user?: UserMenuUserInfo | null;
	items: UserMenuItemSpec[];
	align?: 'left' | 'right';
	className?: string;
	nameClassName?: string;
	menuClassName?: string;
	labels?: Partial<UserMenuLabels>;
}

export function deriveUserInitials(user?: UserMenuUserInfo | null): string {
	const source =
		user?.displayName?.trim() || user?.username?.trim() || user?.email?.trim() || '';
	return source ? source[0]!.toUpperCase() : 'U';
}

const ITEM_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
	settings: Settings,
	profile: UserRound,
	logout: LogOut,
};

export function UserMenu({
	user,
	items,
	align = 'right',
	className = '',
	nameClassName = '',
	menuClassName = '',
	labels,
}: UserMenuProps) {
	const { i18n } = useTranslation();
	const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
	const defaults: UserMenuLabels = {
		settings: isZh ? '个人设置' : 'Settings',
		profile: isZh ? '个人资料' : 'Profile',
		logout: isZh ? '退出登录' : 'Log out',
		userMenu: isZh ? '用户菜单' : 'User menu',
		emptyUser: isZh ? '未登录' : 'Not signed in',
	};
	const text: UserMenuLabels = { ...defaults, ...labels };

	const { open, setOpen, triggerRef, menuRef, triggerProps, menuProps } = useMenuButton();

	const displayName =
		user?.displayName?.trim() || user?.username?.trim() || user?.email?.trim() || text.emptyUser;
	const initials = deriveUserInitials(user);
	// 统一口径：退出登录恒在末位（APG/NN-g 惯例），其余保持调用方顺序
	const ordered = [...items].sort(
		(a, b) => Number(a.type === 'logout') - Number(b.type === 'logout'),
	);

	const activate = (item: UserMenuItemSpec) => {
		setOpen(false);
		item.onClick?.();
	};

	return (
		<div className="relative">
			<button
				{...triggerProps}
				ref={triggerRef}
				aria-label={text.userMenu}
				className={`flex items-center gap-2 rounded-md p-1.5 transition-colors hover:bg-[var(--color-bg-muted)] ${className}`}
			>
				<Avatar
					src={user?.avatarUrl}
					fallbackText={initials}
					size={32}
					className="bg-[var(--color-brand)] text-xs font-medium text-[var(--color-text-inverse)]"
				/>
				<span
					className={`max-w-[10rem] truncate text-sm text-[var(--color-text-primary)] ${nameClassName}`}
				>
					{displayName}
				</span>
				<ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
			</button>
			{open && (
				<div
					{...menuProps}
					ref={menuRef}
					className={`absolute top-full z-50 mt-2 w-56 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] py-1 shadow-brand ${
						align === 'left' ? 'left-0' : 'right-0'
					} ${menuClassName}`}
				>
					<div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
						<div className="truncate text-sm font-medium text-[var(--color-text-primary)]">
							{displayName}
						</div>
						{user?.email && (
							<div className="truncate text-xs text-[var(--color-text-muted)]">{user.email}</div>
						)}
					</div>
					{ordered.map((item) => {
						const Icon = ITEM_ICONS[item.type ?? ''] ?? null;
						const danger = item.danger ?? item.type === 'logout';
						const itemClass = `flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
							danger
								? 'text-[var(--color-danger-text)] hover:bg-[var(--color-danger-soft)]'
								: 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-muted)]'
						}`;
						const content = (
							<>
								{item.icon ?? (Icon ? <Icon className="h-4 w-4 shrink-0" /> : null)}
								<span className="truncate">{item.label ?? text[item.type as keyof UserMenuLabels] ?? item.key}</span>
							</>
						);
						return item.href ? (
							<a
								key={item.key}
								role="menuitem"
								tabIndex={-1}
								href={item.href}
								className={itemClass}
								onClick={() => activate(item)}
							>
								{content}
							</a>
						) : (
							<button
								key={item.key}
								role="menuitem"
								tabIndex={-1}
								type="button"
								className={itemClass}
								onClick={() => activate(item)}
							>
								{content}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
