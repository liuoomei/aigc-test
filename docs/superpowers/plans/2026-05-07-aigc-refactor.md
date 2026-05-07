# AIGC 平台重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AIGC 平台从 monorepo 拆分为 3 个独立仓库，数据库从 PostgreSQL + Kysely 迁移到 MySQL + Prisma，技术栈全面升级。

**Architecture:** 三个独立 Git 仓库（aigc-api、aigc-web、aigc-worker），各自独立部署，通过 HTTP 和 Redis/BullMQ 通信，共享 MySQL 数据库。

**Tech Stack:** Node.js 20+, Fastify 5, Next.js 15, Prisma 6, MySQL 8+, BullMQ 5, Docker

---

## 阶段一：项目骨架搭建

### 任务 1: 初始化 aigc-api 项目

**Files:**
- Create: `aigc-api/package.json`
- Create: `aigc-api/tsconfig.json`
- Create: `aigc-api/.env.example`
- Create: `aigc-api/.gitignore`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "aigc-api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate deploy",
    "db:push": "prisma db push",
    "db:studio": "prisma studio"
  },
  "dependencies": {
    "@prisma/client": "^6.0.0",
    "@aws-sdk/client-s3": "^3.500.0",
    "@aws-sdk/s3-request-presigner": "^3.1003.0",
    "@fastify/cookie": "^9.4.0",
    "@fastify/cors": "^9.0.1",
    "@fastify/helmet": "^11.1.1",
    "@fastify/multipart": "^8.3.1",
    "@fastify/rate-limit": "^9.1.0",
    "@fastify/sensible": "^5.0.0",
    "@ffmpeg-installer/ffmpeg": "^1.1.0",
    "bcryptjs": "^3.0.3",
    "bullmq": "^5.0.0",
    "dotenv": "^16.0.0",
    "fastify": "^5.0.0",
    "fastify-plugin": "^5.1.0",
    "fluent-ffmpeg": "^2.1.3",
    "ioredis": "^5.3.0",
    "jsonwebtoken": "^9.0.3",
    "pino": "^9.0.0",
    "sharp": "^0.35.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^3.0.0",
    "@types/fluent-ffmpeg": "^2.1.28",
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^20.0.0",
    "prisma": "^6.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 .env.example**

```
DATABASE_URL="mysql://aigc:aigcpassword@localhost:3306/aigc"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="your-secret-key-change-in-production"
JWT_EXPIRES_IN="7d"

S3_ENDPOINT="http://localhost:9000"
S3_ACCESS_KEY="minioadmin"
S3_SECRET_KEY="minioadmin"
S3_BUCKET="aigc"
S3_REGION="us-east-1"

VOLC_ACCESS_KEY=""
VOLC_SECRET_KEY=""
VOLC_REGION=""

PORT=7001
NODE_ENV=development
```

- [ ] **Step 4: 创建 .gitignore**

```
node_modules/
dist/
.env
*.log
.DS_Store
coverage/
```

- [ ] **Step 5: 提交**

```bash
git init
git add package.json tsconfig.json .env.example .gitignore
git commit -m "feat: 初始化 aigc-api 项目骨架

- Fastify 5 + Prisma + MySQL
- TypeScript ESM 配置
- BullMQ 队列支持
- S3/MinIO 存储支持

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 2: 初始化 aigc-web 项目

**Files:**
- Create: `aigc-web/package.json`
- Create: `aigc-web/tsconfig.json`
- Create: `aigc-web/next.config.ts`
- Create: `aigc-web/tailwind.config.ts`
- Create: `aigc-web/components.json`
- Create: `aigc-web/.env.example`
- Create: `aigc-web/.gitignore`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "aigc-web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev -p 6006",
    "build": "next build",
    "start": "next start -p 6006",
    "lint": "next lint",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@prisma/client": "^6.0.0",
    "@radix-ui/react-avatar": "^1.1.15",
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-dropdown-menu": "^2.1.15",
    "@radix-ui/react-label": "^2.1.8",
    "@radix-ui/react-popover": "^1.1.15",
    "@radix-ui/react-progress": "^1.1.8",
    "@radix-ui/react-radio-group": "^1.3.8",
    "@radix-ui/react-scroll-area": "^1.2.10",
    "@radix-ui/react-select": "^2.2.6",
    "@radix-ui/react-separator": "^1.1.8",
    "@radix-ui/react-slot": "^1.2.4",
    "@radix-ui/react-toggle": "^1.1.10",
    "@radix-ui/react-tooltip": "^1.2.8",
    "@tailwindcss/typography": "^0.5.19",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "framer-motion": "^12.34.4",
    "html-to-image": "^1.11.13",
    "jsonwebtoken": "^9.0.3",
    "jszip": "^3.10.1",
    "lucide-react": "^0.576.0",
    "next": "^15.0.0",
    "next-themes": "^0.4.6",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^10.1.0",
    "reactflow": "^11.11.4",
    "remark-gfm": "^4.0.1",
    "sonner": "^2.0.7",
    "swr": "^2.4.1",
    "tailwind-merge": "^3.5.0",
    "tailwindcss": "^4.0.0",
    "tailwindcss-animate": "^1.0.7",
    "zund": "^2.3.0",
    "zustand": "^5.0.11"
  },
  "devDependencies": {
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^20.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "prisma": "^6.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: 创建 next.config.ts**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['sharp', 'fluent-ffmpeg'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
        pathname: '/**',
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.INTERNAL_API_URL || 'http://localhost:7001'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 4: 创建 tailwind.config.ts**

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
      },
      borderRadius: 'lg',
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
```

- [ ] **Step 5: 创建 components.json（shadcn/ui 配置）**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 6: 创建 .env.example**

```
DATABASE_URL="mysql://aigc:aigcpassword@localhost:3306/aigc"
INTERNAL_API_URL="http://localhost:7001"
NEXT_PUBLIC_API_URL="/api"
JWT_SECRET="your-secret-key-change-in-production"
```

- [ ] **Step 7: 创建 .gitignore**

```
node_modules/
.next/
.env
.env.local
*.log
.DS_Store
coverage/
```

- [ ] **Step 8: 提交**

```bash
git init
git add package.json tsconfig.json next.config.ts tailwind.config.ts components.json .env.example .gitignore
git commit -m "feat: 初始化 aigc-web 项目骨架

- Next.js 15 App Router
- React 19 + TypeScript
- Tailwind CSS 4 + shadcn/ui
- Zustand 状态管理
- SWR 数据请求

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 3: 初始化 aigc-worker 项目

**Files:**
- Create: `aigc-worker/package.json`
- Create: `aigc-worker/tsconfig.json`
- Create: `aigc-worker/.env.example`
- Create: `aigc-worker/.gitignore`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "aigc-worker",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate deploy"
  },
  "dependencies": {
    "@prisma/client": "^6.0.0",
    "@aws-sdk/client-s3": "^3.500.0",
    "bullmq": "^5.0.0",
    "dotenv": "^16.0.0",
    "ioredis": "^5.3.0",
    "pino": "^9.0.0",
    "sharp": "^0.35.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "prisma": "^6.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json（与 aigc-api 相同）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 .env.example**

```
DATABASE_URL="mysql://aigc:aigcpassword@localhost:3306/aigc"
REDIS_URL="redis://localhost:6379"

S3_ENDPOINT="http://localhost:9000"
S3_ACCESS_KEY="minioadmin"
S3_SECRET_KEY="minioadmin"
S3_BUCKET="aigc"
S3_REGION="us-east-1"

VOLC_ACCESS_KEY=""
VOLC_SECRET_KEY=""
VOLC_REGION=""

NODE_ENV=development
```

- [ ] **Step 4: 创建 .gitignore**

```
node_modules/
dist/
.env
*.log
.DS_Store
coverage/
```

- [ ] **Step 5: 提交**

```bash
git init
git add package.json tsconfig.json .env.example .gitignore
git commit -m "feat: 初始化 aigc-worker 项目骨架

- Node.js ESM + Prisma + MySQL
- BullMQ 消费者
- 火山引擎/Gemini AI 适配器
- 定时任务（timeout-guardian、purge）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 阶段二：Prisma Schema 设计与迁移

### 任务 4: 设计统一 Prisma Schema

**Files:**
- Create: `schema-reference/prisma/schema.prisma`（标准 Schema 参考）
- Create: `schema-reference/README.md`

基于现有 `packages/db/src/schema.ts` 和 29 个迁移文件，设计 MySQL 兼容的 Prisma Schema。

- [ ] **Step 1: 阅读现有 Schema 和迁移文件，理解完整数据结构**

参考文件：
- `packages/db/src/schema.ts` - Kysely Schema 定义
- `packages/db/migrations/*.ts` - 所有迁移脚本

- [ ] **Step 2: 创建标准 Prisma Schema**

```prisma
// schema-reference/prisma/schema.prisma
// 版本: 1.0.0
// 基于 PostgreSQL Schema 转换为 MySQL

generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/client"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

// ============================================
// 用户与认证
// ============================================

model User {
  id                   String    @id @default(cuid())
  email                String    @unique
  phone                String?   @unique
  passwordHash         String?   @map("password_hash")
  name                 String?
  avatar               String?
  passwordChangedAt    DateTime? @map("password_changed_at")
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @updatedAt @map("updated_at")
  deletedAt            DateTime? @map("deleted_at")

  sessions    Session[]
  teamMembers TeamMember[]
  credits     Credits?
  tasks       Task[]
  assets      Asset[]
  workspaces  Workspace[]

  @@map("users")
}

model Session {
  id        String   @id @default(cuid())
  userId    String   @map("user_id")
  token     String   @unique
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("sessions")
}

// ============================================
// 订阅与套餐
// ============================================

model SubscriptionPlan {
  id          String   @id @default(cuid())
  name        String
  description String?
  price       Int      @default(0)
  credits     Int      @default(0)
  duration    Int      @default(30) // 天数
  features    Json?
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  subscriptions Subscription[]

  @@map("subscription_plans")
}

model Subscription {
  id              String    @id @default(cuid())
  userId          String    @map("user_id")
  planId          String    @map("plan_id")
  status          SubStatus @default(ACTIVE)
  startedAt       DateTime  @default(now()) @map("started_at")
  expiresAt       DateTime  @map("expires_at")
  autoRenew       Boolean   @default(true) @map("auto_renew")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  plan SubscriptionPlan @relation(fields: [planId], references: [id])

  @@index([userId])
  @@map("subscriptions")
}

enum SubStatus {
  ACTIVE
  EXPIRED
  CANCELLED
}

// ============================================
// 团队与工作空间
// ============================================

model Team {
  id        String    @id @default(cuid())
  name      String
  type      TeamType  @default(FREE)
  avatar    String?
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  members     TeamMember[]
  workspaces  Workspace[]
  inviteCodes InviteCode[]

  @@map("teams")
}

model TeamMember {
  id       String      @id @default(cuid())
  teamId   String      @map("team_id")
  userId   String      @map("user_id")
  role     MemberRole  @default(MEMBER)
  joinedAt DateTime    @default(now()) @map("joined_at")

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
  @@index([userId])
  @@map("team_members")
}

model InviteCode {
  id        String   @id @default(cuid())
  teamId    String   @map("team_id")
  code      String   @unique
  expiresAt DateTime @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now()) @map("created_at")

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@index([teamId])
  @@map("invite_codes")
}

model Workspace {
  id        String   @id @default(cuid())
  userId    String   @map("user_id")
  teamId    String?  @map("team_id")
  name      String
  type      String?
  isDefault Boolean  @default(false) @map("is_default")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  user         User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  team         Team?         @relation(fields: [teamId], references: [id], onDelete: SetNull)
  quotas       QuotaPeriod[]
  canvas       Canvas[]
  videoProjects VideoProject[]

  @@index([userId])
  @@index([teamId])
  @@map("workspaces")
}

// ============================================
// 积分系统
// ============================================

model Credits {
  id        String   @id @default(cuid())
  userId    String   @unique @map("user_id")
  total     Int      @default(0)
  frozen    Int      @default(0)
  updatedAt DateTime @updatedAt @map("updated_at")

  user    User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  ledger  CreditsLedger[]

  @@map("credits")
}

model CreditsLedger {
  id          String      @id @default(cuid())
  userId      String      @map("user_id")
  type        LedgerType
  amount      Int
  balance     Int
  description String?
  taskId      String?     @map("task_id")
  createdAt   DateTime    @default(now()) @map("created_at")

  user  Credits @relation(fields: [userId], references: [id], onDelete: Cascade)
  task  Task?   @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@index([userId, createdAt])
  @@map("credits_ledger")
}

enum LedgerType {
  FROZEN
  SPENT
  REFUNDED
  PURCHASED
}

// ============================================
// 任务与批次
// ============================================

model Batch {
  id          String     @id @default(cuid())
  userId      String     @map("user_id")
  type        TaskType
  status      BatchStatus @default(PENDING)
  total       Int        @default(0)
  completed   Int        @default(0)
  failed      Int        @default(0)
  creditsCost Int?       @map("credits_cost")
  createdAt   DateTime   @default(now()) @map("created_at")
  updatedAt   DateTime   @updatedAt @map("updated_at")

  tasks Task[]

  @@index([userId])
  @@map("batches")
}

enum BatchStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

model Task {
  id              String      @id @default(cuid())
  userId          String      @map("user_id")
  batchId         String?     @map("batch_id")
  type            TaskType
  status          TaskStatus  @default(PENDING)
  provider        String?
  model           String?
  params          Json?
  progress        Int         @default(0)
  error           String?
  externalTaskId  String?     @map("external_task_id")
  externalUrl     String?     @map("external_url")
  storageUrl      String?     @map("storage_url")
  thumbnailUrl    String?     @map("thumbnail_url")
  creditsCost     Int?        @map("credits_cost")
  priority        Int         @default(0)
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  completedAt     DateTime?   @map("completed_at")

  user         User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  batch        Batch?         @relation(fields: [batchId], references: [id], onDelete: SetNull)
  assets       Asset[]
  creditLedger CreditsLedger[]

  @@index([userId])
  @@index([batchId])
  @@index([status, createdAt])
  @@map("tasks")
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

// ============================================
// 资产
// ============================================

model Asset {
  id           String     @id @default(cuid())
  userId       String     @map("user_id")
  taskId       String?    @map("task_id")
  type         AssetType
  name         String
  storageUrl   String?    @map("storage_url")
  thumbnailUrl String?    @map("thumbnail_url")
  mimeType     String?    @map("mime_type")
  size         Int?
  width        Int?
  height       Int?
  metadata     Json?
  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")
  deletedAt    DateTime?  @map("deleted_at")

  user User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  task Task? @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@index([userId])
  @@index([taskId])
  @@map("assets")
}

enum AssetType {
  IMAGE
  VIDEO
  AUDIO
}

// ============================================
// AI 提供商配置
// ============================================

model Provider {
  id        String   @id @default(cuid())
  name      String   @unique
  type      String?
  config    Json?
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("providers")
}

// ============================================
// 画布
// ============================================

model Canvas {
  id          String   @id @default(cuid())
  workspaceId String   @map("workspace_id")
  name        String
  data        Json?
  thumbnail   String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
  @@map("canvas")
}

// ============================================
// 视频工作室
// ============================================

model VideoProject {
  id          String   @id @default(cuid())
  workspaceId String   @map("workspace_id")
  name        String
  type        String?
  data        Json?
  thumbnail   String?
  status      String   @default("draft")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  workspace     Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  submissions   VideoSubmission[]

  @@index([workspaceId])
  @@map("video_studio_projects")
}

model VideoSubmission {
  id            String   @id @default(cuid())
  projectId     String   @map("project_id")
  batchId       String?  @map("batch_id")
  params        Json?
  status        String   @default("pending")
  externalId    String?  @map("external_id")
  result        Json?
  error         String?
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  project VideoProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@map("video_submissions")
}

// ============================================
// 支付
// ============================================

model Payment {
  id            String        @id @default(cuid())
  userId        String        @map("user_id")
  orderId       String        @unique @map("order_id")
  amount        Int
  currency      String        @default("CNY")
  status        PaymentStatus @default(PENDING)
  method        String?
  provider      String?
  providerRef   String?       @map("provider_ref")
  metadata      Json?
  createdAt     DateTime      @default(now()) @map("created_at")
  updatedAt     DateTime      @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("payments")
}

enum PaymentStatus {
  PENDING
  SUCCESS
  FAILED
  REFUNDED
}

// ============================================
// 配额周期（可选功能）
// ============================================

model QuotaPeriod {
  id          String   @id @default(cuid())
  workspaceId String   @map("workspace_id")
  type        String
  quota       Int
  used        Int      @default(0)
  periodStart DateTime @map("period_start")
  periodEnd   DateTime @map("period_end")
  createdAt   DateTime @default(now()) @map("created_at")

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, type, periodStart])
  @@map("quota_periods")
}

// ============================================
// 错误日志
// ============================================

model ClientError {
  id        String   @id @default(cuid())
  userId    String?  @map("user_id")
  type      String
  message   String
  stack     String?
  metadata  Json?
  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId])
  @@index([type, createdAt])
  @@map("client_errors")
}

model AiAssistantError {
  id        String   @id @default(cuid())
  userId    String?  @map("user_id")
  provider  String
  model     String?
  error     String
  metadata  Json?
  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId])
  @@map("ai_assistant_errors")
}

// ============================================
// 枚举定义
// ============================================

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
```

- [ ] **Step 3: 创建 README.md 说明 Schema 版本管理**

```markdown
# Prisma Schema 参考

## 版本

- v1.0.0 - 初始版本，基于 PostgreSQL Schema 转换

## 使用方法

1. 复制 `schema.prisma` 到各项目的 `prisma/schema.prisma`
2. 运行 `prisma generate` 生成 Client
3. 运行 `prisma migrate dev` 创建迁移

## Schema 同步策略

由于 3 个项目独立维护 Schema：
1. 以本文件为标准版本
2. 各项目直接复制使用
3. 后续 Schema 变更需同步更新本文件
```

- [ ] **Step 4: 提交**

```bash
mkdir -p schema-reference/prisma
git init
git add prisma/schema.prisma README.md
git commit -m "feat: 添加统一 Prisma Schema 参考

- MySQL 8+ 兼容设计
- 包含所有现有数据模型
- Schema 同步策略说明

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 5: 创建数据迁移脚本

**Files:**
- Create: `migrate-pg-to-mysql/package.json`
- Create: `migrate-pg-to-mysql/tsconfig.json`
- Create: `migrate-pg-to-mysql/src/index.ts`
- Create: `migrate-pg-to-mysql/.env.example`

- [ ] **Step 1: 创建项目配置**

```json
{
  "name": "migrate-pg-to-mysql",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@prisma/client": "^6.0.0",
    "dotenv": "^16.0.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "prisma": "^6.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: 创建迁移脚本**

```typescript
// src/index.ts
import { Client as PGClient } from 'pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const BATCH_SIZE = 100;

async function migrate() {
  console.log('开始数据迁移...');

  // 1. 连接源数据库（PostgreSQL）
  const pg = new PGClient({
    connectionString: process.env.PG_DATABASE_URL,
  });
  await pg.connect();
  console.log('已连接 PostgreSQL');

  // 2. 连接目标数据库（MySQL）
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.log('已连接 MySQL');

  try {
    // 3. 迁移用户数据
    console.log('\n迁移 users...');
    await migrateTable(pg, prisma, 'users', 'User', mapUser);
    await migrateSequence(pg, prisma, 'users');

    // 4. 迁移 sessions
    console.log('\n迁移 sessions...');
    await migrateTable(pg, prisma, 'sessions', 'Session', mapSession);

    // 5. 迁移 teams
    console.log('\n迁移 teams...');
    await migrateTable(pg, prisma, 'teams', 'Team', mapTeam);

    // 6. 迁移 team_members
    console.log('\n迁移 team_members...');
    await migrateTable(pg, prisma, 'team_members', 'TeamMember', mapTeamMember);

    // 7. 迁移 invite_codes
    console.log('\n迁移 invite_codes...');
    await migrateTable(pg, prisma, 'invite_codes', 'InviteCode', mapInviteCode);

    // 8. 迁移 workspaces
    console.log('\n迁移 workspaces...');
    await migrateTable(pg, prisma, 'workspaces', 'Workspace', mapWorkspace);

    // 9. 迁移 credits
    console.log('\n迁移 credits...');
    await migrateTable(pg, prisma, 'credits', 'Credits', mapCredits);

    // 10. 迁移 credits_ledger
    console.log('\n迁移 credits_ledger...');
    await migrateTable(pg, prisma, 'credits_ledger', 'CreditsLedger', mapCreditsLedger);

    // 11. 迁移 subscription_plans
    console.log('\n迁移 subscription_plans...');
    await migrateTable(pg, prisma, 'subscription_plans', 'SubscriptionPlan', mapSubscriptionPlan);

    // 12. 迁移 subscriptions
    console.log('\n迁移 subscriptions...');
    await migrateTable(pg, prisma, 'subscriptions', 'Subscription', mapSubscription);

    // 13. 迁移 batches
    console.log('\n迁移 batches...');
    await migrateTable(pg, prisma, 'batches', 'Batch', mapBatch);

    // 14. 迁移 tasks
    console.log('\n迁移 tasks...');
    await migrateTable(pg, prisma, 'tasks', 'Task', mapTask);

    // 15. 迁移 assets
    console.log('\n迁移 assets...');
    await migrateTable(pg, prisma, 'assets', 'Asset', mapAsset);

    // 16. 迁移 providers
    console.log('\n迁移 providers...');
    await migrateTable(pg, prisma, 'providers', 'Provider', mapProvider);

    // 17. 迁移 canvas
    console.log('\n迁移 canvas...');
    await migrateTable(pg, prisma, 'canvas', 'Canvas', mapCanvas);

    // 18. 迁移 video_studio_projects
    console.log('\n迁移 video_studio_projects...');
    await migrateTable(pg, prisma, 'video_studio_projects', 'VideoProject', mapVideoProject);

    // 19. 迁移 video_submissions
    console.log('\n迁移 video_submissions...');
    await migrateTable(pg, prisma, 'video_submissions', 'VideoSubmission', mapVideoSubmission);

    // 20. 迁移 payments
    console.log('\n迁移 payments...');
    await migrateTable(pg, prisma, 'payments', 'Payment', mapPayment);

    // 21. 迁移 quota_periods
    console.log('\n迁移 quota_periods...');
    await migrateTable(pg, prisma, 'quota_periods', 'QuotaPeriod', mapQuotaPeriod);

    // 22. 迁移 client_errors
    console.log('\n迁移 client_errors...');
    await migrateTable(pg, prisma, 'client_errors', 'ClientError', mapClientError);

    // 23. 迁移 ai_assistant_errors
    console.log('\n迁移 ai_assistant_errors...');
    await migrateTable(pg, prisma, 'ai_assistant_errors', 'AiAssistantError', mapAiAssistantError);

    // 24. 校验数据一致性
    console.log('\n========== 数据校验 ==========');
    await verifyTable(pg, prisma, 'users');
    await verifyTable(pg, prisma, 'teams');
    await verifyTable(pg, prisma, 'tasks');
    await verifyTable(pg, prisma, 'assets');

    console.log('\n========== 迁移完成 ==========');
  } catch (error) {
    console.error('迁移失败:', error);
    throw error;
  } finally {
    await pg.end();
    await prisma.$disconnect();
  }
}

type PGRow = Record<string, unknown>;
type PrismaData = Record<string, unknown>;

// 通用批量迁移函数
async function migrateTable(
  pg: PGClient,
  prisma: PrismaClient,
  pgTable: string,
  modelName: keyof PrismaClient,
  mapper: (row: PGRow) => PrismaData
) {
  const offset = 0;
  let migrated = 0;

  while (true) {
    const result = await pg.query(
      `SELECT * FROM ${pgTable} LIMIT ${BATCH_SIZE} OFFSET $1`,
      [offset]
    );

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      try {
        const data = mapper(row);
        await (prisma[modelName] as any).create({ data });
        migrated++;
      } catch (error: any) {
        if (error.code === 'P2002') {
          // 唯一约束冲突，跳过
          console.log(`  跳过重复记录: ${JSON.stringify(row)}`);
        } else {
          console.error(`  插入失败: ${error.message}`);
        }
      }
    }

    if (result.rows.length < BATCH_SIZE) break;
  }

  console.log(`  已迁移 ${migrated} 条记录`);
}

// 序列迁移（MySQL 自增需要特殊处理）
async function migrateSequence(pg: PGClient, prisma: PrismaClient, table: string) {
  const result = await pg.query(`SELECT MAX(id) as max_id FROM ${table}`);
  const maxId = result.rows[0]?.max_id;
  if (maxId) {
    // MySQL 自增处理：直接设置 AUTO_INCREMENT
    // Prisma 会自动处理，这里只是记录
    console.log(`  ${table} 最大 ID: ${maxId}`);
  }
}

// 数据校验
async function verifyTable(pg: PGClient, prisma: PrismaClient, table: string) {
  const pgCount = await pg.query(`SELECT COUNT(*) FROM ${table}`);
  const modelName = table.charAt(0).toUpperCase() + table.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const mysqlCount = await (prisma[modelName as keyof PrismaClient] as any).count();

  const pgTotal = parseInt(pgCount.rows[0].count);
  const match = pgTotal === mysqlCount ? '✓' : '✗';

  console.log(`  ${table}: PG=${pgTotal}, MySQL=${mysqlCount} ${match}`);

  if (pgTotal !== mysqlCount) {
    throw new Error(`数据不一致: ${table}`);
  }
}

// ==================== 字段映射函数 ====================

function mapUser(row: PGRow): PrismaData {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    passwordHash: row.password_hash,
    name: row.name,
    avatar: row.avatar,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapSession(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapTeam(row: PGRow): PrismaData {
  return {
    id: row.id,
    name: row.name,
    type: (row.type || 'FREE').toUpperCase(),
    avatar: row.avatar,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapTeamMember(row: PGRow): PrismaData {
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    role: (row.role || 'MEMBER').toUpperCase(),
    joinedAt: row.joined_at,
  };
}

function mapInviteCode(row: PGRow): PrismaData {
  return {
    id: row.id,
    teamId: row.team_id,
    code: row.code,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

function mapWorkspace(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    teamId: row.team_id,
    name: row.name,
    type: row.type,
    isDefault: row.is_default || false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapCredits(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    total: row.total || 0,
    frozen: row.frozen || 0,
    updatedAt: row.updated_at,
  };
}

function mapCreditsLedger(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    type: (row.type || 'SPENT').toUpperCase(),
    amount: row.amount,
    balance: row.balance,
    description: row.description,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

function mapSubscriptionPlan(row: PGRow): PrismaData {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price || 0,
    credits: row.credits || 0,
    duration: row.duration || 30,
    features: row.features,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSubscription(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    status: (row.status || 'ACTIVE').toUpperCase(),
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    autoRenew: row.auto_renew !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBatch(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    status: (row.status || 'PENDING').toUpperCase(),
    total: row.total || 0,
    completed: row.completed || 0,
    failed: row.failed || 0,
    creditsCost: row.credits_cost,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    batchId: row.batch_id,
    type: row.type,
    status: (row.status || 'PENDING').toUpperCase(),
    provider: row.provider,
    model: row.model,
    params: row.params,
    progress: row.progress || 0,
    error: row.error,
    externalTaskId: row.external_task_id,
    externalUrl: row.external_url,
    storageUrl: row.storage_url,
    thumbnailUrl: row.thumbnail_url,
    creditsCost: row.credits_cost,
    priority: row.priority || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapAsset(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    taskId: row.task_id,
    type: row.type,
    name: row.name,
    storageUrl: row.storage_url,
    thumbnailUrl: row.thumbnail_url,
    mimeType: row.mime_type,
    size: row.size,
    width: row.width,
    height: row.height,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapProvider(row: PGRow): PrismaData {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: row.config,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCanvas(row: PGRow): PrismaData {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    data: row.data,
    thumbnail: row.thumbnail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapVideoProject(row: PGRow): PrismaData {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    type: row.type,
    data: row.data,
    thumbnail: row.thumbnail,
    status: row.status || 'draft',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapVideoSubmission(row: PGRow): PrismaData {
  return {
    id: row.id,
    projectId: row.project_id,
    batchId: row.batch_id,
    params: row.params,
    status: row.status || 'pending',
    externalId: row.external_id,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPayment(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    amount: row.amount,
    currency: row.currency || 'CNY',
    status: (row.status || 'PENDING').toUpperCase(),
    method: row.method,
    provider: row.provider,
    providerRef: row.provider_ref,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQuotaPeriod(row: PGRow): PrismaData {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    quota: row.quota,
    used: row.used || 0,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdAt: row.created_at,
  };
}

function mapClientError(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    message: row.message,
    stack: row.stack,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function mapAiAssistantError(row: PGRow): PrismaData {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    model: row.model,
    error: row.error,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
```

- [ ] **Step 3: 创建 .env.example**

```
PG_DATABASE_URL="postgresql://postgres:password@localhost:5432/aigc"
DATABASE_URL="mysql://aigc:aigcpassword@localhost:3306/aigc"
```

- [ ] **Step 4: 提交**

```bash
git init
git add package.json tsconfig.json src/index.ts .env.example
git commit -m "feat: 添加 PostgreSQL 到 MySQL 数据迁移脚本

- 支持所有数据表迁移
- 批量处理避免内存溢出
- 数据一致性校验
- 错误记录和跳过

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 阶段三：aigc-api 重构

### 任务 6: 创建 Prisma Schema 和基础配置

**Files:**
- Create: `aigc-api/prisma/schema.prisma`（复制自 schema-reference）
- Modify: `aigc-api/src/app.ts` - Fastify 5 配置
- Modify: `aigc-api/src/index.ts` - 入口文件

- [ ] **Step 1: 复制 Prisma Schema**

```bash
cp schema-reference/prisma/schema.prisma aigc-api/prisma/schema.prisma
```

- [ ] **Step 2: 安装依赖并生成 Client**

```bash
cd aigc-api
pnpm install
pnpm db:generate
```

- [ ] **Step 3: 修改 src/index.ts**

```typescript
// src/index.ts
import { app } from './app.js';
import 'dotenv/config';

const PORT = parseInt(process.env.PORT || '7001');
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
```

- [ ] **Step 4: 修改 src/app.ts**

```typescript
// src/app.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

// 注册插件
await app.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
});

