# AIGC 平台重构设计方案

**版本**: v1.0
**日期**: 2026-05-06
**状态**: 设计中

---

## 一、背景与目标

### 1.1 项目现状

AIGC 创作平台是基于 AI 的图片/视频生成、画布编辑、数字人制作的全栈 SaaS 应用，采用 Turborepo monorepo 架构，包含 API（Fastify）、Web（Next.js）、Worker（BullMQ）三个核心服务，数据库使用 PostgreSQL + Kysely。

### 1.2 重构目标

| 目标 | 说明 |
|------|------|
| **项目拆分** | 从 monorepo 拆分为 3 个完全独立的 Git 仓库 |
| **数据库迁移** | PostgreSQL → MySQL 8+，Kysely → Prisma |
| **API 升级** | Fastify 4 → Fastify 5 |
| **Web 重构** | Next.js 14 → Next.js 15，UI 组件升级 |
| **部署优化** | Docker 独立容器化部署 |
| **数据迁移** | 提供一次性数据迁移脚本 |

### 1.3 非功能性约束

- 保持现有业务逻辑完全不变
- Web 界面设计语言保持一致
- 支持未来数据库主从读写分离扩展

---

## 二、项目架构

### 2.1 三个独立仓库结构

```
aigc-platform/
├── aigc-api/         # Fastify 5 + Prisma + MySQL
├── aigc-web/         # Next.js 15 App Router
└── aigc-worker/      # Node.js + BullMQ + Prisma
```

### 2.2 各项目职责

| 项目 | 技术栈 | 职责 | 端口 |
|------|--------|------|------|
| **aigc-api** | Fastify 5 + Prisma | REST API、认证、积分、任务投递 | 7001 |
| **aigc-web** | Next.js 15 + React 19 | 前端界面、用户交互 | 6006 |
| **aigc-worker** | Node.js + BullMQ + Prisma | AI 任务执行、轮询、定时任务 | 无外部端口 |

### 2.3 依赖关系

```
aigc-web  ──http──▶  aigc-api
                     │
                     ▼
aigc-worker ◀──http/redis── aigc-api
                BullMQ
                     │
                     ▼
                 MySQL (共享)
```

---

## 三、技术栈变更

### 3.1 技术选型对比

| 层级 | 变更前 | 变更后 |
|------|--------|--------|
| **数据库** | PostgreSQL 15 | MySQL 8+ |
| **ORM** | Kysely | Prisma |
| **迁移方案** | 自定义迁移脚本 | Prisma Migrate |
| **API 框架** | Fastify 4 | Fastify 5 |
| **前端框架** | Next.js 14 | Next.js 15 | 官方推荐路由 |
| **UI 组件库** | Radix UI (旧版本) | Radix UI (最新版本) |
| **样式** | Tailwind CSS 3 | Tailwind CSS 4 |
| **组件库** | shadcn/ui | shadcn/ui (最新) |

### 3.2 各项目详细技术栈

#### aigc-api

| 项目 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Node.js | >= 20.0.0 | ESM |
| 框架 | Fastify | 5.x | 升级 |
| ORM | Prisma | 6.x | 替换 Kysely |
| 数据库 | MySQL | 8.0+ | 替换 PostgreSQL |
| 认证 | JWT (jsonwebtoken) | 9.x | 保持 |
| 缓存 | ioredis | 5.x | 保持 |
| 队列 | BullMQ | 5.x | 保持 |
| 日志 | pino | 9.x | 保持 |

#### aigc-web

| 项目 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 框架 | Next.js | 15.x | App Router |
| React | React | 19.x | 升级 |
| 样式 | Tailwind CSS | 4.x | 升级 |
| 组件库 | shadcn/ui | 最新 | 官方推荐 |
| 状态管理 | Zustand | 5.x | 保持 |
| 数据请求 | SWR | 2.x | 保持 |
| 画布 | ReactFlow | 11.x | 保持 |
| 动画 | Framer Motion | 12.x | 保持 |

#### aigc-worker

