import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import bcrypt from 'bcryptjs'
import { adminGuard } from '../plugins/guards.js'
import { signAssetUrl } from '../lib/storage.js'
import { stripHtml } from '../lib/sanitize.js'
import type { CreateTeamRequest, TopUpCreditsRequest } from '@aigc/types'

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // All admin routes require admin role
  app.addHook('preHandler', adminGuard())

  // GET /admin/teams — list all teams with member count and credit balance
  app.get('/admin/teams', async () => {
    const teams = await prisma.team.findMany({
      where: { is_deleted: false },
      include: {
        creditAccount: true,
      },
      orderBy: { created_at: 'asc' },
    })

    // Get member counts
    const memberCounts = await prisma.teamMember.groupBy({
      by: ['team_id'],
      _count: { user_id: true },
    })
    const countMap = new Map(memberCounts.map((m: typeof memberCounts[number]) => [m.team_id, m._count.user_id]))

    // Get workspace counts
    const wsCounts = await prisma.workspace.groupBy({
      by: ['team_id'],
      where: { is_deleted: false },
      _count: { id: true },
    })
    const wsCountMap = new Map(wsCounts.map((w: typeof wsCounts[number]) => [w.team_id, w._count.id]))

    // Get owner usernames
    const ownerIds = [...new Set<string>(teams.map((t: typeof teams[number]) => t.owner_id).filter(Boolean) as string[])]
    const ownerMap = new Map<string, string>()
    if (ownerIds.length > 0) {
      const owners = await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, username: true },
      })
      for (const o of owners) ownerMap.set(o.id, o.username)
    }

    // Get lifetime generation usage per team from ledger (confirm entries only)
    const teamIds = teams.map((t: typeof teams[number]) => t.id)
    const lifetimeMap = new Map<string, number>()
    if (teamIds.length > 0) {
      const rows = await prisma.creditsLedger.groupBy({
        by: ['credit_account_id'],
        where: {
          type: 'confirm',
          creditAccount: {
            team_id: { in: teamIds },
          },
        },
        _sum: { amount: true },
      })
      // Need to get team_id from credit_accounts
      const creditAccountRows = await prisma.creditAccount.findMany({
        where: { team_id: { in: teamIds } },
        select: { id: true, team_id: true },
      })
      const creditToTeam = new Map<string, string>(
        creditAccountRows
          .filter((c): c is typeof c & { team_id: string } => c.team_id !== null)
          .map((c) => [c.id, c.team_id])
      )
      for (const r of rows) {
        const teamId = creditToTeam.get(r.credit_account_id)
        if (teamId) lifetimeMap.set(teamId, Math.abs(Number(r._sum?.amount) ?? 0))
      }
    }

    return {
      data: teams.map((t: typeof teams[number]) => ({
        id: t.id,
        name: t.name,
        owner_id: t.owner_id,
        plan_tier: t.plan_tier,
        team_type: t.team_type,
        created_at: t.created_at,
        allow_member_topup: t.allow_member_topup,
        balance: t.creditAccount?.balance ?? 0,
        frozen_credits: t.creditAccount?.frozen_credits ?? 0,
        total_earned: t.creditAccount?.total_earned ?? 0,
        total_spent: t.creditAccount?.total_spent ?? 0,
        lifetime_used: lifetimeMap.get(t.id) ?? 0,
        member_count: countMap.get(t.id) ?? 0,
        workspace_count: wsCountMap.get(t.id) ?? 0,
        owner_username: ownerMap.get(t.owner_id) ?? null,
      })),
    }
  })

  // GET /admin/teams/:id/members — list team members with credit usage
  app.get<{ Params: { id: string } }>('/admin/teams/:id/members', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const teamId = request.params.id

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    })
    if (!team) return reply.notFound('Team not found')

    const members = await prisma.teamMember.findMany({
      where: { team_id: teamId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            account: true,
            avatar_url: true,
          },
        },
      },
      orderBy: { joined_at: 'asc' },
    })

    return {
      data: members.map((m: typeof members[number]) => ({
        id: m.user.id,
        username: m.user.username,
        account: m.user.account,
        avatar_url: m.user.avatar_url,
        role: m.role,
        credit_quota: m.credit_quota,
        credit_used: m.credit_used,
        joined_at: m.joined_at,
      })),
    }
  })

  // PATCH /admin/teams/:id/members/:uid — admin update member quota/period
  app.patch<{
    Params: { id: string; uid: string }
    Body: { credit_quota?: number | null; quota_period?: string | null }
  }>('/admin/teams/:id/members/:uid', {
    config: { rateLimit: false },
    schema: {
      body: {
        type: 'object',
        properties: {
          credit_quota: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
          quota_period: { type: ['string', 'null'], enum: ['weekly', 'monthly', null] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { credit_quota, quota_period } = request.body
    if (credit_quota === undefined && quota_period === undefined) {
      return reply.badRequest('At least one of credit_quota or quota_period is required')
    }
    const updates: Record<string, unknown> = {}
    if (credit_quota !== undefined) updates.credit_quota = credit_quota
    if (quota_period !== undefined) {
      updates.quota_period = quota_period
      if (quota_period) {
        const now = new Date()
        updates.quota_reset_at = quota_period === 'weekly'
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
          : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
      } else {
        updates.quota_reset_at = null
      }
    }
    await prisma.teamMember.update({
      where: {
        team_id_user_id: {
          team_id: request.params.id,
          user_id: request.params.uid,
        },
      },
      data: updates,
    })
    return { success: true }
  })

  // POST /admin/teams/:id/members/:uid/reset-credits — admin reset member credit_used to 0
  app.post<{ Params: { id: string; uid: string } }>('/admin/teams/:id/members/:uid/reset-credits', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const member = await prisma.teamMember.findUnique({
      where: {
        team_id_user_id: {
          team_id: request.params.id,
          user_id: request.params.uid,
        },
      },
      select: { credit_used: true, quota_period: true },
    })
    if (!member) return reply.notFound('成员不存在')
    const updates: Record<string, unknown> = { credit_used: 0 }
    if (member.quota_period) {
      const now = new Date()
      updates.quota_reset_at = member.quota_period === 'weekly'
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
        : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
    }
    await prisma.teamMember.update({
      where: {
        team_id_user_id: {
          team_id: request.params.id,
          user_id: request.params.uid,
        },
      },
      data: updates,
    })
    return { success: true, credit_used: 0 }
  })

  // GET /admin/teams/:id/workspaces — list team workspaces with batch stats
  app.get<{ Params: { id: string } }>('/admin/teams/:id/workspaces', async (request, reply) => {
    const teamId = request.params.id

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    })
    if (!team) return reply.notFound('Team not found')

    const workspaces = await prisma.workspace.findMany({
      where: { team_id: teamId, is_deleted: false },
      select: { id: true, name: true, created_at: true },
      orderBy: { created_at: 'asc' },
    })

    // Get member counts per workspace
    const wsIds = workspaces.map((w: typeof workspaces[number]) => w.id)
    const wsMemberMap = new Map<string, number>()
    const wsBatchMap = new Map<string, { total: number; completed: number; failed: number }>()

    if (wsIds.length > 0) {
      const wsMemberCounts = await prisma.workspaceMember.groupBy({
        by: ['workspace_id'],
        where: { workspace_id: { in: wsIds } },
        _count: { user_id: true },
      })
      for (const m of wsMemberCounts) wsMemberMap.set(m.workspace_id, m._count.user_id)

      // Get batch stats per workspace using raw query
      const batchStats = await prisma.$queryRaw<{ workspace_id: string; total: string; completed: string; failed: string }[]>`
        SELECT
          workspace_id,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM task_batches
        WHERE workspace_id = ANY(${wsIds}::uuid[]) AND is_deleted = false
        GROUP BY workspace_id
      `
      for (const s of batchStats) {
        wsBatchMap.set(s.workspace_id, {
          total: Number(s.total),
          completed: Number(s.completed),
          failed: Number(s.failed),
        })
      }
    }

    return {
      data: workspaces.map((w: typeof workspaces[number]) => ({
        ...w,
        member_count: wsMemberMap.get(w.id) ?? 0,
        batch_total: wsBatchMap.get(w.id)?.total ?? 0,
        batch_completed: wsBatchMap.get(w.id)?.completed ?? 0,
        batch_failed: wsBatchMap.get(w.id)?.failed ?? 0,
      })),
    }
  })

  // GET /admin/workspaces/:id/batches — list workspace batches with user info
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/admin/workspaces/:id/batches', async (request) => {
    const wsId = request.params.id
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100)

    const where: Record<string, unknown> = {
      workspace_id: wsId,
      is_deleted: false,
    }

    if (request.query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(request.query.cursor, 'base64').toString('utf-8'))
        where.AND = [
          {
            OR: [
              { created_at: { lt: new Date(decoded.created_at) } },
              {
                AND: [
                  { created_at: { equals: new Date(decoded.created_at) } },
                  { id: { lt: decoded.id } },
                ],
              },
            ],
          },
        ]
      } catch {
        // ignore invalid cursor
      }
    }

    const rows = await prisma.taskBatch.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    })

    const hasMore = rows.length > limit
    const batches = hasMore ? rows.slice(0, limit) : rows

    // Fetch user info
    const userIds = [...new Set(batches.map((b: any) => b.user_id))]
    const userMap = new Map<string, { id: string; username: string }>()
    if (userIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      })
      for (const u of users) userMap.set(u.id, { id: u.id, username: u.username })
    }

    // Fetch thumbnails
    const batchIds = batches.map((b: any) => b.id)
    const thumbnailMap = new Map<string, string[]>()
    if (batchIds.length > 0) {
      const assets = await prisma.asset.findMany({
        where: { batch_id: { in: batchIds }, is_deleted: false },
        select: { batch_id: true, storage_url: true, original_url: true },
      })
      for (const a of assets) {
        const rawUrl = a.storage_url ?? a.original_url
        if (!rawUrl) continue
        const signedUrl = await signAssetUrl(rawUrl)
        if (!signedUrl) continue
        const list = thumbnailMap.get(a.batch_id) ?? []
        list.push(signedUrl)
        thumbnailMap.set(a.batch_id, list)
      }
    }

    const nextCursor = hasMore && batches.length > 0
      ? Buffer.from(JSON.stringify({
          created_at: batches[batches.length - 1].created_at,
          id: batches[batches.length - 1].id,
        })).toString('base64')
      : null

    return {
      data: batches.map((b: any) => ({
        id: b.id,
        module: b.module,
        provider: b.provider,
        model: b.model,
        prompt: b.prompt,
        params: b.params,
        quantity: b.quantity,
        completed_count: b.completed_count,
        failed_count: b.failed_count,
        status: b.status,
        estimated_credits: b.estimated_credits,
        actual_credits: b.actual_credits,
        created_at: b.created_at?.toISOString?.() ?? String(b.created_at),
        tasks: [],
        thumbnail_urls: thumbnailMap.get(b.id) ?? [],
        user: userMap.get(b.user_id) ?? undefined,
      })),
      cursor: nextCursor,
    }
  })

  // POST /admin/teams — create team + owner user + credit_account + default workspace
  app.post<{ Body: CreateTeamRequest }>('/admin/teams', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          owner_email: { type: 'string', format: 'email', maxLength: 254 },
          owner_phone: { type: 'string', maxLength: 20 },
          owner_username: { type: 'string', maxLength: 50 },
          owner_password: { type: 'string', minLength: 8, maxLength: 72 },
          initial_credits: { type: 'integer', minimum: 0, maximum: 10000000 },
          team_type: { type: 'string', enum: ['standard', 'company_a', 'avatar_enabled'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { name, owner_username, owner_password, initial_credits, team_type } = request.body
    const owner_email = request.body.owner_email?.trim()
    const owner_phone = request.body.owner_phone?.trim()

    if (!owner_email && !owner_phone) {
      return reply.badRequest('必须提供 owner_email 或 owner_phone')
    }

    // Validate phone: exactly 11 digits
    if (owner_phone && !/^\d{11}$/.test(owner_phone)) {
      return reply.badRequest('手机号必须是 11 位数字')
    }

    // Check duplicate team name
    const existingTeam = await prisma.team.findFirst({
      where: { name, is_deleted: false },
      select: { id: true },
    })
    if (existingTeam) {
      return reply.status(409).send({
        success: false,
        error: { code: 'TEAM_NAME_TAKEN', message: `已有同名团队"${name}"，请换一个名称` },
      })
    }

    // Check if owner user exists (by email or phone)
    let owner = await prisma.user.findFirst({
      where: owner_email ? { email: owner_email } : { phone: owner_phone! },
      select: { id: true, account: true, username: true, status: true },
    })

    const ownerWasExisting = !!owner

    if (!owner) {
      if (!owner_password || owner_password.length < 8) {
        return reply.badRequest('新用户需要提供至少 8 位的 owner_password')
      }
      // Create owner user
      const passwordHash = await bcrypt.hash(owner_password, 12)

      const account = owner_email ?? owner_phone!
      const defaultUsername = owner_email
        ? owner_email.split('@')[0]
        : owner_phone!.slice(-4)

      const result = await prisma.user.create({
        data: {
          account,
          email: owner_email ?? null,
          phone: owner_phone ?? null,
          username: owner_username ?? defaultUsername,
          password_hash: passwordHash,
          role: 'member',
          status: 'active',
          plan_tier: 'free',
        },
        select: { id: true, account: true, username: true },
      })
      owner = { id: result.id, account: result.account, username: result.username, status: 'active' }
    } else {
      // User exists — reactivate if suspended, and update password if a new one is provided
      const updates: Record<string, unknown> = {}
      if (owner.status === 'suspended') updates.status = 'active'
      if (owner_password && owner_password.length >= 8) {
        updates.password_hash = await bcrypt.hash(owner_password, 12)
      }
      if (Object.keys(updates).length > 0) {
        await prisma.user.update({
          where: { id: owner.id },
          data: updates,
        })
      }
    }

    // Check owner uniqueness: one active team per owner
    const existingOwnership = await prisma.team.findFirst({
      where: { owner_id: owner.id, is_deleted: false },
      select: { id: true },
    })
    if (existingOwnership) {
      return reply.status(409).send({
        success: false,
        error: { code: 'USER_ALREADY_OWNER', message: '该用户已是其他团队的组长，同一账号只能担任一个团队的组长' },
      })
    }

    // Create team
    const team = await prisma.team.create({
      data: {
        name,
        owner_id: owner.id,
        plan_tier: 'free',
        team_type: team_type ?? 'standard',
      },
      select: { id: true, name: true, created_at: true },
    })

    // Add owner to team_members
    await prisma.teamMember.create({
      data: {
        team_id: team.id,
        user_id: owner.id,
        role: 'owner',
      },
    })

    // Create credit account for team
    await prisma.creditAccount.create({
      data: {
        owner_type: 'team',
        team_id: team.id,
        balance: initial_credits ?? 0,
      },
    })

    // Create default workspace
    const workspace = await prisma.workspace.create({
      data: {
        team_id: team.id,
        name: '默认工作区',
        created_by: owner.id,
      },
      select: { id: true, name: true },
    })

    // Add owner to workspace
    await prisma.workspaceMember.create({
      data: {
        workspace_id: workspace.id,
        user_id: owner.id,
        role: 'admin',
      },
    })

    // If initial credits > 0, add ledger entry
    if (initial_credits && initial_credits > 0) {
      const creditAccount = await prisma.creditAccount.findFirst({
        where: { team_id: team.id, owner_type: 'team' },
        select: { id: true },
      })

      if (creditAccount) {
        await prisma.creditsLedger.create({
          data: {
            credit_account_id: creditAccount.id,
            user_id: request.user.id,
            amount: initial_credits,
            type: 'topup',
            description: 'Initial team credits',
          },
        })
      }
    }

    return reply.status(201).send({
      team,
      owner: { id: owner.id, account: owner.account, username: owner.username, existing: ownerWasExisting },
      workspace: { id: workspace.id, name: workspace.name },
    })
  })

  // PATCH /admin/teams/:id — update team settings (team_type, allow_member_topup)
  app.patch<{ Params: { id: string }; Body: { team_type?: 'standard' | 'company_a' | 'avatar_enabled'; allow_member_topup?: boolean } }>('/admin/teams/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          team_type: { type: 'string', enum: ['standard', 'company_a', 'avatar_enabled'] },
          allow_member_topup: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const { team_type, allow_member_topup } = request.body

    const team = await prisma.team.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!team) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '团队不存在' } })

    const updates: Record<string, unknown> = {}
    if (team_type !== undefined) updates.team_type = team_type
    if (allow_member_topup !== undefined) updates.allow_member_topup = allow_member_topup

    if (Object.keys(updates).length > 0) {
      await prisma.team.update({
        where: { id },
        data: updates,
      })
    }

    return reply.send({ success: true })
  })

  // DELETE /admin/teams/:id — soft-delete team + cascade workspaces + task_batches
  app.delete<{ Params: { id: string } }>('/admin/teams/:id', async (request, reply) => {
    const { id } = request.params

    const team = await prisma.team.findFirst({
      where: { id, is_deleted: false },
      select: { id: true, name: true },
    })
    if (!team) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '团队不存在' } })

    const now = new Date()

    // Cascade: soft-delete all workspaces
    const wsIds = await prisma.workspace.findMany({
      where: { team_id: id, is_deleted: false },
      select: { id: true },
    })

    if (wsIds.length > 0) {
      const wsIdList = wsIds.map((w: typeof wsIds[number]) => w.id)
      await prisma.workspace.updateMany({
        where: { id: { in: wsIdList } },
        data: { is_deleted: true, deleted_at: now },
      })

      // Cascade: soft-delete task_batches in those workspaces
      await prisma.taskBatch.updateMany({
        where: { workspace_id: { in: wsIdList }, is_deleted: false },
        data: { is_deleted: true, deleted_at: now },
      })
    }

    // Soft-delete the team
    await prisma.team.update({
      where: { id },
      data: { is_deleted: true, deleted_at: now },
    })

    // Suspend members who no longer belong to any active team
    const memberIds = (await prisma.teamMember.findMany({
      where: { team_id: id },
      select: { user_id: true },
    })).map((m: { user_id: string }) => m.user_id)

    if (memberIds.length > 0) {
      // Count active teams per member (excluding the just-deleted team)
      const activeCounts = await prisma.teamMember.groupBy({
        by: ['user_id'],
        where: {
          user_id: { in: memberIds },
          team: { is_deleted: false },
        },
        _count: { team_id: true },
      })

      const countMap = new Map(activeCounts.map((r: typeof activeCounts[number]) => [r.user_id, r._count.team_id]))
      const toSuspend = memberIds.filter((uid: string) => (countMap.get(uid) ?? 0) === 0)

      if (toSuspend.length > 0) {
        await prisma.user.updateMany({
          where: { id: { in: toSuspend } },
          data: { status: 'suspended' },
        })

        await prisma.refreshToken.updateMany({
          where: { user_id: { in: toSuspend }, revoked_at: null },
          data: { revoked_at: new Date() },
        })
      }
    }

    return { success: true }
  })

  // GET /admin/trash — list soft-deleted teams and workspaces (within 7 days)
  app.get('/admin/trash', async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const teams = await prisma.team.findMany({
      where: {
        is_deleted: true,
        deleted_at: { gte: cutoff },
      },
      select: { id: true, name: true, owner_id: true, deleted_at: true },
      orderBy: { deleted_at: 'desc' },
    })

    const workspaces = await prisma.workspace.findMany({
      where: {
        is_deleted: true,
        deleted_at: { gte: cutoff },
      },
      select: { id: true, name: true, team_id: true, deleted_at: true },
      orderBy: { deleted_at: 'desc' },
    })

    // Filter workspaces whose parent team is NOT deleted
    const filteredWorkspaces: typeof workspaces = []
    for (const w of workspaces) {
      if (!w.team_id) continue
      const parentTeam = await prisma.team.findUnique({
        where: { id: w.team_id },
        select: { is_deleted: true },
      })
      if (parentTeam && !parentTeam.is_deleted) {
        filteredWorkspaces.push(w)
      }
    }

    // Owner usernames for teams
    const ownerIds = [...new Set<string>(teams.map((t: typeof teams[number]) => t.owner_id))]
    const ownerMap = new Map<string, string>()
    if (ownerIds.length > 0) {
      const owners = await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, username: true },
      })
      for (const o of owners) ownerMap.set(o.id, o.username)
    }

    // Team names for workspaces
    const teamIds = [...new Set<string>(filteredWorkspaces.map((w) => w.team_id).filter((id): id is string => id !== null))]
    const teamNameMap = new Map<string, string>()
    if (teamIds.length > 0) {
      const teamRows = await prisma.team.findMany({
        where: { id: { in: teamIds } },
        select: { id: true, name: true },
      })
      for (const t of teamRows) teamNameMap.set(t.id, t.name)
    }

    return {
      teams: teams.map((t: typeof teams[number]) => ({
        ...t,
        owner_username: ownerMap.get(t.owner_id) ?? null,
        deleted_at: t.deleted_at,
      })),
      workspaces: filteredWorkspaces.map((w: typeof filteredWorkspaces[number]) => ({
        ...w,
        team_name: w.team_id ? (teamNameMap.get(w.team_id) ?? null) : null,
      })),
    }
  })

  // POST /admin/trash/teams/:id/restore — restore soft-deleted team
  app.post<{ Params: { id: string } }>('/admin/trash/teams/:id/restore', async (request, reply) => {
    const { id } = request.params

    const team = await prisma.team.findFirst({
      where: { id, is_deleted: true },
      select: { id: true, name: true, owner_id: true },
    })
    if (!team) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '已删除的团队不存在或已过期' } })

    // Check owner uniqueness before restoring
    const ownerConflict = await prisma.team.findFirst({
      where: { owner_id: team.owner_id, is_deleted: false },
      select: { id: true },
    })
    if (ownerConflict) {
      return reply.status(409).send({
        success: false,
        error: { code: 'USER_ALREADY_OWNER', message: '该团队组长已成为其他团队的组长，无法恢复' },
      })
    }

    // Check team name uniqueness before restoring
    const nameConflict = await prisma.team.findFirst({
      where: { name: team.name, is_deleted: false },
      select: { id: true },
    })
    if (nameConflict) {
      return reply.status(409).send({
        success: false,
        error: { code: 'TEAM_NAME_TAKEN', message: `已有同名团队"${team.name}"，恢复前请先重命名现有团队` },
      })
    }

    // Restore team
    await prisma.team.update({
      where: { id },
      data: { is_deleted: false, deleted_at: null },
    })

    // Restore workspaces and their task_batches that were deleted at the same time
    const wsIds = await prisma.workspace.findMany({
      where: { team_id: id, is_deleted: true },
      select: { id: true },
    })

    if (wsIds.length > 0) {
      const wsIdList = wsIds.map((w: typeof wsIds[number]) => w.id)
      await prisma.workspace.updateMany({
        where: { id: { in: wsIdList } },
        data: { is_deleted: false, deleted_at: null },
      })

      await prisma.taskBatch.updateMany({
        where: { workspace_id: { in: wsIdList }, is_deleted: true },
        data: { is_deleted: false, deleted_at: null },
      })
    }

    // Re-activate suspended members who have no other active teams (this team is their only one)
    const memberIds = (await prisma.teamMember.findMany({
      where: { team_id: id },
      select: { user_id: true },
    })).map((m: { user_id: string }) => m.user_id)

    if (memberIds.length > 0) {
      // Find suspended members with no other active team
      const activeCounts = await prisma.teamMember.groupBy({
        by: ['user_id'],
        where: {
          user_id: { in: memberIds },
          team: { is_deleted: false },
          team_id: { not: id }, // exclude restored team itself to find "only this team" members
        },
        _count: { team_id: true },
      })

      const countMap = new Map(activeCounts.map((r: typeof activeCounts[number]) => [r.user_id, r._count.team_id]))
      // Members with no OTHER active teams are those suspended because of this deletion
      const toReactivate = memberIds.filter((uid: string) => (countMap.get(uid) ?? 0) === 0)

      if (toReactivate.length > 0) {
        await prisma.user.updateMany({
          where: { id: { in: toReactivate }, status: 'suspended' },
          data: { status: 'active' },
        })
      }
    }

    return { success: true }
  })

  // DELETE /admin/trash/teams/:id — permanently delete team and all data
  app.delete<{ Params: { id: string } }>('/admin/trash/teams/:id', async (request, reply) => {
    const { id } = request.params

    const team = await prisma.team.findFirst({
      where: { id, is_deleted: true },
      select: { id: true },
    })
    if (!team) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '团队不存在或未被删除' } })

    // Get workspace IDs
    const wsIds = (await prisma.workspace.findMany({
      where: { team_id: id },
      select: { id: true },
    })).map((w: { id: string }) => w.id)

    if (wsIds.length > 0) {
      // Get task_batch IDs
      const batchIds = (await prisma.taskBatch.findMany({
        where: { workspace_id: { in: wsIds } },
        select: { id: true },
      })).map((b: { id: string }) => b.id)

      if (batchIds.length > 0) {
        // Permanently delete assets
        await prisma.asset.deleteMany({ where: { batch_id: { in: batchIds } } })
        // Permanently delete tasks
        await prisma.task.deleteMany({ where: { batch_id: { in: batchIds } } })
        // Permanently delete task_batches
        await prisma.taskBatch.deleteMany({ where: { id: { in: batchIds } } })
      }

      // Delete workspace members
      await prisma.workspaceMember.deleteMany({ where: { workspace_id: { in: wsIds } } })
      // Delete workspaces
      await prisma.workspace.deleteMany({ where: { id: { in: wsIds } } })
    }

    // Delete team members
    await prisma.teamMember.deleteMany({ where: { team_id: id } })
    // Delete the team (credit_accounts preserved as soft-delete)
    await prisma.team.delete({ where: { id } })

    return { success: true }
  })

  // PATCH /admin/users/:id/password — admin change any user's password
  app.patch<{ Params: { id: string }; Body: { new_password: string; unlock_account?: boolean } }>('/admin/users/:id/password', {
    schema: {
      body: {
        type: 'object',
        required: ['new_password'],
        properties: {
          new_password: { type: 'string', minLength: 8, maxLength: 72 },
          unlock_account: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const { new_password, unlock_account } = request.body

    if (!/[a-zA-Z]/.test(new_password) || !/\d/.test(new_password)) {
      return reply.badRequest('密码必须包含字母和数字')
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, account: true },
    })
    if (!user) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } })

    const passwordHash = await bcrypt.hash(new_password, 12)
    await prisma.user.update({
      where: { id },
      data: { password_hash: passwordHash },
    })

    // Revoke all refresh tokens so user must re-login
    await prisma.refreshToken.updateMany({
      where: { user_id: id, revoked_at: null },
      data: { revoked_at: new Date() },
    })

    // Optionally clear account lockout from Redis
    if (unlock_account) {
      const redis = (app as any).redis as import('ioredis').default
      await redis.del(`auth:locked:${user.account.toLowerCase()}`)
      await redis.del(`auth:attempts:${user.account.toLowerCase()}`)
    }

    return { success: true }
  })

  // POST /admin/teams/:id/credits — adjust team credits (positive = top-up, negative = deduct)
  app.post<{ Params: { id: string }; Body: TopUpCreditsRequest }>('/admin/teams/:id/credits', {
    schema: {
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number', minimum: -1000000, maximum: 1000000 },
          description: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { amount, description: rawDesc } = request.body
    if (amount === 0) return reply.badRequest('amount must be a non-zero number')
    // Sanitize description: truncate and strip HTML
    const description = rawDesc ? stripHtml(rawDesc).slice(0, 200) : undefined

    const creditAccount = await prisma.creditAccount.findFirst({
      where: { team_id: request.params.id, owner_type: 'team' },
      select: { id: true, balance: true, frozen_credits: true },
    })

    if (!creditAccount) return reply.notFound('Team credit account not found')

    if (amount > 0) {
      // Top-up
      await prisma.creditAccount.update({
        where: { id: creditAccount.id },
        data: {
          balance: { increment: amount },
          total_earned: { increment: amount },
        },
      })

      await prisma.creditsLedger.create({
        data: {
          credit_account_id: creditAccount.id,
          user_id: request.user.id,
          amount,
          type: 'topup',
          description: description ?? 'Admin top-up',
        },
      })
    } else {
      // Deduction (amount is negative)
      const deduction = Math.abs(amount)
      const available = Number(creditAccount.balance) - Number(creditAccount.frozen_credits)
      if (available < deduction) {
        return reply.badRequest('可扣减余额不足，请检查当前余额和冻结金额')
      }

      await prisma.creditAccount.update({
        where: { id: creditAccount.id },
        data: {
          balance: { decrement: deduction },
          total_spent: { increment: deduction },
        },
      })

      await prisma.creditsLedger.create({
        data: {
          credit_account_id: creditAccount.id,
          user_id: request.user.id,
          amount,
          type: 'refund',
          description: description ?? 'Admin deduction',
        },
      })
    }

    const updated = await prisma.creditAccount.findUnique({
      where: { id: creditAccount.id },
      select: { balance: true, frozen_credits: true, total_earned: true, total_spent: true },
    })

    return updated
  })

  // GET /admin/users — list all users with credit usage
  app.get('/admin/users', async () => {
    const users = await prisma.user.findMany({
      select: { id: true, account: true, username: true, avatar_url: true, role: true, status: true, created_at: true },
      orderBy: { created_at: 'desc' },
    })

    // Get credit usage per user from team_members (current period) + ledger (lifetime)
    const userIds = users.map((u: typeof users[number]) => u.id)
    const creditUsageMap = new Map<string, { total_quota: number | null; total_used: number }>()
    const lifetimeUsageMap = new Map<string, number>()

    if (userIds.length > 0) {
      const memberRows = await prisma.teamMember.findMany({
        where: { user_id: { in: userIds } },
        select: { user_id: true, credit_quota: true, credit_used: true },
      })

      for (const m of memberRows) {
        const existing = creditUsageMap.get(m.user_id)
        const used = m.credit_used ?? 0
        const quota = m.credit_quota
        if (existing) {
          existing.total_used += used
          if (quota !== null && quota !== undefined) {
            existing.total_quota = (existing.total_quota ?? 0) + quota
          }
        } else {
          creditUsageMap.set(m.user_id, {
            total_quota: quota ?? null,
            total_used: used,
          })
        }
      }

      // Lifetime usage from ledger: sum of all 'confirm' debits per user
      const ledgerRows = await prisma.creditsLedger.groupBy({
        by: ['user_id'],
        where: { user_id: { in: userIds }, type: 'confirm' },
        _sum: { amount: true },
      })

      for (const r of ledgerRows) {
        // confirm entries have negative amounts, so negate to get positive usage
        lifetimeUsageMap.set(r.user_id, Math.abs(r._sum.amount ?? 0))
      }
    }

    // Get team names, team_id, and priority_boost per user
    const teamMap = new Map<string, string[]>()
    const teamIdMap = new Map<string, string>()
    const priorityBoostMap = new Map<string, boolean>()
    if (userIds.length > 0) {
      const teamRows = await prisma.teamMember.findMany({
        where: { user_id: { in: userIds }, team: { is_deleted: false } },
        select: { user_id: true, team_id: true, priority_boost: true, team: { select: { name: true } } },
      })
      for (const r of teamRows) {
        const list = teamMap.get(r.user_id) ?? []
        list.push(r.team.name)
        teamMap.set(r.user_id, list)
        // Store first team_id and priority_boost (most users belong to one team)
        if (!teamIdMap.has(r.user_id)) {
          teamIdMap.set(r.user_id, r.team_id)
          priorityBoostMap.set(r.user_id, r.priority_boost ?? false)
        }
      }
    }

    return {
      data: users.map((u: typeof users[number]) => ({
        ...u,
        credit_used: creditUsageMap.get(u.id)?.total_used ?? 0,
        credit_quota: creditUsageMap.get(u.id)?.total_quota ?? null,
        lifetime_used: lifetimeUsageMap.get(u.id) ?? 0,
        teams: teamMap.get(u.id) ?? [],
        team_id: teamIdMap.get(u.id) ?? null,
        priority_boost: priorityBoostMap.get(u.id) ?? false,
      })),
    }
  })

  // GET /admin/batches — all generation records (kept for backwards compat)
  app.get<{ Querystring: { team_id?: string; workspace_id?: string; cursor?: string; limit?: string } }>('/admin/batches', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100)

    const where: Record<string, unknown> = {}

    if (request.query.team_id) {
      where.team_id = request.query.team_id
    }
    if (request.query.workspace_id) {
      where.workspace_id = request.query.workspace_id
    }
    if (request.query.cursor) {
      const cursorDate = new Date(request.query.cursor)
      if (isNaN(cursorDate.getTime())) return reply.badRequest('Invalid cursor')
      where.created_at = { lt: cursorDate }
    }

    const rows = await prisma.taskBatch.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit + 1,
    })

    const hasMore = rows.length > limit
    const data = hasMore ? rows.slice(0, limit) : rows

    return {
      data,
      cursor: hasMore ? String(data[data.length - 1].created_at) : null,
    }
  })

  // GET /admin/errors — global error dashboard (recent failed tasks + AI errors across all users)
  app.get<{ Querystring: { limit?: string; since?: string } }>(
    '/admin/errors',
    async (request) => {
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200)
      const sinceMs = parseInt(request.query.since ?? String(7 * 24 * 60 * 60 * 1000), 10)
      const since = new Date(Date.now() - sinceMs)

      // Recent failed tasks across all users
      const failedTasks = await prisma.task.findMany({
        where: {
          status: 'failed',
          batch: { created_at: { gte: since } },
        },
        include: {
          batch: {
            select: {
              module: true,
              provider: true,
              model: true,
              prompt: true,
              canvas_id: true,
              created_at: true,
            },
          },
          user: {
            select: { id: true, username: true, account: true },
          },
        },
        orderBy: { batch: { created_at: 'desc' } },
        take: limit,
      })

      // Recent AI assistant errors across all users
      const aiErrors = await prisma.aiAssistantError.findMany({
        where: { created_at: { gte: since } },
        include: {
          user: {
            select: { id: true, username: true, account: true },
          },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      })

      // Recent submission errors across all users
      const submissionErrors = await prisma.submissionError.findMany({
        where: { created_at: { gte: since } },
        include: {
          user: {
            select: { id: true, username: true, account: true },
          },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      })

      // Error frequency summary: group failed tasks + submission errors
      const errorGroups = new Map<string, { count: number; last_seen: string; example: string }>()
      for (const t of failedTasks) {
        const key = (t.error_message ?? '（无错误信息）').slice(0, 120)
        const existing = errorGroups.get(key)
        const ts = t.batch.created_at instanceof Date ? t.batch.created_at.toISOString() : String(t.batch.created_at)
        if (!existing) {
          errorGroups.set(key, { count: 1, last_seen: ts, example: key })
        } else {
          existing.count++
          if (ts > existing.last_seen) existing.last_seen = ts
        }
      }
      for (const s of submissionErrors) {
        const key = `[提交:${s.source}] ${s.error_code}${s.http_status ? ` (HTTP ${s.http_status})` : ''}`
        const existing = errorGroups.get(key)
        const ts = s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at)
        if (!existing) {
          errorGroups.set(key, { count: 1, last_seen: ts, example: key })
        } else {
          existing.count++
          if (ts > existing.last_seen) existing.last_seen = ts
        }
      }
      const topErrors = [...errorGroups.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([message, stats]) => ({ message, ...stats }))

      return {
        failed_tasks: failedTasks.map((t: typeof failedTasks[number]) => ({
          task_id: t.id,
          batch_id: t.batch_id,
          error_message: t.error_message,
          retry_count: t.retry_count,
          completed_at: t.completed_at,
          source: t.batch.canvas_id ? 'canvas' : 'generation',
          submitted_at: t.batch.created_at instanceof Date ? t.batch.created_at.toISOString() : String(t.batch.created_at),
          module: t.batch.module,
          provider: t.batch.provider,
          model: t.batch.model,
          prompt: t.batch.prompt,
          user_id: t.user.id,
          username: t.user.username,
          account: t.user.account,
        })),
        ai_errors: aiErrors.map((e: typeof aiErrors[number]) => ({
          id: e.id,
          http_status: e.http_status,
          error_detail: e.error_detail,
          created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
          user_id: e.user.id,
          username: e.user.username,
          account: e.user.account,
        })),
        submission_errors: submissionErrors.map((e: typeof submissionErrors[number]) => ({
          id: e.id,
          source: e.source,
          error_code: e.error_code,
          http_status: e.http_status,
          detail: e.detail,
          model: e.model,
          canvas_id: e.canvas_id,
          created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
          user_id: e.user.id,
          username: e.user.username,
          account: e.user.account,
        })),
        top_errors: topErrors,
        since: since.toISOString(),
      }
    },
  )

  // GET /admin/users/:id/diagnosis — per-user error diagnosis
  // Returns: failed tasks (with raw error_message + source), AI assistant errors
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/admin/users/:id/diagnosis',
    async (request, reply) => {
      const userId = request.params.id
      const limit = Math.min(parseInt(request.query.limit ?? '30', 10), 100)

      // Verify user exists
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, account: true, email: true, phone: true, status: true },
      })
      if (!user) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } })

      // Failed tasks with batch info (raw error_message, source: canvas or generation)
      const failedTasks = await prisma.task.findMany({
        where: { user_id: userId, status: 'failed' },
        include: {
          batch: {
            select: {
              module: true,
              provider: true,
              model: true,
              prompt: true,
              status: true,
              canvas_id: true,
              canvas_node_id: true,
              created_at: true,
            },
          },
        },
        orderBy: { batch: { created_at: 'desc' } },
        take: limit,
      })

      // AI assistant errors (last 7 days)
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const aiErrors = await prisma.aiAssistantError.findMany({
        where: { user_id: userId, created_at: { gte: since7d } },
        orderBy: { created_at: 'desc' },
        take: limit,
      })

      // Submission errors (last 7 days)
      const submissionErrors = await prisma.submissionError.findMany({
        where: { user_id: userId, created_at: { gte: since7d } },
        orderBy: { created_at: 'desc' },
        take: limit,
      })

      return {
        user,
        failed_tasks: failedTasks.map((t: typeof failedTasks[number]) => ({
          task_id: t.id,
          batch_id: t.batch_id,
          error_message: t.error_message,
          task_status: t.status,
          retry_count: t.retry_count,
          completed_at: t.completed_at,
          source: t.batch.canvas_id ? 'canvas' : 'generation',
          submitted_at: t.batch.created_at instanceof Date ? t.batch.created_at.toISOString() : String(t.batch.created_at),
          module: t.batch.module,
          provider: t.batch.provider,
          model: t.batch.model,
          prompt: t.batch.prompt,
          batch_status: t.batch.status,
          canvas_id: t.batch.canvas_id,
          canvas_node_id: t.batch.canvas_node_id,
        })),
        ai_assistant_errors: aiErrors.map((e: typeof aiErrors[number]) => ({
          id: e.id,
          http_status: e.http_status,
          error_detail: e.error_detail,
          created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
        })),
        submission_errors: submissionErrors.map((e: typeof submissionErrors[number]) => ({
          id: e.id,
          source: e.source,
          error_code: e.error_code,
          http_status: e.http_status,
          detail: e.detail,
          model: e.model,
          canvas_id: e.canvas_id,
          created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
        })),
      }
    },
  )
}