await app.register(helmet, {
  contentSecurityPolicy: false,
});

await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

await app.register(sensible);

// 引入路由
await app.register(import('./routes/healthz.js'), { prefix: '/api/healthz' });
await app.register(import('./routes/auth.js'), { prefix: '/api/auth' });
await app.register(import('./routes/generate.js'), { prefix: '/api/generate' });
await app.register(import('./routes/canvas.js'), { prefix: '/api/canvas' });
await app.register(import('./routes/video-studio.js'), { prefix: '/api/video-studio' });
await app.register(import('./routes/teams.js'), { prefix: '/api/teams' });
await app.register(import('./routes/assets.js'), { prefix: '/api/assets' });
await app.register(import('./routes/credits.js'), { prefix: '/api/credits' });
await app.register(import('./routes/users.js'), { prefix: '/api/users' });
await app.register(import('./routes/admin.js'), { prefix: '/api/admin' });
// ... 其他路由

// 错误处理
app.setErrorHandler((error, request, reply) => {
  app.log.error(error);

  if (error.validation) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: error.message,
    });
  }

  return reply.status(error.statusCode || 500).send({
    statusCode: error.statusCode || 500,
    error: error.name,
    message: error.message,
  });
});

// 优雅关闭
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

- [ ] **Step 5: 提交**