| 项目 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Node.js | >= 20.0.0 | ESM |
| ORM | Prisma | 6.x | 替换 Kysely |
| 数据库 | MySQL | 8.0+ | 替换 PostgreSQL |
| 队列 | BullMQ | 5.x | 保持 |
| 图片处理 | sharp | 0.35+ | 保持 |
| 视频处理 | fluent-ffmpeg | 2.x | 保持 |
| AI 适配器 | 火山引擎、Gemini | - | 保持 |

---

## 四、项目结构设计

### 4.1 aigc-api 项目结构

```
aigc-api/
├── prisma/
│   ├── schema.prisma          # Prisma Schema
│   ├── migrations/            # Prisma 迁移文件
│   └── seed.ts               # 种子数据
├── src/
│   ├── app.ts                # Fastify 实例配置
│   ├── index.ts              # 入口文件
│   ├── routes/               # 路由模块（保持原有结构）
│   │   ├── auth.ts
│   │   ├── generate.ts
│   │   ├── canvas.ts
│   │   ├── video-studio.ts
│   │   ├── teams.ts
│   │   └── ...
│   ├── services/             # 业务服务层
│   │   ├── credit.ts
│   │   ├── prompt-filter.ts
│   │   └── concat-export.ts
│   ├── plugins/              # Fastify 插件
│   │   ├── guards.ts
│   │   ├── jwt-auth.ts
│   │   └── cors.ts
│   └── lib/                  # 工具库
│       ├── queue.ts          # BullMQ 投递
│       ├── storage.ts        # S3/MinIO
│       ├── credits.ts        # 积分扣减
│       └── sanitize.ts       # 输入过滤
├── docker/
│   └── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── .env.example
```

### 4.2 aigc-web 项目结构

采用 Next.js App Router（官方推荐）结构：

```
aigc-web/
├── prisma/                    # 仅用于类型生成
│   └── schema.prisma
├── src/
│   ├── app/                   # App Router
│   │   ├── (auth)/            # 认证路由组（括号不参与 URL）
│   │   │   ├── login/
│   │   │   │   └── page.tsx
│   │   │   ├── sso/
│   │   │   │   └── page.tsx
│   │   │   └── invite/
│   │   │       └── page.tsx
│   │   ├── (dashboard)/      # 主功能路由组
│   │   │   ├── generation/
│   │   │   │   └── page.tsx
│   │   │   ├── canvas/
│   │   │   │   └── page.tsx
│   │   │   ├── video-studio/
│   │   │   │   └── page.tsx
│   │   │   ├── assets/
│   │   │   │   └── page.tsx
│   │   │   ├── history/
│   │   │   │   └── page.tsx
│   │   │   ├── admin/
│   │   │   │   └── page.tsx
│   │   │   ├── team/
│   │   │   │   └── page.tsx
│   │   │   ├── credits/
│   │   │   │   └── page.tsx
│   │   │   └── settings/
│   │   │       └── page.tsx
│   │   ├── payment/           # 支付回调
│   │   │   └── page.tsx
│   │   ├── layout.tsx        # 根布局
│   │   ├── page.tsx          # 首页
│   │   ├── loading.tsx       # 加载状态
│   │   └── error.tsx         # 错误页面
│   ├── components/            # 组件
│   │   ├── ui/               # shadcn/ui 基础组件
│   │   ├── canvas/            # 画布组件
│   │   ├── generation/         # 生成相关组件
│   │   └── ...
│   ├── stores/               # Zustand 状态
│   ├── lib/                  # 工具函数
│   │   ├── api.ts            # API 请求封装
│   │   └── utils.ts
│   └── hooks/                # 自定义 Hooks
├── public/                   # 静态资源
├── docker/
│   ├── Dockerfile
│   └── nginx.conf           # Nginx 配置
├── docker-compose.yml
├── next.config.ts
├── components.json           # shadcn/ui 配置
├── tailwind.config.ts
├── package.json
└── tsconfig.json
```

**目录命名规范**：
- 目录名仅使用小写字母（禁止括号、连字符、数字等）
- 路由目录使用小写下划线或单词组合（如 `videoStudio` → `videostudio`）
- 每个路由目录下的入口文件固定为 `index.tsx`
- 布局文件固定为 `_layout.tsx`（下划线开头表示共享布局）

