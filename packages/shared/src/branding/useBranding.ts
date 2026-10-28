'use client';

import { useLayoutEffect, useRef } from 'react';
import { useTenantSlugFromUrl } from '../auth/slug-from-url';
import { deriveDarkColor, deriveDarkHover, deriveTextColor, hexToTriplet, pickOnColor } from './brand-color';
import { readCachedBranding } from './branding-cache';
import { useTenantBrandingStore } from './tenant-store';

/** 品牌注入的 8 个 CSS 变量（与 auth 站同口径，tokens.css 提供缺省值）。 */
const BRAND_VARS = [
	'--color-brand-base',
	'--color-brand-hover-base',
	'--color-brand-dark',
	'--color-brand-dark-hover',
	'--color-brand-text-base',
	'--color-on-brand-base',
	'--color-on-brand',
	'--color-on-brand-dark',
];

/** 写一个色变量及其 `-rgb` 通道三元组——Tailwind alpha 修饰符（text-brand/60）走
 *  `rgb(var(--color-X-rgb) / a)`，只写 hex 会让品牌租户的透明度色整条丢失。
 *  非法非 hex 值：写原值但不写三元组（回落 tokens.css 缺省），避免残留上个租户的通道。 */
function setColorVar(root: HTMLElement, name: string, value: string): void {
	root.style.setProperty(name, value);
	const triplet = hexToTriplet(value);
	if (triplet) root.style.setProperty(`${name}-rgb`, triplet);
	else root.style.removeProperty(`${name}-rgb`);
}

export function applyBrandColors(color: string, darkOverride?: string): void {
	const root = document.documentElement;
	if (!color) {
		BRAND_VARS.forEach((v) => {
			root.style.removeProperty(v);
			root.style.removeProperty(`${v}-rgb`);
		});
		return;
	}
	const dark = darkOverride || deriveDarkColor(color);
	setColorVar(root, '--color-brand-base', color);
	setColorVar(root, '--color-brand-hover-base', color);
	setColorVar(root, '--color-brand-dark', dark);
	setColorVar(root, '--color-brand-dark-hover', deriveDarkHover(color));
	// 品牌色作文本的安全派生值（AUTH-05）：text-brand-text 消费——浅底不达标即压暗
	setColorVar(root, '--color-brand-text-base', deriveTextColor(color));
	setColorVar(root, '--color-on-brand-base', pickOnColor(color));
	setColorVar(root, '--color-on-brand-dark', pickOnColor(dark));
}

export interface UseBrandingOptions {
	/** 是否注入租户自定义 CSS；默认 true。认证器/验证码页应传 false。 */
	applyCustomCss?: boolean;
}

/**
 * 把当前租户品牌落到 DOM（CSS 变量 / favicon / customCss）。
 * 需与 `<BrandingInitializer/>` 同时挂载：前者负责写 store，这里负责呈现。
 */
export function useBranding(options?: UseBrandingOptions): void {
	const applyCustomCss = options?.applyCustomCss ?? true;
	const branding = useTenantBrandingStore((s) => s.branding);
	const slug = useTenantSlugFromUrl();
	const styleRef = useRef<HTMLStyleElement | null>(null);
	const primedSlugRef = useRef<string | null>(null);

	// 首帧前用缓存上色，避免默认品牌色闪一下
	useLayoutEffect(() => {
		if (!slug || primedSlugRef.current === slug) return;
		primedSlugRef.current = slug;
		const cached = readCachedBranding(slug);
		applyBrandColors(cached?.primaryColor ?? '', cached?.primaryColorDark);
	}, [slug]);

	useLayoutEffect(() => {
		if (!branding) {
			applyBrandColors('');
			return;
		}

		applyBrandColors(branding.primaryColor, branding.primaryColorDark);

		if (branding.faviconUrl) {
			let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
			if (!favicon) {
				favicon = document.createElement('link');
				favicon.rel = 'icon';
				document.head.appendChild(favicon);
			}
			favicon.href = branding.faviconUrl;
		}

		if (branding.customCss && applyCustomCss) {
			if (!styleRef.current) {
				styleRef.current = document.createElement('style');
				styleRef.current.setAttribute('data-tenant-css', '');
				document.head.appendChild(styleRef.current);
			}
			styleRef.current.textContent = branding.customCss;
		} else if (styleRef.current) {
			styleRef.current.textContent = '';
			styleRef.current.remove();
			styleRef.current = null;
		}

		return () => {
			applyBrandColors('');
			if (styleRef.current) {
				styleRef.current.textContent = '';
				styleRef.current.remove();
				styleRef.current = null;
			}
		};
	}, [branding, applyCustomCss]);
}
