#!/usr/bin/env node
/**
 * CLI 自举入口。
 *
 * `src/*.ts` 遵循仓库的 NodeNext 约定：import 写 `.js` 后缀，实际文件是 `.ts`。
 * Node 原生的 type stripping 不做这层重写，所以先注册 resolve hook，
 * 再动态引入真正的入口——这样使用者不必记得 `--import ./ts-resolve.mjs`。
 */

// shared 公开入口包含 parameter property，Node strip-only 不支持；使用已有本地 tsx。
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