### 4.3 aigc-worker 项目结构

```
aigc-worker/
├── prisma/
│   ├── schema.prisma          # Prisma Schema
│   └── migrations/            # Prisma 迁移文件
├── src/
│   ├── index.ts              # 入口文件
│   ├── workers/             # BullMQ 消费者
│   │   ├── image.ts
│   │   └── transfer.ts
│   ├── pipelines/           # 任务管线
│   │   ├── complete.ts
│   │   └── fail.ts
│   ├── pollers/             # 异步轮询器
│   │   ├── video.ts
│   │   ├── avatar.ts
│   │   └── action-imitation.ts
│   ├── jobs/                # 定时任务
│   │   ├── timeout-guardian.ts
│   │   ├── purge-old-records.ts
│   │   └── purge-deleted-projects.ts
│   ├── adapters/            # AI 提供商适配器
│   │   ├── base.ts
│   │   ├── factory.ts
│   │   ├── nano-banana.ts
│   │   └── volcengine-image.ts
│   └── lib/                 # 工具库
│       ├── redis.ts
│       ├── storage.ts
│       ├── url-validator.ts
│       └── volcengine-visual-sign.ts
├── docker/
│   └── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 五、Docker 部署架构

### 5.1 开发环境（Docker Compose）

```yaml
# docker-compose.yml（各项目通用基础架构）
version: '3.8'

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: aigc
      MYSQL_USER: aigc
      MYSQL_PASSWORD: aigc
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data

volumes:
  mysql_data:
  redis_data:
  minio_data:
```

### 5.2 各项目 Dockerfile

#### aigc-api Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-alpine AS runner

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
EXPOSE 7001

CMD ["node", "dist/index.js"]
```

#### aigc-web Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM nginx:alpine AS runner

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static .next/static
COPY --from=builder /app/public ./public
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 6006

