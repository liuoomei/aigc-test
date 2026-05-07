/**
 * Prisma Client 单例
 *
 * 提供统一的 Prisma 实例供 API 路由使用。
 * 使用单例模式防止 HMR 时连接断开。
 */

import { PrismaClient } from '@aigc/db'

// 全局变量用于开发环境（防止 HMR 断开连接）
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

// PrismaClient 实例
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  // 日志配置：开发环境输出查询日志
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

// 开发环境下全局化 Prisma 实例
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// 导出关闭函数，用于优雅关闭
export { prisma as db }