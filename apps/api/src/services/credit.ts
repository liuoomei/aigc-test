import { prisma } from '../lib/prisma.js'

function computeNextReset(period: string): Date {
  const now = new Date()
  if (period === 'weekly') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
  }
  // monthly: same day next month
  return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/**
 * Freeze credits from team pool. Checks member quota if set.
 * Uses row-level locks to prevent race conditions.
 */
export async function freezeCredits(
  teamId: string,
  userId: string,
  amount: number,
): Promise<{ creditAccountId: string }> {
  return await prisma.$transaction(async (tx) => {
    // 1. Lock the team credit account FIRST to serialize concurrent requests
    const account = await tx.creditAccount.findFirst({
      where: { team_id: teamId, owner_type: 'team' },
    })

    if (!account) {
      throw new Error('未找到团队积分账户')
    }

    if (account.balance - account.frozen_credits < amount) {
      throw new Error('团队积分余额不足')
    }

    // 2. Lock and check member quota (after team lock to prevent race)
    const member = await tx.teamMember.findFirst({
      where: { team_id: teamId, user_id: userId },
    })

    // Auto-reset credit_used if quota period has elapsed
    if (member?.quota_period && member?.quota_reset_at) {
      const resetAt = new Date(member.quota_reset_at)
      if (new Date() >= resetAt) {
        const nextReset = computeNextReset(member.quota_period)
        await tx.teamMember.update({
          where: { team_id_user_id: { team_id: teamId, user_id: userId } },
          data: {
            credit_used: 0,
            quota_reset_at: nextReset,
          },
        })
      }
    }

    if (member?.credit_quota !== null && member?.credit_quota !== undefined) {
      const currentCreditUsed = member.quota_reset_at && new Date() >= new Date(member.quota_reset_at) ? 0 : member.credit_used
      if ((currentCreditUsed ?? 0) + amount > member.credit_quota) {
        throw new Error('个人积分配额已用尽，请联系团队负责人增加配额')
      }
    }

    // 3. Freeze from team pool
    await tx.creditAccount.update({
      where: { id: account.id },
      data: { frozen_credits: { increment: amount } },
    })

    // 4. Update member usage
    await tx.teamMember.update({
      where: { team_id_user_id: { team_id: teamId, user_id: userId } },
      data: { credit_used: { increment: amount } },
    })

    // 5. Ledger entry
    await tx.creditsLedger.create({
      data: {
        credit_account_id: account.id,
        user_id: userId,
        amount: -amount,
        type: 'freeze',
        description: 'Credits frozen for image generation',
      },
    })

    return { creditAccountId: account.id }
  })
}

/**
 * Confirm credits after successful task completion.
 */
export async function confirmCredits(
  creditAccountId: string,
  userId: string,
  amount: number,
  taskId?: string,
  batchId?: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.creditAccount.update({
      where: { id: creditAccountId },
      data: {
        balance: { decrement: amount },
        frozen_credits: { decrement: amount },
        total_spent: { increment: amount },
      },
    }),
    prisma.creditsLedger.create({
      data: {
        credit_account_id: creditAccountId,
        user_id: userId,
        amount: -amount,
        type: 'confirm',
        task_id: taskId ?? null,
        batch_id: batchId ?? null,
        description: 'Credits confirmed for completed task',
      },
    }),
  ])
}

/**
 * Refund credits after task failure.
 */
export async function refundCredits(
  teamId: string,
  creditAccountId: string,
  userId: string,
  amount: number,
  taskId?: string,
  batchId?: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.creditAccount.update({
      where: { id: creditAccountId },
      data: { frozen_credits: { decrement: amount } },
    }),
    prisma.teamMember.update({
      where: { team_id_user_id: { team_id: teamId, user_id: userId } },
      data: { credit_used: { decrement: Math.max(0, amount) } },
    }),
    prisma.creditsLedger.create({
      data: {
        credit_account_id: creditAccountId,
        user_id: userId,
        amount,
        type: 'refund',
        task_id: taskId ?? null,
        batch_id: batchId ?? null,
        description: 'Credits refunded for failed task',
      },
    }),
  ])
}