CMD ["node", "server.js"]
```

#### aigc-web nginx.conf

```nginx
server {
    listen 80;
    server_name _;

    gzip on;
    gzip_types text/plain application/json application/javascript text/css image/svg+xml;

    location / {
        root /app;
        try_files $uri $uri/ /index.html;
    }

    location /_next/static {
        alias /app/.next/static;
        cache-control public, max-age=31536000, immutable;
    }

    location /api {
        proxy_pass http://aigc-api:7001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

#### aigc-worker Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-alpine AS runner

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
```

### 5.3 生产环境部署

生产环境使用 Docker Compose 或 Kubernetes：

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  api:
    build: ./aigc-api
    restart: unless-stopped
    environment:
      - DATABASE_URL=mysql://aigc:aigcpassword@mysql:3306/aigc
      - REDIS_URL=redis://redis:6379
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    build: ./aigc-worker
    restart: unless-stopped
    environment:
      - DATABASE_URL=mysql://aigc:aigcpassword@mysql:3306/aigc
      - REDIS_URL=redis://redis:6379
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  web:
    build: ./aigc-web
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      - api
```

---

## 六、数据库设计（Prisma Schema）

### 6.1 核心 Schema 模型

基于现有 PostgreSQL schema 转换为 MySQL 兼容的 Prisma Schema：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

// 用户与认证
model User {
  id                String    @id @default(cuid())
  email             String    @unique
  phone             String?   @unique
  passwordHash      String?
  name              String?
  avatar           String?
  passwordChangedAt DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  deletedAt        DateTime?

  sessions          Session[]
  teamMembers       TeamMember[]
  credits           Credits?
  tasks             Task[]
  assets            Asset[]
  workspaces        Workspace[]
}

// Session 管理
model Session {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())

  user      User     @relation(fields: [userId], references: [id])
}

// 团队与工作空间
model Team {
  id          String   @id @default(cuid())
  name        String
  type        TeamType @default(TeamType.FREE)
  avatar      String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  members     TeamMember[]
  workspaces  Workspace[]
  inviteCodes InviteCode[]
}

model TeamMember {
  id        String   @id @default(cuid())
  teamId    String
  userId    String
  role      MemberRole @default(MemberRole.MEMBER)
  joinedAt  DateTime @default(now())

  team      Team     @relation(fields: [teamId], references: [id])
  user      User     @relation(fields: [userId], references: [id])

  @@unique([teamId, userId])
}

// 积分系统
model Credits {
  id        String   @id @default(cuid())
  userId    String   @unique
  total     Int      @default(0)
  frozen    Int      @default(0)
  updatedAt DateTime @updatedAt

  user      User     @relation(fields: [userId], references: [id])
  ledger    CreditsLedger[]
}

model CreditsLedger {
  id          String       @id @default(cuid())
  userId      String
  type        LedgerType
  amount      Int
  balance     Int
  description String?
  taskId      String?
  createdAt   DateTime     @default(now())

  credits     Credits      @relation(fields: [userId], references: [id])
  task        Task?        @relation(fields: [taskId], references: [id])

  @@index([userId, createdAt])
}

// 任务与资产
model Task {
  id            String      @id @default(cuid())
  userId        String
  batchId       String?
  type          TaskType
  status        TaskStatus  @default(TaskStatus.PENDING)
  provider      String?
  model         String?
  params        Json?
  progress      Int         @default(0)
  error         String?
  externalTaskId String?
  externalUrl   String?
  storageUrl    String?
  thumbnailUrl  String?
  creditsCost   Int?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  completedAt   DateTime?

  user          User        @relation(fields: [userId], references: [id])
  batch         Batch?      @relation(fields: [batchId], references: [id])
  assets        Asset[]
  creditLedger  CreditsLedger[]
}

model Asset {
  id           String   @id @default(cuid())
  userId       String
  taskId       String?
  type         AssetType
  name         String
  storageUrl   String?
  thumbnailUrl  String?
  mimeType     String?
  size         Int?
  width        Int?
  height       Int?
  metadata     Json?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  deletedAt    DateTime?

  user         User     @relation(fields: [userId], references: [id])
  task         Task?    @relation(fields: [taskId], references: [id])
}

// 画布
model Canvas {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  data        Json?
  thumbnail   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
}

// 视频项目
model VideoProject {
  id            String   @id @default(cuid())
  workspaceId   String
  name          String
  type          String?
  data          Json?
  thumbnail     String?
  status        String   @default("draft")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
}

// 枚举定义
enum TeamType {
  FREE
  PRO
  ENTERPRISE
}

enum MemberRole {
  OWNER
  ADMIN
  MEMBER
}

enum LedgerType {
  FROZEN
  SPENT
  REFUNDED
  PURCHASED
}

enum TaskType {
  IMAGE
  VIDEO
  AVATAR
  ACTION_IMITATION
  CANVAS
  VIDEO_STUDIO
}

enum TaskStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

enum AssetType {
  IMAGE
  VIDEO
  AUDIO
}
```

### 6.2 Schema 同步策略

由于 3 个项目独立维护 Prisma Schema，采取以下同步策略：

1. **统一 schema 文件**：维护一份标准 schema.json，各项目直接复制
2. **CI 检查**：GitHub Actions 自动检查各项目 schema 差异
3. **版本注释**：每个 schema 文件顶部标注版本号，便于追踪

---

## 七、数据迁移方案

### 7.1 迁移工具概述

| 项目 | 说明 |
|------|------|
| **迁移工具** | `migrate-pg-to-mysql.ts` |
| **执行方式** | 一次性脚本，直接连接两个数据库 |
| **数据校验** | 迁移后自动校验数据一致性 |

### 7.2 迁移步骤

1. 备份 PostgreSQL 数据
2. 运行迁移脚本
3. 校验迁移结果
4. 启动新环境验证

### 7.3 迁移脚本结构

```typescript
// migrate-pg-to-mysql.ts
import { Client as PGClient } from 'pg';
import { PrismaClient } from '@prisma/client';

async function migrate() {
  // 1. 连接源数据库（PostgreSQL）
  const pg = new PGClient({ connectionString: process.env.PG_DATABASE_URL });
  await pg.connect();

  // 2. 连接目标数据库（MySQL）
  const prisma = new PrismaClient();
  await prisma.$connect();

  // 3. 迁移用户数据
  const users = await pg.query('SELECT * FROM users');
  for (const user of users.rows) {
    await prisma.user.create({
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        passwordHash: user.password_hash,
        name: user.name,
        avatar: user.avatar,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      }
    });
  }

  // 4. 迁移团队数据
  // ... (类似结构)

  // 5. 迁移积分数据
  // ... (类似结构)

  // 6. 校验数据一致性
  const pgCount = await pg.query('SELECT COUNT(*) FROM users');
  const mysqlCount = await prisma.user.count();
  console.log(`迁移校验: PG=${pgCount.rows[0].count}, MySQL=${mysqlCount}`);

  await pg.end();
  await prisma.$disconnect();
}

