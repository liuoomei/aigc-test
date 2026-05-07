/**
 * 任务完成管线
 *
 * 在单个事务中完成：
 * 1. 创建资产记录
 * 2. 确认积分（frozen → spent）
 * 3. 写入积分流水
 * 4. 更新任务状态
 * 5. 更新批次计数
 * 6. Canvas 输出追踪
 *
 * ⚠️  此处有幂等保护，重复调用安全
 */

import { prisma } from '../lib/prisma.js'
import type { GenerationJobData } from '@aigc/types'
import { Queue } from 'bullmq'
import { getRedis } from '../lib/redis.js'

// 转存队列单例
let _transferQueue: Queue | null = null

function getTransferQueue(): Queue {
  if (!_transferQueue) {
    _transferQueue = new Queue('transfer-queue', { connection: getRedis() })
  }
  return _transferQueue
}

/**
 * 任务完成管线
 * @param jobData 任务数据
 * @param outputUrl 输出 URL
 * @param actualCredits 实际消耗积分
 */
export async function completePipeline(
  jobData: GenerationJobData,
  outputUrl: string,
  actualCredits: number,
): Promise<void> {
  // 积分校验：防止异常值
  if (actualCredits < 0) actualCredits = 0
  if (actualCredits > jobData.estimatedCredits * 3) {
    actualCredits = jobData.estimatedCredits
  }

  const { taskId, batchId, userId, teamId, creditAccountId, estimatedCredits, canvasId, canvasNodeId } = jobData

  // 执行数据库事务
  const assetId = await prisma.$transaction(async (tx) => {
    // 1. 创建资产记录
    const asset = await tx.asset.create({
      data: {
        task_id: taskId,
        batch_id: batchId,
        user_id: userId,
        type: 'image',
        original_url: outputUrl,
        transfer_status: 'pending',
      },
    })

    // 2. 确认积分：frozen -= estimated, balance -= actual, total_spent += actual
    await tx.creditAccount.update({
      where: { id: creditAccountId },
      data: {
        frozen_credits: { decrement: estimatedCredits },
        balance: { decrement: actualCredits },
        total_spent: { increment: actualCredits },
      },
    })

    // 调整团队成员积分使用量（如果实际与预估不同）
    if (teamId && actualCredits !== estimatedCredits) {
      const delta = actualCredits - estimatedCredits
      await tx.teamMember.updateMany({
        where: { team_id: teamId, user_id: userId },
        data: { credit_used: { increment: delta } },
      })
    }

    // 3. 写入积分流水
    await tx.creditsLedger.create({
      data: {
        credit_account_id: creditAccountId,
        user_id: userId,
        amount: -actualCredits,
        type: 'confirm',
        task_id: taskId,
        batch_id: batchId,
        description: 'Image generation confirmed',
      },
    })

    // 4. 更新任务状态（幂等保护：只更新未完成的任务）
    const taskUpdateResult = await tx.task.updateMany({
      where: {
        id: taskId,
        status: { not: 'completed' },
        NOT: [{ status: 'failed' }],
      },
      data: {
        status: 'completed',
        credits_cost: actualCredits,
        completed_at: new Date(),
      },
    })

    // 如果任务已处理过，跳过剩余步骤
    if (taskUpdateResult.count === 0) {
      return asset.id
    }

    // 5. 更新批次计数
    await tx.taskBatch.update({
      where: { id: batchId },
      data: {
        completed_count: { increment: 1 },
        actual_credits: { increment: actualCredits },
      },
    })

    // 查询批次状态（带行锁）
    const batch = await tx.taskBatch.findUnique({
      where: { id: batchId },
      select: { quantity: true, completed_count: true, failed_count: true },
    })

    if (batch) {
      const totalDone = batch.completed_count + batch.failed_count

      // 确定批次最终状态
      if (totalDone >= batch.quantity) {
        let batchStatus: 'completed' | 'failed' | 'partial_complete' = 'partial_complete'
        if (batch.failed_count === 0) batchStatus = 'completed'
        else if (batch.completed_count === 0) batchStatus = 'failed'

        await tx.taskBatch.update({
          where: { id: batchId },
          data: { status: batchStatus },
        })
      } else if (batch.completed_count === 1 && batch.failed_count === 0) {
        // 第一个任务完成时，标记批次为处理中
        await tx.taskBatch.update({
          where: { id: batchId, status: 'pending' },
          data: { status: 'processing' },
        })
      }
    }

    return asset.id
  })

  // 6. 发布 SSE 事件（在事务外）
  const pubRedis = getRedis()
  await pubRedis.publish(`sse:batch:${batchId}`, JSON.stringify({ event: 'batch_update' }))

  // 6b. Canvas 输出追踪
  if (canvasId && canvasNodeId) {
    const paramsSnapshot = JSON.stringify({
      prompt: jobData.prompt,
      model: jobData.model,
      params: jobData.params,
    })

    // 先取消所有该节点的选中状态
    await prisma.canvasNodeOutput.updateMany({
      where: { canvas_id: canvasId, node_id: canvasNodeId },
      data: { is_selected: false },
    })

    // 创建新的选中输出
    await prisma.canvasNodeOutput.create({
      data: {
        canvas_id: canvasId,
        node_id: canvasNodeId,
        batch_id: batchId,
        user_id: userId,
        output_urls: [outputUrl],
        params_snapshot: paramsSnapshot,
        is_selected: true,
      },
    })

    // 增加 Redis dirty version，使轮询器检测到变化
    await pubRedis.incr(`canvas:dirty:${canvasId}`)
    await pubRedis.expire(`canvas:dirty:${canvasId}`, 60 * 60 * 24)
  }

  // 7. 投递转存任务
  await getTransferQueue().add('transfer', {
    taskId,
    assetId,
    originalUrl: outputUrl,
  })
}