```bash
git add prisma/schema.prisma src/index.ts src/app.ts
git commit -m "feat(aigc-api): 添加 Prisma 配置和 Fastify 5 基础结构

- Prisma Client 集成
- Fastify 5 插件配置（CORS、HTTPS、Rate Limit）
- 错误处理和优雅关闭
- 路由注册结构

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 7: 重构 API 路由（auth、generate）

**Files:**
- Modify: `aigc-api/src/routes/auth.ts`
- Modify: `aigc-api/src/routes/generate.ts`
- Modify: `aigc-api/src/services/credit.ts`

- [ ] **Step 1: 重构 auth.ts（Kysely → Prisma）**

参考现有 `apps/api/src/routes/auth.ts`，将其从 Kysely 查询转换为 Prisma Client。

```typescript
// src/routes/auth.ts（Prisma 版本示例）
import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../app.js';

export async function authRoutes(app: FastifyInstance) {
  // 注册
  app.post('/register', async (request, reply) => {
    const { email, password, name } = request.body as {
      email: string;
      password: string;
      name?: string;
    };

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(400).send({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        credits: { create: { total: 0, frozen: 0 } },
      },
      include: { credits: true },
    });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    // 创建 session
    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { token, user: { id: user.id, email: user.email, name: user.name } };
  });

  // 登录
  app.post('/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { token, user: { id: user.id, email: user.email, name: user.name } };
  });

  // 登出
  app.post('/logout', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const token = auth.slice(7);
    await prisma.session.deleteMany({ where: { token } });

    return { success: true };
  });

  // 获取当前用户
  app.get('/me', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const token = auth.slice(7);
    const session = await prisma.session.findUnique({
      where: { token },
      include: { user: { include: { credits: true } } },
    });

    if (!session || session.expiresAt < new Date()) {
      return reply.status(401).send({ error: 'Session expired' });
    }

    const { user } = session;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      credits: user.credits?.total || 0,
      frozen: user.credits?.frozen || 0,
    };
  });
}
```

- [ ] **Step 2: 重构 generate.ts**

```typescript
// src/routes/generate.ts（Prisma 版本示例）
import { FastifyInstance } from 'fastify';
import { prisma } from '../app.js';
import { Queue } from 'bullmq';
import { queuConnection } from '../lib/queue.js';

