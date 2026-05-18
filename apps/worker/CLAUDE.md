# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
# 开发（热重载）
pnpm dev                          # tsx watch src/index.ts

# 构建
pnpm build                        # tsc → dist/

# 生产启动
pnpm start                        # node dist/index.js
```

> Worker 依赖 monorepo 根目录的 `.env`，启动前确保 `../../.env` 已配置。

---

## 架构概览

Worker 是一个长驻 Node.js 进程（ESM），负责所有 AI 生成任务的异步执行。API 只投递任务，实际 AI 调用全部在这里完成。

### 启动流程（`src/index.ts`）

1. 加载 `../../.env` 和 `../../prompts.env`（dotenv，必须在所有 import 之前）
2. 启动 **image-queue** BullMQ Worker（并发 5）
3. 启动 **transfer-queue** Worker（`workers/transfer.ts`，并发 5）
4. 调度定时任务：timeout-guardian（每 5 分钟）、purge-old-records（每天）
5. 启动 3 个轮询器：video、avatar、action-imitation（各 15 秒间隔）
6. 注册 SIGTERM/SIGINT 优雅关闭

---

## 核心模块

### `src/adapters/` — AI 提供商适配器

- **`factory.ts`**：根据 `provider` 字段（`nano-banana` / `volcengine`）返回对应适配器实例
- **`nano-banana.ts`**：调用自建 API（`/v1/images/generations` 或 `/v1/images/edits`），支持 Gemini / GPT-Image-2 / NanoBanana 系列模型，发送前用 sharp 压缩参考图，内置网络错误重试
- **`volcengine-image.ts`**：调用火山引擎 Ark API，支持 Seedream 4.0/4.5/5.0-lite，处理分辨率/宽高比到像素尺寸的映射，按火山引擎约束校验并缩放参考图

新增提供商：实现 `src/adapters/base.ts` 中导出的 adapter 接口，在 `factory.ts` 注册即可。

### `src/pipelines/` — 任务完成/失败管线

两个管线都在 **单个数据库事务** 内完成所有状态变更：

- **`complete.ts`**：插入 asset 行 → 确认积分（frozen→spent）→ 写 credits_ledger → 更新 task/batch 状态 → 写 canvas_node_outputs（如有）→ 事务外发布 SSE 事件 → 投递 transfer-queue 任务
- **`fail.ts`**：标记 task 失败 → 退还冻结积分 → 更新 batch 计数 → 发布 SSE 事件

**注意**：completePipeline 有幂等保护（`status != completed AND status != failed`），重复调用安全。

### `src/workers/transfer.ts` — 资产转存

将 AI 提供商返回的临时 URL 永久化到外部存储：
1. SSRF 校验（`lib/url-validator.ts`）
2. POST 到 `EXTERNAL_STORAGE_URL` API，获取永久 URL
3. 视频额外用 ffmpeg 提取首帧缩略图（非致命，失败不影响主流程）
4. 更新 `assets.storage_url` 和 `canvas_node_outputs` 中的 URL

`EXTERNAL_STORAGE_BASE` 可将外部域名 URL 改写为内网地址，供 API 服务代理。

### `src/pollers/` — 异步任务轮询

三个轮询器结构相同：查询 DB 中 `status=processing` 且有 `external_task_id` 的任务 → 调用外部 API 查询状态 → 成功走 completePipeline / 失败走 failPipeline。

| 轮询器 | 超时时间 | 外部 API |
|--------|---------|---------|
| `video-poller.ts` | 1 小时 | 火山引擎 VEO / Volcengine 视频 |
| `avatar-poller.ts` | 20 分钟 | 火山引擎 OmniHuman 数字人 |
| `action-imitation-poller.ts` | 35 分钟 | 火山引擎 DreamActor 动作模仿 |

### `src/jobs/` — 定时维护任务

- **`timeout-guardian.ts`**：检测卡住的任务（超过 6 分钟未完成），强制标记失败并退款
- **`purge-old-records.ts`**：清理过期日志/错误记录（每天）
- **`purge-deleted-projects.ts`**：清理软删除的画布/视频项目（7 天后硬删除）

### `src/lib/` — 基础工具

- **`redis.ts`**：懒加载 Redis 单例，分两个连接（队列用 / pub-sub 用），`closeRedis()` 供优雅关闭
- **`storage.ts`**：S3Client，兼容 MinIO
- **`url-validator.ts`**：SSRF 防护，拦截私有 IP、localhost、云元数据端点
- **`volcengine-visual-sign.ts`**：火山引擎 Visual API 的 HMAC-SHA256 签名（avatar/action-imitation 轮询器使用）

---

## 关键约束

### 积分系统
生成任务开始时 API 冻结积分，worker 完成后在 `completePipeline` 中确认（frozen→spent），失败时在 `failPipeline` 中退还。修改生成流程时必须同步检查积分扣减逻辑，避免积分泄漏或多扣。

### 环境变量加载顺序
`src/index.ts` 顶部用 `config()` 同步加载 `.env`，**必须在所有业务 import 之前执行**。如果新增模块在顶层读取 `process.env`，需确保 import 顺序正确，否则会读到 undefined。

### ESM 模块
项目为 `"type": "module"`，所有内部 import 必须带 `.js` 后缀（即使源文件是 `.ts`），TypeScript 编译后路径不变。

### 视频/数字人任务流
视频和数字人任务不走 image-queue，API 投递后直接写 `external_task_id` 到 DB，由对应轮询器异步查询结果。调试这类任务需同时看 API 日志和 worker 轮询器日志。
