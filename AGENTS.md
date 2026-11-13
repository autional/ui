# @autional/ui 仓 · AGENTS.md（agent 入口）

> 只放**强制项与指针**；细则见 `docs/RELEASING.md`（发布口径）与 `DESIGN.md`（设计规范）。

## 发版纪律（强制）

- **版本真源 = 各包 `package.json#version` + npm dist-tag**。**git tag 不是真源**，也不要再用它标记版本。
- **禁推 `v*` 前缀 tag**：本仓 `release.yml` 历史上由 `on: push: tags: ['v*']` 触发，一次 tag push 会跑完整
  发布链（publish-npm → build:cdn → 推 `autional/cdn` → Vercel 生产部署）。现在触发只剩 `workflow_dispatch`。
  确需标记用 `<pkg>-v<version>`（例 `ui-v0.1.0-rc.58`）。仓内 `.githooks/pre-push` 会拦 `refs/tags/v*`
  （首次克隆需 `git config core.hooksPath .githooks`；临时放行 `AUTIONAL_ALLOW_TAG_PUSH=1`）。
- **只走单一入口** `node scripts/publish-npm.mjs --tag rc`；禁 `pnpm -r publish`（对已上架版本会直接冲突退出）。
- 发布前 `node scripts/verify.mjs --except publish,cdn`（publish/cdn 两项在发布前按定义为红，正是要变绿的）。
- 抬消费方后**逐站构建 + 视觉回归**再提交；`bump:cdn --write` 与站点提交不自动化。

## 焦点与可达性（2026-11-13）

- 焦点环只有一个来源：tokens 的 `:focus-visible`（2px outline + 2px offset + `--focus-ring-color`）。
  组件里**不要再自绘 `ring-2`**，也不要在可交互元素上留裸 `outline-none`（会压掉基线）；
  回归锁见 `packages/ui/src/atoms/__tests__/focus-ring.test.tsx`。
