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

# 启动本地基础设施（MySQL / Redis / MinIO）
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
  api/      — Fastify 5 REST API（端口 7001）
  web/      — Next.js 15 App Router 前端（端口 6006）
  worker/   — BullMQ 后台任务处理
  docs/     — Nextra 文档站
packages/
  db/       — Prisma schema、迁移脚本、种子数据
  types/    — 跨应用共享 TypeScript 类型
```

---

## 各应用职责

### `apps/api`

- **框架**: Fastify 5 + TypeScript（ESM）
- **认证**: JWT（`plugins/` 中的守卫插件）
- **路由**: `routes/` 下按业务模块拆分（auth、generate、canvas、video-studio、payment 等 20+ 模块）
- **业务逻辑**: `services/`（积分、提示词过滤、合并导出）
- **工具库**: `lib/`（storage、queue、credits、sanitize）
- **队列**: BullMQ + Redis，任务投递给 worker

### `apps/web`

- **框架**: Next.js 15 App Router
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

- Prisma 6 + MySQL 8+
- 所有 schema 变更通过 `prisma migrate` 管理

### `packages/types`

- 跨应用共享类型：adapter、api、db、queue
- 修改此包后需重新构建依赖它的应用

---

## 技术栈关键点

| 层级 | 技术 |
|------|------|
| 前端框架 | Next.js 15 App Router + React 19 |
| 样式 | Tailwind CSS 4 + tailwindcss-animate |
| UI 组件 | Radix UI + shadcn/ui |
| 画布 | ReactFlow |
| 动画 | Framer Motion |
| 后端框架 | Fastify 5 |
| ORM/查询 | Prisma 6（MySQL 8+） |
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

- **Prisma 查询**：使用 Prisma Client，修改 schema 必须执行 `prisma generate` 同步类型。
- **积分系统**：生成操作会扣减用户积分，`api/lib/credits.ts` 是核心，修改生成流程时注意积分扣减逻辑。
- **队列任务**：API 只负责投递任务，实际 AI 调用在 worker 中执行，调试生成问题需同时看 api 和 worker 日志。
- **视频工作室**：有独立的状态追踪（`e3d3599`），生成任务有超时守卫（`timeout-guardian` job）。
- **PM2 部署**：生产环境通过 `ecosystem.config.cjs` 管理三个进程（api、worker、web）。

# 项目约束 & Superpowers 配置
## 启用技能（按需开/关）
- brainstorming   # 需求拆解、分步思考
- writing-plans   # 任务拆分、分步执行
- tdd             # 测试先行（可选）
- code-review     # 代码审查（可选）

## 长任务/防中断约束（关键）
- 所有复杂任务必须**分步思考、分步写文件存档**
- 每轮长考/方案设计后，追加写入 .claude/task-log.md
- 子任务清单实时更新到 .claude/task-plan.md
- 禁止一次性全局长推演；构思一段 → 存档 → 继续下一段
- 会话中断/重启时，优先读取 task-log.md + task-plan.md 接续思考

## 权限约束（结合 Claude 权限配置）
- 所有文件编辑、npm/git 命令自动执行，不重复请求授权
- 危险命令（sudo、rm -rf /）禁止执行

## 编码规范
- 语言：Go 1.23 / Node.js 20
- 分支：feat/xxx、fix/xxx
- 禁止直接 commit 到 main