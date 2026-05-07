// Prisma Client 统一导出
// 供 API 和 Worker 项目使用
import { PrismaClient } from '@prisma/client';

// Re-export PrismaClient for consumers
export { PrismaClient } from '@prisma/client';

// PrismaClient 实例（单例模式）
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  // 日志配置：开发环境输出到控制台
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

// 开发环境下全局化 Prisma 实例，防止 HMR 时断开连接
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// 关闭连接（用于优雅关闭）
export async function closePrisma(): Promise<void> {
  await prisma.$disconnect()
}