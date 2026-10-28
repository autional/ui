import { useEffect, useState } from 'react';

/**
 * 头像/图标位统一显示件。
 *
 * 承载两类资源：用户头像、应用/租户 logo。核心约束只有一条 ——
 * **URL 打不开时必须回落**，而不是把浏览器的碎图标直接落屏：
 * - 无 `src` → 直接渲染回落（文本首字母或自定义节点）；
 * - `<img>` 触发 `onError`（404、DNS 失败、ORB 拦截等）→ 切到回落；
 * - `src` 变化 → 重置失败标记（换头像后重新尝试）。
 *
 * 2026-10-28：此前四处 `<img src={avatarUrl}>` 都没有 onError，
 * 一条死链（`avatars.autional.tianv.mobi/admin.png`）会在多个门户显示碎图。
 */
export interface AvatarProps {
	/** 图片地址；空值或加载失败时回落 */
	src?: string | null;
	/** 回落文本：原样显示（通常已由调用方取好首字母） */
	fallbackText?: string | null;
	/** 自定义回落节点，优先于 fallbackText */
	fallback?: React.ReactNode;
	/** 像素尺寸，默认 32 */
	size?: number;
	/** 形状，默认圆形 */
	shape?: 'circle' | 'square';
	/** 图片替代文本；空串表示装饰性图片（同时标记 aria-hidden） */
	alt?: string;
	/** 根节点/图片追加类名（回落背景与文字色由调用方给） */
	className?: string;
	/** 仅图片追加类名 */
	imgClassName?: string;
	/** 图片 referrer 策略；第三方图片（OAuth 客户端图标、租户 Logo）应传 no-referrer */
	referrerPolicy?: React.HTMLAttributeReferrerPolicy;
}

export function Avatar({
	src,
	fallbackText,
	fallback,
	size = 32,
	shape = 'circle',
	alt = '',
	className = '',
	imgClassName = '',
	referrerPolicy,
}: AvatarProps) {
	const [broken, setBroken] = useState(false);

	useEffect(() => {
		setBroken(false);
	}, [src]);

	const radius = shape === 'circle' ? 'rounded-full' : 'rounded-md';
	const deco = alt ? undefined : true;

	if (src && !broken) {
		return (
			<img
				src={src}
				alt={alt}
				aria-hidden={deco}
				width={size}
				height={size}
				loading="lazy"
				decoding="async"
				referrerPolicy={referrerPolicy}
				onError={() => setBroken(true)}
				className={`shrink-0 object-cover ${radius} ${imgClassName} ${className}`}
				style={{ width: size, height: size }}
			/>
		);
	}

	const content = fallback ?? (fallbackText ? fallbackText[0]!.toUpperCase() : '?');
	return (
		<span
			aria-hidden={deco}
			className={`flex shrink-0 items-center justify-center overflow-hidden font-medium ${radius} ${className}`}
			style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
		>
			{content}
		</span>
	);
}

export default Avatar;
