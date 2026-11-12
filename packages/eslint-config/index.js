// @autional/eslint-config —— 全舰队共享的 ESLint flat config。
//
// 为什么要有它：2026-10-04 实测，四个在册门户的 package.json 里都写着 "lint": "eslint src/"，
// 但**全舰队没有一份 ESLint 配置、也没有任何一处把 eslint 声明成依赖** ——
// `pnpm exec eslint` 解析到的是上层目录里**别的项目**装的那一份（D:\\deepseek-harness\\node_modules\\...），
// 再因为找不到配置而以 2 退出。也就是说这条命令从来没在本仓跑过，它只是一个名字。
//
// 与 @autional/tsconfig 同一个形状：**规则只有一个来源**，站点那边只留三行。
//
// ── 为什么首次引入不用「全 error」 ──────────────────────────────────────
// 首轮实测（recommended 全家桶）：四个门户共 1156 条，其中
//   @typescript-eslint/no-explicit-any   819
//   @typescript-eslint/no-unused-vars    328
//   react-hooks/exhaustive-deps            9
// 把 1156 条一次性变成红，唯一的现实结果是所有人学会加 eslint-disable ——
// 那比没有 lint 更糟（注释会被当成豁免，而豁免是不受审计的）。
// 所以按舰队一路用的**登记制**：这两条先降为 warn 并由闸门棘轮看着（只许减不许增），
// 其余 recommended 规则**保持 error** —— 那部分才是真正会抓到新 bug 的（no-undef / no-unreachable /
// no-dupe-keys / no-cond-assign…）。闸门要求 error **必须为 0**，warn 不得超过台账。
//
// 降为 warn 的两条都有明确理由，不是「太吵了就关掉」：
//   · no-explicit-any —— any 在本仓有既成用法（antd 泛型、测试替身），且它**不是正确性问题**；
//   · no-unused-vars —— 大量命中来自「解构剔除」这一写法（const { a, b, ...rest } = x），
//     那是有意的，靠 ignoreRestSiblings 放行之后剩下的才是真死代码。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

// jsx-a11y recommended 的「降级为 warn」版本。
// 关键：只把 **error → warn**，插件自己设成 off 的规则（如已废弃的 label-has-for）保持 off ——
// 一律改成 warn 会把插件主动关掉的规则重新点亮（实测：试过一次，试点仓凭空多出 4 条告警，
// 与试点自己跑出的 0 条对不上，等于两个口径打架）。
const a11yRecommendedAtWarn = Object.fromEntries(
	Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, sev]) => {
		const first = Array.isArray(sev) ? sev[0] : sev;
		const isError = first === 'error' || first === 2;
		if (!isError) {
			return [rule, sev]; // off / warn 原样保留
		}
		// 降级时必须保留选项：直接写 'warn' 会把 [2, {options}] 变成裸 warn，
		// 规则退回默认配置 —— 实测踩到：no-noninteractive-element-interactions 丢掉了
		// {img:['onError','onLoad']} 白名单，凭空报出 1 条假红。
		return [rule, Array.isArray(sev) ? ['warn', ...sev.slice(1)] : 'warn'];
	}),
);

export default tseslint.config(
	{
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/public/**',
			'**/coverage/**',
			'**/storybook-static/**',
			'**/*.config.js',
			'**/*.config.mjs',
			'**/*.config.ts',
			'**/*.d.ts',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
		// flat config 里插件必须显式登记：只写 rules 里的 'react-hooks/…' 而不注册插件，
		// ESLint 会把它当成「规则不存在」并**报成 error**（实测踩到 —— 5+3 条假红）。
		plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
		languageOptions: {
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
		rules: {
			// TS 自己就能判未定义标识符，交给它；开着重叠报错只会制造噪音
			'no-undef': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrors: 'none',
					// 解构剔除（const { a, ...rest } = x）是有意写法，不该算未使用
					ignoreRestSiblings: true,
				},
			],
			// React 的两条只开经典的两条，**不整包引 recommended**：
			// 插件 v7 的 recommended 里还有一长串新规则（set-state-in-effect / purity / immutability…），
			// 一次性全开会把「引入 lint」变成「引入一次重构」。rules-of-hooks 是能抓到真 bug 的那条，留在 error；
			// exhaustive-deps 按插件自己的传统是 warn —— 而且本仓已经有 8 处
			// `// eslint-disable-next-line react-hooks/exhaustive-deps` 注释（在插件缺席的年代写的，
			// 那时它只会报「规则不存在」；装上插件之后这些注释才真正开始起作用）。
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',

			// ── 无障碍（AC C-28 / ui-denominator G5·G6，2026-11-12 引入）──────────────
			// 为什么是 warn 而不是 error：这类规则在每个仓的**存量**不同（试点 admin-console
			// 首次全量实测 11 条，全部是「链接/卡片当按钮用」，已在本仓修掉；其余 11 个 app 未测）。
			// 按舰队既有登记制：先把规则点亮（warn 有输出、可棘轮、可统计），各仓清到 0 后再转 error；
			// 试点仓 admin-console 已用 `eslint.a11y.config.mjs` 以 **error + --max-warnings 0** 独立门禁，
			// 所以舰队里"有没有 a11y 闸门"这件事不依赖本行是 warn 还是 error。
			// 转 error 的条件（写死在这里防遗忘）：任一仓 lint 输出 jsx-a11y 命中 = 0 且连续两个发布周期无回归。
			...a11yRecommendedAtWarn,
		},
	},
	{
		// 测试与 story 里 any 是正常工具（造替身、造边界数据）
		files: ['**/__tests__/**', '**/*.test.*', '**/*.stories.*', '**/test/**'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
);
