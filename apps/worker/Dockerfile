# ============================================
# Worker 服务 Dockerfile（多阶段构建）
# ============================================

# ── 构建阶段 ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# 启用 pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# 安装依赖
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false

# 复制 Prisma Schema
COPY packages/db/prisma ./packages/db/prisma/
RUN pnpm --filter @aigc/db generate

# 复制源码并构建
COPY apps/worker ./apps/worker/
COPY packages/types ./packages/types/
COPY packages/db/dist ./packages/db/dist/
RUN pnpm --filter @aigc/worker build

# ── 生产阶段 ────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# 从构建阶段复制产物
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/packages/db/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

# 只复制生产依赖
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# 切换到非 root 用户
USER nodejs

# 启动命令（需要加载 .env 文件）
CMD ["node", "dist/index.js"]