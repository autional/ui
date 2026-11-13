# 发布（npm / CDN / 站点）

> 一句话：**版本真源 = 各包 package.json + npm dist-tag；git tag 不是真源。**

## 1. 版本真源与命名空间

本仓是 monorepo，5 个包各自独立版本线（`ui` / `tokens` / `tailwind-preset` / `shared` / `eslint-config`）。

- 真源只有两处：包内 `package.json#version`，以及 npm 上的 dist-tag（`rc` / `latest`）。
- `v0.1.0-rc.N` 这类 **repo 级 tag 不再是版本标记**。历史上它们与包版本错位（rc.57/rc.58 打在 shared 的提交上，ui 的真实发版提交从未打 tag，偏差 30+ 提交）。
- 历史 tag **保留不删不改**（force 重打会让已克隆者不同步，且会再触发一次生产发布）。
- 若将来确需打标记，用 `<pkg>-v<version>`（例 `ui-v0.1.0-rc.58`）：不以 `v` 开头，不会被历史规则误触。

## 2. 发布怎么触发

| 面 | 触发 | 说明 |
|---|---|---|
| npm | 本机 `node scripts/publish-npm.mjs --tag rc`（经凭据包装器）或 GitHub `workflow_dispatch` | **不再**由 `v*` tag 触发 |
| CDN | 发布链内 `pnpm build:cdn` + 自动推 `autional/cdn` | 推 CDN 即触发 Vercel 生产部署 |
| 站点 | 人工：`pnpm bump:cdn --write` 后逐站提交 | 刻意不自动化（站点渲染需逐站视觉回归） |

本机发布前置：`npm-cred.ps1 test -Name publish` 确认凭据可用；token 不进 argv。

## 3. 发布步骤（本机，推荐）

1. 改代码 → 跑 `pnpm verify`（发布前用 `node scripts/verify.mjs --except publish,cdn`）。
2. 抬目标包 `package.json#version`（一次只抬真正变了的包）。
3. `node scripts/publish-npm.mjs --tag rc`（单入口：只发未上架版本、读回、dist-tag 对齐、一致性自证）。
4. `node scripts/check-publish.mjs --live` 复核。
5. 需要 CDN 面时：`pnpm build:cdn`，提交并推送 `../cdn`。
6. 抬消费方版本 → 逐站构建 + 视觉回归 → 提交。

## 4. 回滚

- npm：不可撤（已发布版本不能删除）。补救 = 发下一个版本，并把消费方钉回旧版本。
- 消费方回滚：`git revert` 抬版提交 + `pnpm install` + 重新构建。
- CDN：`git revert` cdn 仓的发布提交（Vercel 随之回退）。