migrate().catch(console.error);
```

### 7.4 迁移注意事项

- PostgreSQL 和 MySQL 的数据类型映射（如 `uuid` → `cuid`）
- 时间戳字段的时区处理
- JSON 字段的格式兼容性
- 批量插入优化（避免逐条插入）

---

## 八、API 兼容性

### 8.1 保持兼容的接口

所有现有 API 路由保持不变：

| 模块 | 路由 | 说明 |
|------|------|------|
| 认证 | `/api/auth/*` | 登录、注册、SSO |
| 生成 | `/api/generate/*` | 图片/视频生成 |
| 画布 | `/api/canvas/*` | 画布编辑 |
| 团队 | `/api/teams/*` | 团队管理 |
| 积分 | `/api/credits/*` | 积分查询、扣减 |
| 资产 | `/api/assets/*` | 资产管理 |

### 8.2 内部接口变更

| 变更 | 说明 |
|------|------|
| **数据库查询** | Kysely → Prisma Client |
| **Schema 类型** | 重新生成 TypeScript 类型 |

---

## 九、实施计划

### 9.1 实施阶段

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| **阶段一** | 搭建项目骨架 | 各项目初始化配置 |
| **阶段二** | Prisma Schema 迁移 | 数据库设计 |
| **阶段三** | 数据迁移脚本 | 一次性迁移工具 |
| **阶段四** | aigc-api 重构 | Fastify 5 + Prisma |
| **阶段五** | aigc-worker 重构 | Prisma 接入 |
| **阶段六** | aigc-web 重构 | Next.js 15 升级 |
| **阶段七** | Docker 部署验证 | 容器化部署 |

### 9.2 关键里程碑

1. **M1**: 完成 3 个项目的初始化配置
2. **M2**: 完成 Prisma Schema 设计和迁移脚本
3. **M3**: API 和 Worker 完成重构
4. **M4**: Web 完成重构
5. **M5**: Docker 部署验证通过

---

## 十、注意事项

### 10.1 Fastify 5 升级注意

- Breaking changes 较少，主要检查插件兼容性
- 建议逐个模块测试

### 10.2 Prisma 迁移注意

- MySQL 不支持 `enum` 类型，Prisma 会转为 `String` + 验证
- 需要手动处理自增 ID 和 cuid 的差异
- 索引长度限制（MySQL InnoDB 767 字节）

### 10.3 Next.js 15 升级注意

- React 19 的新特性可以逐步采用
- Server Components 默认开启
- Tailwind CSS 4 有配置变更

---

## 附录

### A. 环境变量模板

```env
# 数据库
DATABASE_URL="mysql://aigc:aigcpassword@localhost:3306/aigc"

# Redis
REDIS_URL="redis://localhost:6379"

# JWT
JWT_SECRET="your-secret-key"

# S3/MinIO
S3_ENDPOINT="http://localhost:9000"
S3_ACCESS_KEY="minioadmin"
S3_SECRET_KEY="minioadmin"
S3_BUCKET="aigc"
S3_REGION="us-east-1"

# 火山引擎
VOLC_ACCESS_KEY=""
VOLC_SECRET_KEY=""
VOLC_REGION=""
```

### B. 缩略语

| 缩写 | 全称 |
|------|------|
| PG | PostgreSQL |
| ESM | ECMAScript Modules |
| CI | Continuous Integration |
| SSO | Single Sign-On |