/**
 * Prisma Client 单例（Worker 专用）
 *
 * 提供统一的 Prisma 实例供 Worker 项目使用。
 * 使用单例模式防止进程重启时连接断开。
 */

import { PrismaClient } from '@aigc/db'

// 全局变量用于防止连接断开
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

// PrismaClient 实例
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  // 生产环境只记录错误，开发环境记录查询日志
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

// 开发环境下全局化 Prisma 实例
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// 导出关闭函数，用于优雅关闭
export async function closePrisma(): Promise<void> {
  await prisma.$disconnect()
}