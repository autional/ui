import React from 'react';

interface ToggleProps {
	checked: boolean;
	onChange: () => void;
	disabled?: boolean;
	size?: 'sm' | 'md';
	className?: string;
	/** 开关的可访问名（屏幕阅读器朗读）。用 `ariaLabelledBy` 指向外部标题时可不填。 */
	ariaLabel?: string;
	/** 指向可见标签元素 id，优先级高于 `ariaLabel`。 */
	ariaLabelledBy?: string;
}

const sizeClasses: Record<string, { track: string; circle: string; translate: string }> = {
	md: { track: 'h-6 w-11', circle: 'h-5 w-5', translate: 'translate-x-5' },
	sm: { track: 'h-5 w-9', circle: 'h-4 w-4', translate: 'translate-x-4' },
};

export const Toggle = React.memo(function Toggle({
	checked,
	onChange,
	disabled = false,
	size = 'md',
	className = '',
	ariaLabel,
	ariaLabelledBy,
}: ToggleProps) {
	const s = sizeClasses[size];

	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabelledBy ? undefined : ariaLabel}
			aria-labelledby={ariaLabelledBy}
			disabled={disabled}
			onClick={onChange}
			className={`relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring-color)] disabled:pointer-events-none disabled:opacity-50 ${
				checked ? 'bg-primary-600' : 'bg-neutral-200 dark:bg-neutral-600'
			} ${s.track} ${className}`}
		>
			<span
				className={`inline-block rounded-full bg-white shadow-soft transition-transform ${
					checked ? s.translate : 'translate-x-0.5'
				} ${s.circle}`}
			/>
		</button>
	);
});
