import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { LoadingScreen } from '../LoadingScreen';
import { EmptyState } from '../EmptyState';
import { ConfirmDialog } from '../ConfirmDialog';
import { Alert } from '../Alert';
import { ErrorState } from '../ErrorState';
import { UI_I18N_NS, registerUiI18n } from '../../i18n';

// 语言问题审计 2026-10-13 回归锁：五组件的默认文案此前是硬编码中文 ——
// EN 站裸露中文（trust 加载态「加载中...」线上实测、user 确认框「取消」等）。
// 修复后走与 Modal / ThemeToggle 同构的解析链：站点 i18next（可覆盖）→ 内置表（未注册）→ 硬编码兜底。

async function makeSiteI18n(lng: string, register = true): Promise<I18nInstance> {
	const instance = createInstance();
	await instance.init({
		resources: { 'zh-CN': { translation: {} }, 'en-US': { translation: {} } },
		lng,
		fallbackLng: 'zh-CN',
		keySeparator: false,
		interpolation: { escapeValue: false },
	});
	if (register) registerUiI18n(instance);
	return instance;
}

function renderWith(instance: I18nInstance, children: ReactNode) {
	return render(<I18nextProvider i18n={instance}>{children}</I18nextProvider>);
}

describe('LoadingScreen 默认文案（语言问题审计 2026-10-13）', () => {
	it('EN 站：默认文案为英文（此前硬编码「加载中...」）', async () => {
		renderWith(await makeSiteI18n('en-US'), <LoadingScreen />);
		expect(screen.getByText('Loading...')).toBeInTheDocument();
	});

	it('ZH 站：默认文案为中文（逐字保留原文）', async () => {
		renderWith(await makeSiteI18n('zh-CN'), <LoadingScreen />);
		expect(screen.getByText('加载中...')).toBeInTheDocument();
	});

	it('未注册站点按站点语言回落内置表', async () => {
		renderWith(await makeSiteI18n('en-US', false), <LoadingScreen />);
		expect(screen.getByText('Loading...')).toBeInTheDocument();
	});

	it('显式 message 参数优先', async () => {
		renderWith(await makeSiteI18n('en-US'), <LoadingScreen message="正在同步…" />);
		expect(screen.getByText('正在同步…')).toBeInTheDocument();
	});

	it('站点注册后可覆盖文案', async () => {
		const instance = await makeSiteI18n('en-US');
		instance.addResourceBundle('en-US', UI_I18N_NS, { 'loadingScreen.message': 'Fetching…' }, true, true);
		renderWith(instance, <LoadingScreen />);
		expect(screen.getByText('Fetching…')).toBeInTheDocument();
	});
});

describe('EmptyState 默认文案（语言问题审计 2026-10-13）', () => {
	it('EN 站：标题与说明为英文（此前硬编码「暂无数据」/「当前没有可显示的内容。」）', async () => {
		renderWith(await makeSiteI18n('en-US'), <EmptyState />);
		expect(screen.getByText('No data')).toBeInTheDocument();
		expect(screen.getByText('Nothing to display yet.')).toBeInTheDocument();
	});

	it('ZH 站：中文原文', async () => {
		renderWith(await makeSiteI18n('zh-CN'), <EmptyState />);
		expect(screen.getByText('暂无数据')).toBeInTheDocument();
		expect(screen.getByText('当前没有可显示的内容。')).toBeInTheDocument();
	});

	it('显式 title 参数优先（description 仍走解析链）', async () => {
		renderWith(await makeSiteI18n('en-US'), <EmptyState title="No results" />);
		expect(screen.getByText('No results')).toBeInTheDocument();
		expect(screen.getByText('Nothing to display yet.')).toBeInTheDocument();
	});
});

describe('ConfirmDialog 默认按钮文案（语言问题审计 2026-10-13）', () => {
	const baseProps = {
		open: true,
		title: 'T',
		description: 'D',
		onConfirm: () => {},
		onCancel: () => {},
	};

	it('EN 站：按钮与关闭标签为英文（此前硬编码「确认」/「取消」/「关闭」）', async () => {
		renderWith(await makeSiteI18n('en-US'), <ConfirmDialog {...baseProps} />);
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
	});

	it('ZH 站：中文原文', async () => {
		renderWith(await makeSiteI18n('zh-CN'), <ConfirmDialog {...baseProps} />);
		expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
	});

	it('显式 confirmText / cancelText 参数优先', async () => {
		renderWith(
			await makeSiteI18n('en-US'),
			<ConfirmDialog {...baseProps} confirmText="Delete" cancelText="Keep" />,
		);
		expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
	});
});

describe('ErrorState 默认文案（语言问题审计 2026-10-13 家族）', () => {
	it('EN 站：标题/描述/重试为英文（此前硬编码「加载失败」/「请稍后重试」/「重试」）', async () => {
		renderWith(await makeSiteI18n('en-US'), <ErrorState onRetry={() => {}} />);
		expect(screen.getByText('Failed to load')).toBeInTheDocument();
		expect(screen.getByText('Please try again later')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('ZH 站：中文原文', async () => {
		renderWith(await makeSiteI18n('zh-CN'), <ErrorState onRetry={() => {}} />);
		expect(screen.getByText('加载失败')).toBeInTheDocument();
		expect(screen.getByText('请稍后重试')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
	});

	it('未注册站点按站点语言回落内置表', async () => {
		renderWith(await makeSiteI18n('en-US', false), <ErrorState onRetry={() => {}} />);
		expect(screen.getByText('Failed to load')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('显式 title / description 优先，action 标签优先于默认重试', async () => {
		renderWith(
			await makeSiteI18n('en-US'),
			<ErrorState
				title="No results"
				description="Check the filters"
				action={{ label: 'Reload', onClick: () => {} }}
			/>,
		);
		expect(screen.getByText('No results')).toBeInTheDocument();
		expect(screen.getByText('Check the filters')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
	});
});

describe('Alert 关闭标签（语言问题审计 2026-10-13）', () => {
	it('EN 站：关闭按钮标签为英文（此前硬编码「关闭」）', async () => {
		renderWith(await makeSiteI18n('en-US'), <Alert closable>body</Alert>);
		expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
	});

	it('ZH 站：中文原文', async () => {
		renderWith(await makeSiteI18n('zh-CN'), <Alert closable>body</Alert>);
		expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
	});

	it('显式 closeLabel 参数优先', async () => {
		renderWith(await makeSiteI18n('en-US'), <Alert closable closeLabel="Dismiss">body</Alert>);
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
	});
});