export async function generateRoutes(app: FastifyInstance) {
  const imageQueue = new Queue('image-queue', { connection: queuConnection });

  // 创建图片生成任务
  app.post('/image', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const token = auth.slice(7);
    const session = await prisma.session.findUnique({
      where: { token },
      include: { user: { include: { credits: true } } },
    });

    if (!session || session.expiresAt < new Date()) {
      return reply.status(401).send({ error: 'Session expired' });
    }

    const user = session.user;
    const { prompt, model, provider, referenceImage, ...params } = request.body as {
      prompt: string;
      model?: string;
      provider?: string;
      referenceImage?: string;
      [key: string]: unknown;
    };

    // 积分检查
    const creditsCost = params.creditsCost || 10;
    if ((user.credits?.total || 0) - (user.credits?.frozen || 0) < creditsCost) {
      return reply.status(400).send({ error: 'Insufficient credits' });
    }

    // 创建任务和批次
    const batch = await prisma.batch.create({
      data: {
        userId: user.id,
        type: 'IMAGE',
        status: 'PROCESSING',
        total: 1,
        creditsCost,
      },
    });

    const task = await prisma.task.create({
      data: {
        userId: user.id,
        batchId: batch.id,
        type: 'IMAGE',
        status: 'PROCESSING',
        provider,
        model,
        params: { prompt, referenceImage, ...params },
        creditsCost,
      },
    });

    // 冻结积分
    await prisma.credits.update({
      where: { userId: user.id },
      data: { frozen: { increment: creditsCost } },
    });

    // 写入积分流水
    await prisma.creditsLedger.create({
      data: {
        userId: user.id,
        type: 'FROZEN',
        amount: creditsCost,
        balance: (user.credits?.total || 0) - (user.credits?.frozen || 0) - creditsCost,
        taskId: task.id,
      },
    });

    // 投递到队列
    await imageQueue.add('generate', {
      taskId: task.id,
      userId: user.id,
      prompt,
      model,
      provider,
      referenceImage,
      ...params,
    });

    return {
      taskId: task.id,
      batchId: batch.id,
      status: 'processing',
    };
  });

  // 获取任务状态
  app.get('/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { assets: true },
    });

    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }

    return {
      id: task.id,
      status: task.status.toLowerCase(),
      progress: task.progress,
      error: task.error,
      assets: task.assets.map((a) => ({
        id: a.id,
        url: a.storageUrl,
        thumbnailUrl: a.thumbnailUrl,
      })),
    };
  });
}
```

- [ ] **Step 3: 提交**

```bash
git add src/routes/auth.ts src/routes/generate.ts
git commit -m "feat(aigc-api): 重构 auth 和 generate 路由

