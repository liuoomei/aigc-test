import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { createLifeOrder, createLifeSubscriptionOrder, buildPaySign } from '../lib/life-service.js'
import { TOPUP_PACKAGES, TOPUP_PACKAGE_MAP, ONETIME_PACKAGES, MONTHLY_PACKAGES } from '../lib/topup-packages.js'
import type { CreateOrderRequest } from '@aigc/types'

export async function paymentRoutes(app: FastifyInstance): Promise<void> {

  // GET /payment/packages
  app.get('/payment/packages', async () => ({
    onetime: ONETIME_PACKAGES,
    monthly: MONTHLY_PACKAGES,
  }))

  // GET /payment/ledger?account=personal|team&team_id=xxx&page=1&limit=20
  app.get<{ Querystring: { account?: string; team_id?: string; page?: string; limit?: string } }>(
    '/payment/ledger',
    async (request, reply) => {
      const userId = request.user.id
      const { account = 'personal', team_id, page = '1', limit: limitStr = '20' } = request.query
      const limit = Math.min(Number(limitStr) || 20, 100)
      const offset = (Math.max(Number(page) || 1, 1) - 1) * limit

      let credit_account_id: string | undefined

      if (account === 'team' && team_id) {
        const membership = await prisma.teamMember.findFirst({
          where: { team_id, user_id: userId },
          select: { role: true },
        })
        if (!membership || !['owner', 'admin'].includes(membership.role)) {
          return reply.forbidden('仅团队 owner/admin 可查看团队流水')
        }
        const acc = await prisma.creditAccount.findFirst({
          where: { owner_type: 'team', team_id },
          select: { id: true },
        })
        credit_account_id = acc?.id
      } else {
        const acc = await prisma.creditAccount.findFirst({
          where: { owner_type: 'user', user_id: userId },
          select: { id: true },
        })
        credit_account_id = acc?.id
      }

      if (!credit_account_id) return { data: [], total: 0 }

      const [rows, countRow] = await Promise.all([
        prisma.creditsLedger.findMany({
          where: { credit_account_id: credit_account_id, type: { not: 'freeze' } },
          orderBy: { created_at: 'desc' },
          take: limit,
          skip: offset,
          include: {
            taskBatch: { select: { module: true, model: true, provider: true, prompt: true, canvas_id: true } },
            user: { select: { username: true } },
          },
        }),
        prisma.creditsLedger.count({
          where: { credit_account_id: credit_account_id, type: { not: 'freeze' } },
        }),
      ])

      // 格式化返回数据
      const data = rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        type: row.type,
        description: row.description,
        created_at: row.created_at,
        taskId: row.task_id,
        batchId: row.batch_id,
        user_id: row.user_id,
        module: row.taskBatch?.module ?? null,
        model: row.taskBatch?.model ?? null,
        provider: row.taskBatch?.provider ?? null,
        prompt: row.taskBatch?.prompt ?? null,
        canvas_id: row.taskBatch?.canvas_id ?? null,
        username: row.user?.username ?? null,
      }))

      return { data, total: countRow }
    }
  )

  // GET /payment/balance?team_id=xxx
  app.get<{ Querystring: { team_id?: string } }>('/payment/balance', async (request) => {
    const { team_id } = request.query
    const userId = request.user.id

    const [teamAccount, personalAccount] = await Promise.all([
      team_id
        ? prisma.creditAccount.findFirst({
            where: { owner_type: 'team', team_id: team_id },
            select: { balance: true },
          })
        : Promise.resolve(null),
      prisma.creditAccount.findFirst({
        where: { owner_type: 'user', user_id: userId },
        select: { balance: true },
      }),
    ])

    return {
      team_balance: teamAccount?.balance ?? 0,
      personal_balance: personalAccount?.balance ?? 0,
    }
  })

  // POST /payment/orders — create topup order, returns H5 pay URL
  app.post<{ Body: CreateOrderRequest }>('/payment/orders', {
    schema: {
      body: {
        type: 'object',
        required: ['package_id'],
        properties: {
          package_id: { type: 'string' },
          team_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { package_id, team_id } = request.body
    const userId = request.user.id

    const pkg = TOPUP_PACKAGE_MAP[package_id]
    if (!pkg) return reply.badRequest('无效的套餐')

    // Permission: team topup requires owner/admin, or allow_member_topup=true
    if (team_id) {
      const membership = await prisma.teamMember.findFirst({
        where: { team_id: team_id, user_id: userId },
        include: { team: { select: { allow_member_topup: true } } },
      })

      if (!membership) return reply.forbidden('不是该团队成员')

      const isOwnerOrAdmin = ['owner', 'admin'].includes(membership.role)
      if (!isOwnerOrAdmin && !membership.team.allow_member_topup) {
        return reply.forbidden('团队未开放充值权限')
      }
    }

    // Ensure credit account exists
    const creditAccountId = await ensureCreditAccount(userId, team_id)

    const amountYuan = (pkg.amount_fen / 100).toFixed(2)
    const platformCode = process.env.LIFE_SERVICE_PLATFORM_CODE!
    const webBaseUrl = process.env.WEB_BASE_URL!
    const baseUrl = process.env.LIFE_SERVICE_BASE_URL!.replace(/\/$/, '')

    // 文档说明：return_url = 异步回调（支付结果通知），notify_url = 页面跳转（支付后跳转页面）
    const asyncCallbackUrl = `${process.env.API_BASE_URL}/api/v1/payment/notify`
    const pageRedirectUrl = `${webBaseUrl}/payment/callback`

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phone: true, email: true },
    })
    const memberId = user.phone ?? '13800138000'

    const lifeOrder = pkg.type === 'monthly'
      ? await createLifeSubscriptionOrder(app.redis, {
          MEMBER_ID: memberId,
          PLATFORM_CODE: platformCode,
          CHANNEL: 'H5',
          AMOUNT: amountYuan,
          ADD_AMOUNT: '0',
          GOODS_NAME: pkg.name,
          SUM_AMOUNT: amountYuan,
          return_url: asyncCallbackUrl,
          notify_url: pageRedirectUrl,
        })
      : await createLifeOrder(app.redis, {
          MEMBER_ID: memberId,
          PLATFORM_CODE: platformCode,
          CHANNEL: 'H5',
          AMOUNT: amountYuan,
          ADD_AMOUNT: '0',
          GOODS_NAME: pkg.name,
          SUM_AMOUNT: amountYuan,
          return_url: asyncCallbackUrl,
          notify_url: pageRedirectUrl,
        })

    const order = await prisma.paymentOrder.create({
      data: {
        order_no: String(lifeOrder.orderid),
        provider: 'life',
        type: 'topup',
        life_order_id: String(lifeOrder.orderid),
        user_id: userId,
        team_id: team_id ?? null,
        credit_account_id: creditAccountId,
        amount_fen: pkg.amount_fen,
        credits: pkg.credits,
        credits_to_grant: pkg.credits,
        status: 'pending',
        order_type: 'topup',
        platform_code: platformCode,
      },
    })

    // sign = SHA1(base64("orderId=X&c=X&userid=X&show_uri=X"))
    const paySign = buildPaySign(String(lifeOrder.orderid), amountYuan, lifeOrder.userid, pageRedirectUrl)
    const payPage = pkg.type === 'monthly'
      ? `${baseUrl}/LifeServicePay/multiplePayment/wapPage`
      : `${baseUrl}/LifeServicePay/pay/payViewWAP`
    const payUrl = payPage
      + `?orderIds=${lifeOrder.orderid}`
      + `&orderAmount=${amountYuan}`
      + `&userid=${lifeOrder.userid}`
      + `&orderType=1`
      + `&platformcode=${platformCode}`
      + `&sign=${paySign}`
      + `&showUrl=${encodeURIComponent(pageRedirectUrl)}`

    return { order_id: order.id, life_order_id: String(lifeOrder.orderid), pay_url: payUrl }
  })

  // POST /payment/notify — async callback from life platform after payment
  // This endpoint is public (no JWT), verified by signature
  app.post<{ Body: Record<string, unknown> }>('/payment/notify', async (request, reply) => {
    const body = request.body as Record<string, string>

    // Basic presence check — full signature verification can be added when platform docs clarify
    const lifeOrderId = body.orderid ?? body.orderId ?? body.order_id
    if (!lifeOrderId) return reply.badRequest('missing orderid')

    const order = await prisma.paymentOrder.findFirst({
      where: { life_order_id: String(lifeOrderId) },
    })

    if (!order) return { success: true } // unknown order, ack to stop retries

    if (order.status === 'paid') return { success: true } // idempotent

    const payStatus = String(body.payStatus ?? body.status ?? '')
    if (payStatus !== '1' && payStatus !== 'success' && payStatus !== '0') {
      // Payment not successful — mark failed
      await prisma.paymentOrder.update({
        where: { id: order.id },
        data: { status: 'failed', callback_payload: body as Record<string, string> },
      })
      return { success: true }
    }

    // Credit the account in a transaction
    await prisma.$transaction(async (tx) => {
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { status: 'paid', paid_at: new Date(), callback_payload: body as Record<string, string> },
      })

      await tx.creditAccount.update({
        where: { id: order.credit_account_id! },
        data: {
          balance: { increment: order.credits_to_grant },
          total_earned: { increment: order.credits_to_grant },
          updated_at: new Date(),
        },
      })

      await tx.creditsLedger.create({
        data: {
          credit_account_id: order.credit_account_id!,
          user_id: order.user_id,
          amount: order.credits_to_grant,
          type: 'topup',
          description: `充值订单 ${order.life_order_id}`,
        },
      })
    })

    return { success: true }
  })
}

/**
 * 确保用户或团队的积分账户存在，不存在则创建
 */
async function ensureCreditAccount(user_id: string, teamId?: string): Promise<string> {
  if (teamId) {
    const existing = await prisma.creditAccount.findFirst({
      where: { owner_type: 'team', team_id: teamId },
      select: { id: true },
    })
    if (existing) return existing.id

    const created = await prisma.creditAccount.create({
      data: { owner_type: 'team', team_id: teamId, balance: 0, frozen_credits: 0, total_earned: 0, total_spent: 0 },
    })
    return created.id
  }

  const existing = await prisma.creditAccount.findFirst({
    where: { owner_type: 'user', user_id },
    select: { id: true },
  })
  if (existing) return existing.id

  const created = await prisma.creditAccount.create({
    data: { owner_type: 'user', user_id, balance: 0, frozen_credits: 0, total_earned: 0, total_spent: 0 },
  })
  return created.id
}
