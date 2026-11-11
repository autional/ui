import { describe, expect, it } from 'vitest';
import { decodeJwtPayload } from '@autional/shared/jwt';
import { generatePKCE } from '@autional/shared/pkce';

/**
 * 子路径导出的意义：站点（配置中心/密钥中心）要复用 JWT 解码与 PKCE，
 * 但不该为此引入整包 index（axios/react-query/zustand/生成类型 130 个模块）。
 * 这两个模块都零 import。
 */
describe('@autional/shared 的 /jwt 与 /pkce 子路径', () => {
	it('/jwt 解 base64url 载荷（含 -/_ 归一）', () => {
		// {"sub":"u1","exp":4102444800,"tenant_id":"t-1"} —— 用 base64url（含 -/_）编码
		const payload = decodeJwtPayload(
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsImV4cCI6NDEwMjQ0NDgwMCwidGVuYW50X2lkIjoidC0xIn0.sig',
		);
		expect(payload).toMatchObject({ sub: 'u1', tenant_id: 't-1' });
	});

	it('/jwt 对坏输入返回 null（不抛）', () => {
		expect(decodeJwtPayload('not-a-jwt')).toBeNull();
	});

	it('/pkce 生成 RFC 7636 的 verifier/challenge 对', async () => {
		const pair = await generatePKCE();
		// verifier ∈ 43–128 字符、字符集 A-Za-z0-9-._~
		expect(pair.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
		// S256 challenge = base64url(sha256(verifier))，固定 43 字符
		expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const another = await generatePKCE();
		expect(another.verifier).not.toBe(pair.verifier);
	});

	it('两个模块都不引入运行时依赖（源码级断言）', async () => {
		const fs = await import('node:fs/promises');
		for (const rel of ['../jwt-payload.ts', '../pkce.ts']) {
			const src = await fs.readFile(new URL(rel, import.meta.url), 'utf8');
			const imports = src
				.split(/\r?\n/)
				.filter((line) => /^\s*import\s/.test(line) || /^\s*\} from\s+['"]/.test(line));
			expect(imports, rel).toEqual([]);
		}
	});
});