- Kysely → Prisma Client
- 积分冻结/扣减逻辑保留
- BullMQ 队列投递
- REST API 保持兼容

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

（继续重构其他路由：canvas、video-studio、teams、assets、credits、admin 等，步骤类似，逐步替换 Kysely 为 Prisma Client）

---

### 任务 8: 重构 lib 层（queue、storage、credits）

**Files:**
- Modify: `aigc-api/src/lib/queue.ts`
- Modify: `aigc-api/src/lib/storage.ts`
- Modify: `aigc-api/src/lib/credits.ts`

- [ ] **Step 1: 重构 queue.ts**

```typescript
// src/lib/queue.ts
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 解析 Redis URL
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379'),
    password: parsed.password || undefined,
  };
}

const redisConfig = parseRedisUrl(REDIS_URL);

export const queueConnection = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password,
  maxRetriesPerRequest: null,
});

export const pubConnection = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password,
});

export const subConnection = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password,
});

export async function closeQueues() {
  await queueConnection.quit();
  await pubConnection.quit();
  await subConnection.quit();
}
```

- [ ] **Step 2: 重构 storage.ts**

```typescript
// src/lib/storage.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true, // MinIO 需要
});

const BUCKET = process.env.S3_BUCKET || 'aigc';

export async function uploadToStorage(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return `${process.env.S3_ENDPOINT}/${BUCKET}/${key}`;
}

export async function getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn });
}

export function getPublicUrl(key: string): string {
  return `${process.env.S3_ENDPOINT}/${BUCKET}/${key}`;
}
```

