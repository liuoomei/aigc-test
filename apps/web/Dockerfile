# ============================================
# Web 前端 Dockerfile（多阶段构建）
# ============================================

# ── 构建阶段 ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# 启用 pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# 安装依赖
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# 复制源码
COPY . .

# 构建 Next.js 应用
RUN pnpm build

# ── 生产阶段 ────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# 创建非 root 用户
RUN addgroup -g 1001 -S nextjs && adduser -S nextjs -u 1001

# 复制 Next.js standalone 构建产物
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/package.json ./

# 切换到非 root 用户
USER nextjs

# 环境变量
ENV PORT=6006
ENV HOSTNAME="0.0.0.0"

# 暴露端口
EXPOSE 6006

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:6006/ || exit 1

# 启动命令
CMD ["node", "server.js"]