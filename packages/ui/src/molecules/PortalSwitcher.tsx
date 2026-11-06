import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
	Activity,
	Check,
	Code2,
	Globe,
	KeyRound,
	KeySquare,
	LayoutGrid,
	LogIn,
	Settings,
	Shield,
	ShieldAlert,
	ShieldCheck,
	User,
} from 'lucide-react';
import { useMenuButton } from '../internal/use-menu-button';
import { UI_I18N_NS, uiText } from '../i18n';

export interface PortalLink {
	code: string;
	name?: string;
	url: string;
	description?: string;
	icon?: React.ReactNode;
}

export interface PortalSwitcherLabels {
	switchPortal: string;
}

export interface PortalSwitcherProps {
	portals: PortalLink[];
	currentPortal?: string;
	align?: 'left' | 'right';
	className?: string;
	menuClassName?: string;
	labels?: Partial<PortalSwitcherLabels>;
	loading?: boolean;
	/** 单产品隐藏（Gainsight 规则）：≤1 个门户时不渲染 */
	hideWhenSingle?: boolean;
	iconForPortal?: Record<string, React.ComponentType<{ className?: string }>>;
}

const DEFAULT_PORTAL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
	admin: Shield,
	auth: LogIn,
	security: ShieldAlert,
	user: User,
	authenticator: KeyRound,
	status: Activity,
	trust: ShieldCheck,
	platform: Settings,
	developer: Code2,
	landing: Globe,
	secret: KeySquare,
};

export function PortalSwitcher({
	portals,
	currentPortal,
	align = 'right',
	className = '',
	menuClassName = '',
	labels,
	loading = false,
	hideWhenSingle = true,
	iconForPortal,
}: PortalSwitcherProps) {
	const { t, i18n } = useTranslation();
	const { open, setOpen, triggerRef, menuRef, triggerProps, menuProps } = useMenuButton();

	if (!loading && hideWhenSingle && portals.length < 2) return null;

	const icons = { ...DEFAULT_PORTAL_ICONS, ...iconForPortal };
	// 文案解析链：站点 i18next（注册 registerUiI18n 后，可覆盖/扩语言）→ 内置表（未注册）→ lastResort
	const text = (key: string, lastResort?: string): string => {
		const builtin = uiText(i18n.language, key);
		return t(key, { ns: UI_I18N_NS, defaultValue: builtin ?? lastResort ?? key });
	};
	const switchLabel = labels?.switchPortal ?? text('portal.switcher');

	return (
		<div className="relative">
			<button
				{...triggerProps}
				ref={triggerRef}
				aria-label={switchLabel}
				title={switchLabel}
				disabled={loading}
				aria-busy={loading || undefined}
				className={`rounded-md p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:opacity-50 ${className}`}
			>
				<LayoutGrid className="h-5 w-5 shrink-0" />
			</button>
			{open && (
				<div
					{...menuProps}
					ref={menuRef}
					className={`absolute top-full z-50 mt-2 w-56 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] py-1 shadow-brand ${
						align === 'left' ? 'left-0' : 'right-0'
					} ${menuClassName}`}
				>
					{portals.map((portal) => {
						const Icon = icons[portal.code] ?? Globe;
						const isCurrent = portal.code === currentPortal;
						return (
							<a
								key={portal.code}
								role="menuitem"
								tabIndex={-1}
								href={portal.url}
								aria-current={isCurrent || undefined}
								className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
									isCurrent
										? 'bg-[var(--color-bg-muted)] text-[var(--color-text-primary)]'
										: 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-muted)]'
								}`}
								onClick={isCurrent ? (event) => { event.preventDefault(); setOpen(false); } : () => setOpen(false)}
							>
								{portal.icon ?? <Icon className="h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />}
								<span className="flex-1 truncate">
									{text(`portal.names.${portal.code}`, portal.name ?? portal.code)}
								</span>
								{isCurrent && <Check className="h-4 w-4 shrink-0 text-[var(--color-brand)]" />}
							</a>
						);
					})}
				</div>
			)}
		</div>
	);
}