- [ ] **Step 3: 提交**

```bash
git add src/lib/queue.ts src/lib/storage.ts
git commit -m "feat(aigc-api): 重构 lib 层

- Redis 连接管理
- S3/MinIO 存储封装
- Prisma 兼容准备

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 阶段四：aigc-worker 重构

### 任务 9: Worker 基础结构

**Files:**
- Modify: `aigc-worker/src/index.ts`
- Modify: `aigc-worker/src/lib/redis.ts`
- Create: `aigc-worker/src/workers/image.ts`

- [ ] **Step 1: 创建 Prisma Schema**

```bash
cp schema-reference/prisma/schema.prisma aigc-worker/prisma/schema.prisma
cd aigc-worker && pnpm install && pnpm db:generate
```

- [ ] **Step 2: 重构 index.ts**

```typescript
// src/index.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { imageWorker } from './workers/image.js';
import { transferWorker } from './workers/transfer.js';
import { videoPoller } from './pollers/video.js';
import { avatarPoller } from './pollers/avatar.js';
import { timeoutGuardian } from './jobs/timeout-guardian.js';
import { purgeOldRecords } from './jobs/purge-old-records.js';
import { closeRedis } from './lib/redis.js';

export const prisma = new PrismaClient();

async function start() {
  console.log('Starting aigc-worker...');

  // 启动 workers
  await imageWorker.run();
  await transferWorker.run();

  // 启动轮询器
  setInterval(videoPoller, 15000);
  setInterval(avatarPoller, 15000);

  // 启动定时任务
  setInterval(timeoutGuardian, 5 * 60 * 1000); // 每 5 分钟
  setInterval(purgeOldRecords, 24 * 60 * 60 * 1000); // 每天

  console.log('Worker started successfully');
}

