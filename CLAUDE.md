# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AIGC 创作平台 —— 基于 AI 的图片/视频生成、画布编辑、数字人制作的全栈 SaaS 应用。

**包管理器**: pnpm 10（必须用 pnpm，不要用 npm/yarn）  
**构建编排**: Turborepo  
**Node 版本**: >= 20.0.0

---

## 常用命令

### 开发

```bash
# 启动所有服务（并行）
pnpm dev

# 单独启动某个应用
pnpm --filter @aigc/web dev       # 前端 :6006
pnpm --filter @aigc/api dev       # API  :7001
pnpm --filter @aigc/worker dev    # Worker

# 启动本地基础设施（PostgreSQL / Redis / MinIO）
docker-compose up -d

docker-compose up -d --build --force-recreate
```

### 构建 & Lint

```bash
pnpm build          # 全量构建
pnpm lint           # 全量 lint
pnpm --filter @aigc/web build     # 单独构建前端
```

### 数据库

```bash
pnpm db:migrate     # 执行迁移
pnpm db:seed        # 填充种子数据
```

### E2E 测试（前端）

```bash
pnpm --filter @aigc/web test:e2e        # 无头运行
pnpm --filter @aigc/web test:e2e:ui     # 带 UI 运行
```

---

## Monorepo 架构

```
apps/
  api/      — Fastify 4 REST API（端口 7001）
  web/      — Next.js 14 App Router 前端（端口 6006）
  worker/   — BullMQ 后台任务处理
  docs/     — Nextra 文档站
packages/
  db/       — Kysely schema、迁移脚本、种子数据
  types/    — 跨应用共享 TypeScript 类型
```

---

## 各应用职责

### `apps/api`

- **框架**: Fastify 4 + TypeScript（ESM）
- **认证**: JWT（`plugins/` 中的守卫插件）
- **路由**: `routes/` 下按业务模块拆分（auth、generate、canvas、video-studio、payment 等 20+ 模块）
- **业务逻辑**: `services/`（积分、提示词过滤、合并导出）
- **工具库**: `lib/`（storage、queue、credits、sanitize）
- **队列**: BullMQ + Redis，任务投递给 worker

### `apps/web`

- **框架**: Next.js 14 App Router
- **路由组**:
  - `(auth)/` — 登录、SSO、邀请
  - `(dashboard)/` — 主功能区（generation、canvas、video-studio、assets、history、admin、team、credits、settings）
  - `payment/` — 支付回调
- **状态管理**: Zustand 5（`stores/`），画布支持 undo/redo（Zundo）
- **数据请求**: SWR
- **API 代理**: Next.js rewrites 将 `/api/*` 转发到 `INTERNAL_API_URL`（默认 `http://localhost:7001`）

### `apps/worker`

- **消费者**: `workers/`（BullMQ）
- **定时任务**: `jobs/`（purge、timeout-guardian）
- **处理管线**: `pipelines/`
- **外部服务适配器**: `adapters/`（火山引擎、Gemini 等）

### `packages/db`

- Kysely + pg，PostgreSQL 15
- 所有 schema 变更通过迁移脚本管理，不直接修改 schema 文件

### `packages/types`

- 跨应用共享类型：adapter、api、db、queue
- 修改此包后需重新构建依赖它的应用

---

## 技术栈关键点

| 层级 | 技术 |
|------|------|
| 前端框架 | Next.js 14 App Router + React 18 |
| 样式 | Tailwind CSS 3 + tailwindcss-animate |
| UI 组件 | Radix UI |
| 画布 | ReactFlow |
| 动画 | Framer Motion |
| 后端框架 | Fastify 4 |
| ORM/查询 | Kysely（类型安全，无 ORM 魔法） |
| 队列 | BullMQ + Redis |
| 对象存储 | MinIO（本地）/ AWS S3 兼容接口 |
| 图片处理 | Sharp |
| 视频处理 | fluent-ffmpeg |
| AI 提供商 | 火山引擎（图片/视频/数字人）、Gemini、Nano Banana |

---

## 环境变量

复制 `.env.example` 为 `.env`，复制 `prompts.env.example` 为 `prompts.env`。  
关键变量：`DATABASE_URL`、`REDIS_URL`、`S3_*`、`JWT_SECRET`、`VOLC_*`（火山引擎）。

---

## 注意事项

- **Kysely 查询**：不使用 ORM，直接写类型安全的 SQL 构建器，修改 schema 必须同步更新 `packages/types` 中的 DB 类型。
- **积分系统**：生成操作会扣减用户积分，`api/lib/credits.ts` 是核心，修改生成流程时注意积分扣减逻辑。
- **队列任务**：API 只负责投递任务，实际 AI 调用在 worker 中执行，调试生成问题需同时看 api 和 worker 日志。
- **视频工作室**：有独立的状态追踪（`e3d3599`），生成任务有超时守卫（`timeout-guardian` job）。
- **PM2 部署**：生产环境通过 `ecosystem.config.cjs` 管理三个进程（api、worker、web）。
