#!/usr/bin/env node
// 门户清单回潮门的**薄包装**：实现已移入 `packages/shared/src/portal/check-literals.mjs`，
// 以便随 `@autional/shared` 用 `bin` 分发（站点仓 `pnpm exec autional-check-portal-literals --root .`）。
//
// 保留本路径的原因：`scripts/verify.mjs` 的闸门命令是写死的，且本仓约定所有闸门在 `scripts/` 下可发现。
import '../packages/shared/src/portal/check-literals.mjs';