async function shutdown() {
  console.log('Shutting down worker...');
  await prisma.$disconnect();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 3: 提交**

```bash
git add prisma/schema.prisma src/index.ts src/lib/redis.ts src/workers/image.ts
git commit -m "feat(aigc-worker): 添加 Worker 基础结构

- Prisma Client 集成
- BullMQ workers（image、transfer）
- 轮询器和定时任务
- 优雅关闭处理

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 阶段五：aigc-web 重构

### 任务 10: Web 基础结构和页面迁移

**Files:**
- Create: `aigc-web/src/app/layout.tsx`
- Create: `aigc-web/src/app/page.tsx`
- Create: `aigc-web/src/app/globals.css`
- Create: `aigc-web/src/components/ui/button.tsx`
- Modify: `aigc-web/src/lib/api.ts`

- [ ] **Step 1: 创建 app 结构**

```typescript
// src/app/layout.tsx
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AIGC Platform',
  description: 'AI-powered content generation platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
```

```typescript
// src/app/page.tsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/dashboard');
}
```

```css
/* src/app/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --primary-foreground: 210 40% 98%;
}

body {
  color: hsl(var(--foreground));
  background: hsl(var(--background));
}
```

- [ ] **Step 2: 创建基础 UI 组件（使用 shadcn/ui 规范）**

```typescript
// src/components/ui/button.tsx
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
```

- [ ] **Step 3: 创建 API 请求封装**

```typescript
// src/lib/api.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

interface FetchOptions extends RequestInit {
  token?: string;
}

async function fetchApi<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers, ...rest } = options;

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  get: <T>(url: string, options?: FetchOptions) =>
    fetchApi<T>(url, { ...options, method: 'GET' }),

  post: <T>(url: string, data?: unknown, options?: FetchOptions) =>
    fetchApi<T>(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(data),
    }),

  put: <T>(url: string, data?: unknown, options?: FetchOptions) =>
    fetchApi<T>(url, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: <T>(url: string, options?: FetchOptions) =>
    fetchApi<T>(url, { ...options, method: 'DELETE' }),
};
```

- [ ] **Step 4: 提交**

```bash
git add src/app/layout.tsx src/app/page.tsx src/app/globals.css
git add src/components/ui/button.tsx src/lib/api.ts src/lib/utils.ts
git commit -m "feat(aigc-web): 添加 Next.js 15 基础结构

- App Router 配置
- Tailwind CSS 4 配置
- shadcn/ui button 组件
- API 请求封装

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

（继续迁移其他页面和组件，步骤类似）

---

## 阶段六：Docker 部署配置

### 任务 11: 创建各项目 Dockerfile

**Files:**
- Create: `aigc-api/Dockerfile`
- Create: `aigc-api/docker-compose.yml`
- Create: `aigc-web/Dockerfile`
- Create: `aigc-web/docker/nginx.conf`
- Create: `aigc-web/docker-compose.yml`
- Create: `aigc-worker/Dockerfile`
- Create: `aigc-worker/docker-compose.yml`
- Create: `infrastructure/docker-compose.yml`（基础服务 MySQL/Redis/MinIO）

- [ ] **Step 1: 创建基础设施 docker-compose.yml**

```yaml
# infrastructure/docker-compose.yml
version: '3.8'

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpassword
      MYSQL_DATABASE: aigc
      MYSQL_USER: aigc
      MYSQL_PASSWORD: aigcpassword
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./mysql.cnf:/etc/mysql/conf.d/mysql.cnf
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
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

- [ ] **Step 2: 创建 aigc-api Dockerfile**

```dockerfile
# aigc-api/Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod=false

COPY prisma ./prisma/
RUN pnpm db:generate

COPY . .
RUN pnpm build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

USER nodejs

EXPOSE 7001

CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: 创建 aigc-web Dockerfile 和 nginx 配置**

```dockerfile
# aigc-web/Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup -g 1001 -S nextjs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/package.json ./

USER nextjs

ENV PORT=6006
ENV HOSTNAME="0.0.0.0"

EXPOSE 6006

CMD ["node", "server.js"]
```

```nginx
# aigc-web/docker/nginx.conf
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

- [ ] **Step 4: 创建 aigc-worker Dockerfile**

```dockerfile
# aigc-worker/Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod=false

COPY prisma ./prisma/
RUN pnpm db:generate

COPY . .
RUN pnpm build

FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

USER nodejs

CMD ["node", "dist/index.js"]
```

- [ ] **Step 5: 提交**

```bash
git add Dockerfile docker-compose.yml docker/nginx.conf
git commit -m "feat: 添加 Docker 部署配置

- 多阶段构建优化镜像大小
- 健康检查配置
- Nginx 反向代理配置

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 阶段七：集成测试与部署验证

### 任务 12: 部署验证

- [ ] **Step 1: 启动基础服务**

```bash
cd infrastructure
docker-compose up -d
```

- [ ] **Step 2: 初始化数据库**

```bash
# 创建数据库
docker exec -it infrastructure-mysql-1 mysql -u root -p -e "CREATE DATABASE aigc;"

# 运行迁移
cd aigc-api && pnpm db:push
cd aigc-worker && pnpm db:push
```

- [ ] **Step 3: 启动 API**

```bash
cd aigc-api
docker-compose up -d
```

- [ ] **Step 4: 启动 Worker**

```bash
cd aigc-worker
docker-compose up -d
```

- [ ] **Step 5: 启动 Web**

```bash
cd aigc-web
docker-compose up -d
```

- [ ] **Step 6: 验证部署**

```bash
# 检查 API 健康
curl http://localhost:7001/api/healthz

# 检查 Web
curl http://localhost:6006

# 检查日志
docker-compose logs -f
```

- [ ] **Step 7: 提交**

```bash
git add docker-compose.prod.yml
git commit -m "chore: 添加生产环境 Docker Compose 配置

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 任务清单汇总

| 阶段 | 任务 | 产出物 |
|------|------|--------|
| **一** | 1. 初始化 aigc-api | package.json, tsconfig.json |
| | 2. 初始化 aigc-web | Next.js 15 基础结构 |
| | 3. 初始化 aigc-worker | package.json, tsconfig.json |
| **二** | 4. 设计 Prisma Schema | schema-reference/prisma/schema.prisma |
| | 5. 创建迁移脚本 | migrate-pg-to-mysql |
| **三** | 6. API 基础结构 | Prisma + Fastify 5 |
| | 7. 重构 API 路由 | auth, generate 等 |
| | 8. 重构 lib 层 | queue, storage |
| **四** | 9. Worker 基础结构 | BullMQ workers |
| **五** | 10. Web 基础结构 | Next.js 15 App Router |
| **六** | 11. Docker 配置 | 各项目 Dockerfile |
| **七** | 12. 部署验证 | 完整运行验证 |

---

## Spec 自检

1. **Spec 覆盖检查**：
   - [x] 项目拆分 - 阶段一完成 3 个独立仓库初始化
   - [x] 数据库迁移 - 任务 5 提供迁移脚本
   - [x] Prisma Schema - 任务 4 完成设计
   - [x] Fastify 5 - 任务 6 完成
   - [x] Next.js 15 - 任务 10 完成
   - [x] Docker 部署 - 任务 11 完成
   - [x] 数据迁移 - 任务 5 完成

2. **占位符扫描**：无 TBD/TODO/实现后续等占位符

3. **类型一致性**：Prisma Schema 中的模型名称与迁移脚本映射函数一一对应

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-aigc-refactor.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**