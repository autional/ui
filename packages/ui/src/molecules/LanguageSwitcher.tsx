import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';

interface LanguageSwitcherProps {
	className?: string;
	labelEn?: string;
	labelZh?: string;
	showIcon?: boolean;
	currentLang?: string;
	onToggle?: (nextLang: string) => void;
}

export function LanguageSwitcher({
	className = '',
	labelEn,
	labelZh,
	showIcon = false,
	currentLang,
	onToggle,
}: LanguageSwitcherProps) {
	const { i18n } = useTranslation();
	const lang = currentLang ?? i18n.language;

	const toggle = () => {
		const next = lang === 'zh-CN' ? 'en-US' : 'zh-CN';
		if (onToggle) {
			onToggle(next);
		} else {
			i18n.changeLanguage(next);
		}
	};

	return (
		<button
			type="button"
			onClick={toggle}
			/* 命中盒（T49）：此前仅 text-xs ⇒ 实测 16.3×16；撑到 44px（横向留 px-1 保持视觉密度）。 */
			className={`inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-1 text-xs transition-colors ${className}`}
		>
			{showIcon && <Globe className="h-3.5 w-3.5 shrink-0" />}
			{lang === 'zh-CN' ? labelEn || 'EN' : labelZh || '中文'}
		</button>
	);
}
