/**
 * 任务失败管线
 *
 * 在单个事务中完成：
 * 1. 更新任务状态为失败
 * 2. 退还冻结积分
 * 3. 写入积分流水
 * 4. 更新批次计数
 *
 * ⚠️  此处有幂等保护，重复调用安全
 */

import { prisma } from '../lib/prisma.js'
import type { GenerationJobData } from '@aigc/types'
import { getPubRedis } from '../lib/redis.js'

/**
 * 任务失败管线
 * @param jobData 任务数据
 * @param errorMessage 错误信息
 */
export async function failPipeline(
  jobData: GenerationJobData,
  errorMessage: string,
): Promise<void> {
  const { taskId, batchId, userId, teamId, creditAccountId, estimatedCredits } = jobData

  // 执行数据库事务
  await prisma.$transaction(async (tx) => {
    // 1. 更新任务状态（幂等保护：只更新未完成的任务）
    const taskUpdate = await tx.task.updateMany({
      where: {
        id: taskId,
        status: { not: 'completed' },
        NOT: [{ status: 'failed' }],
      },
      data: {
        status: 'failed',
        error_message: errorMessage.slice(0, 1000),
        completed_at: new Date(),
      },
    })

    // 如果任务已处理过，跳过退款
    if (taskUpdate.count === 0) {
      return
    }

    // 2. 退还积分：frozen -= cost（积分从未从余额扣除）
    await tx.creditAccount.update({
      where: { id: creditAccountId },
      data: {
        frozen_credits: { decrement: estimatedCredits },
      },
    })

    // 3. 调整团队成员积分使用量
    if (teamId) {
      await tx.teamMember.updateMany({
        where: { team_id: teamId, user_id: userId },
        data: {
          credit_used: { decrement: estimatedCredits },
        },
      })
    }

    // 4. 写入积分流水
    await tx.creditsLedger.create({
      data: {
        credit_account_id: creditAccountId,
        user_id: userId,
        amount: estimatedCredits,
        type: 'refund',
        task_id: taskId,
        batch_id: batchId,
        description: `Image generation failed: ${errorMessage.slice(0, 200)}`,
      },
    })

    // 5. 更新批次计数
    await tx.taskBatch.update({
      where: { id: batchId },
      data: {
        failed_count: { increment: 1 },
      },
    })

    // 查询批次状态
    const batch = await tx.taskBatch.findUnique({
      where: { id: batchId },
      select: { quantity: true, completed_count: true, failed_count: true, status: true },
    })

    if (batch) {
      const totalDone = batch.completed_count + batch.failed_count

      // 如果批次仍处于 pending 状态且这是第一个完成的任务，标记为 processing
      if (batch.status === 'pending' && totalDone === 1) {
        await tx.taskBatch.update({
          where: { id: batchId, status: 'pending' },
          data: { status: 'processing' },
        })
      }

      // 检查是否需要更新为最终状态
      if (totalDone >= batch.quantity) {
        let batchStatus: 'failed' | 'partial_complete' = 'partial_complete'
        if (batch.completed_count === 0) batchStatus = 'failed'

        await tx.taskBatch.update({
          where: { id: batchId },
          data: { status: batchStatus },
        })
      }
    }
  })

  // 6. 发布 SSE 事件（在事务外）
  await getPubRedis().publish(`sse:batch:${batchId}`, JSON.stringify({ event: 'batch_update' }))
}