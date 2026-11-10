// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	configureAuthStore,
	getAuthStore,
	getAuthStorageMode,
	resetAuthStore,
	useAuthStore,
} from '../store';
import { createAuthStore, resolveAuthStorage } from '../create-auth-store';

const KEY = 'autional-auth-v1';

const USER = {
	id: 'usr_1',
	username: 'demo',
	email: 'demo@example.com',
	status: 'active',
} as never;

function clearAll() {
	window.localStorage.clear();
	window.sessionStorage.clear();
	resetAuthStore();
}

describe('createAuthStore —— 存储位置可选', () => {
	beforeEach(() => {
		clearAll();
	});

	it('默认写 localStorage（既有 9 个消费方行为不变）', () => {
		const store = createAuthStore();
		store.getState().setAuth('access-1', 'refresh-1', USER);

		expect(window.localStorage.getItem(KEY)).toContain('access-1');
		expect(window.sessionStorage.getItem(KEY)).toBeNull();
	});

	it("storage: 'session' 只写 sessionStorage（配置中心安全取舍）", () => {
		const store = createAuthStore({ storage: 'session' });
		store.getState().setAuth('access-2', 'refresh-2', USER);

		expect(window.sessionStorage.getItem(KEY)).toContain('access-2');
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});

	it('自定义 name 不污染默认键', () => {
		const store = createAuthStore({ storage: 'session', name: 'x-auth-v1' });
		store.getState().setAuth('access-3', 'r', USER);

		expect(window.sessionStorage.getItem('x-auth-v1')).toContain('access-3');
		expect(window.sessionStorage.getItem(KEY)).toBeNull();
	});

	it('clearAuth 从所选存储中移除持久化数据', () => {
		const store = createAuthStore({ storage: 'session' });
		store.getState().setAuth('access-4', 'r', USER);
		store.getState().clearAuth();

		const raw = window.sessionStorage.getItem(KEY) ?? '';
		expect(raw).not.toContain('access-4');
		expect(store.getState().isAuthenticated).toBe(false);
	});

	it('持久化内容可被同 storage 的新实例回灌', () => {
		const first = createAuthStore({ storage: 'local' });
		first.getState().setAuth('access-5', 'refresh-5', USER);

		const second = createAuthStore({ storage: 'local' });
		expect(second.getState().accessToken).toBe('access-5');
		expect(second.getState().isAuthenticated).toBe(true);
	});

	it('存储不可用（getItem/setItem 抛错）不崩，退化为内存', () => {
		const broken = resolveAuthStorage('local');
		const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		try {
			expect(() => broken.setItem('k', 'v')).not.toThrow();
			expect(() => broken.getItem('k')).not.toThrow();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('configureAuthStore —— 惰性单例', () => {
	beforeEach(() => {
		clearAll();
	});

	it('幂等：重复调用返回同一实例', () => {
		const a = configureAuthStore({ storage: 'session' });
		const b = configureAuthStore({ storage: 'session' });
		expect(a).toBe(b);
		expect(getAuthStore()).toBe(a);
	});

	it("configure 在首次访问前生效：storage = 'session'", () => {
		configureAuthStore({ storage: 'session' });
		expect(getAuthStorageMode()).toBe('session');
		useAuthStore.getState().setAuth('access-6', 'r', USER);

		expect(window.sessionStorage.getItem(KEY)).toContain('access-6');
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});

	it('未 configure ⇒ 默认 local（不是 session）', () => {
		expect(getAuthStorageMode()).toBe('local');
		getAuthStore().getState().setAuth('access-7', 'r', USER);
		expect(window.localStorage.getItem(KEY)).toContain('access-7');
	});

	it('导入 store 模块不提前建实例（否则先 configure 也会退化为 local）', async () => {
		vi.resetModules();
		// 模拟站点入口顺序：先 import（不得有副作用），再 configure，再写入
		const fresh = await import('../store');
		fresh.configureAuthStore({ storage: 'session' });
		fresh.useAuthStore.getState().setAuth('access-early', 'r', USER);

		expect(fresh.getAuthStorageMode()).toBe('session');
		expect(window.sessionStorage.getItem(KEY)).toContain('access-early');
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});

	it('persist API 透传是惰性的（取用才建实例，不在模块求值期求值）', async () => {
		vi.resetModules();
		const fresh = await import('../store');
		// 访问 persist 之前不得创建实例：configure 仍应生效
		expect(typeof Object.getOwnPropertyDescriptor(fresh.useAuthStore, 'persist')?.get).toBe('function');
		fresh.configureAuthStore({ storage: 'session' });
		const persist = (fresh.useAuthStore as unknown as { persist?: { rehydrate?: unknown } }).persist;
		expect(persist).toBeTruthy();
		expect(fresh.getAuthStorageMode()).toBe('session');
	});

	it('兼容旧调用点：hook 形状 + getState/setState 静态方法都可用', () => {
		useAuthStore.setState({ accessToken: 'access-8' });
		expect(useAuthStore.getState().accessToken).toBe('access-8');
		expect(typeof useAuthStore.subscribe).toBe('function');
	});
});
