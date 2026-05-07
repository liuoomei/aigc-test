import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { teamRoleGuard } from '../plugins/guards.js'
import type { InviteMemberRequest, UpdateQuotaRequest, TeamMemberRole } from '@aigc/types'
import rateLimit from '@fastify/rate-limit'

export async function teamRoutes(app: FastifyInstance): Promise<void> {

  // Rate limit invite endpoint: 20 invites per hour per user
  await app.register(rateLimit, {
    max: 20,
    timeWindow: '1 hour',
    keyGenerator: (request) => `invite:${request.user?.id ?? request.ip}`,
    errorResponseBuilder: () => ({
      statusCode: 429,
      success: false,
      error: { code: 'RATE_LIMITED', message: '邀请操作过于频繁，请稍后再试' },
    }),
  })

  // Rate limit batch invite endpoint: 15 batch operations per hour per user
  await app.register(rateLimit, {
    max: 15,
    timeWindow: '1 hour',
    keyGenerator: (request) => `batch-invite:${request.user?.id ?? request.ip}`,
    errorResponseBuilder: () => ({
      statusCode: 429,
      success: false,
      error: { code: 'RATE_LIMITED', message: '批量添加操作过于频繁，请稍后再试' },
    }),
  })

  // GET /teams/:id — team info + members + credit balance
  app.get<{ Params: { id: string } }>('/teams/:id', {
    preHandler: teamRoleGuard('editor'),
    config: { rateLimit: false },
  }, async (request) => {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: request.params.id },
      select: {
        id: true,
        name: true,
        owner_id: true,
        plan_tier: true,
        created_at: true,
        allow_member_topup: true,
      },
    })

    const members = await prisma.teamMember.findMany({
      where: { team_id: request.params.id },
      select: {
        role: true,
        credit_quota: true,
        credit_used: true,
        quota_period: true,
        quota_reset_at: true,
        joined_at: true,
        priority_boost: true,
        user: {
          select: {
            id: true,
            account: true,
            username: true,
            avatar_url: true,
          },
        },
      },
    })

    // 转换成员数据格式以保持向后兼容
    const formattedMembers = members.map((m) => ({
      user_id: m.user.id,
      account: m.user.account,
      username: m.user.username,
      avatar_url: m.user.avatar_url,
      role: m.role,
      credit_quota: m.credit_quota,
      credit_used: m.credit_used,
      quota_period: m.quota_period,
      quota_reset_at: m.quota_reset_at,
      joined_at: m.joined_at,
      priority_boost: m.priority_boost,
    }))

    const creditAccount = await prisma.creditAccount.findFirst({
      where: {
        team_id: request.params.id,
        owner_type: 'team',
      },
      select: {
        balance: true,
        frozen_credits: true,
        total_earned: true,
        total_spent: true,
      },
    })

    return {
      ...team,
      members: formattedMembers,
      credits: creditAccount ?? { balance: 0, frozen_credits: 0, total_earned: 0, total_spent: 0 },
    }
  })

  // POST /teams/:id/members — invite member by email or phone
  app.post<{ Params: { id: string }; Body: InviteMemberRequest }>('/teams/:id/members', {
    preHandler: teamRoleGuard('owner'),
    schema: {
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          phone: { type: 'string', maxLength: 20 },
          role: { type: 'string', enum: ['editor', 'viewer', 'admin', 'owner'] },
          workspace_id: { type: 'string', format: 'uuid' },
          new_workspace_name: { type: 'string', maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const email = request.body.email?.trim()
    const phone = request.body.phone?.trim()
    const { role, workspace_id, new_workspace_name } = request.body

    if (!email && !phone) {
      return reply.badRequest('必须提供邮箱或手机号')
    }

    // Validate phone: exactly 11 digits
    if (phone && !/^\d{11}$/.test(phone)) {
      return reply.badRequest('手机号必须是 11 位数字')
    }

    const memberRole: TeamMemberRole = (role as TeamMemberRole) ?? 'editor'

    const teamId = request.params.id

    // Resolve target workspace
    let targetWsId: string | null = null
    if (new_workspace_name) {
      const ws = await prisma.workspace.create({
        data: {
          team_id: teamId,
          name: new_workspace_name,
          created_by: request.user.id,
        },
        select: { id: true },
      })
      targetWsId = ws.id

      // Add the owner to the new workspace too
      await prisma.workspaceMember.create({
        data: {
          workspace_id: targetWsId,
          user_id: request.user.id,
          role: 'admin',
        },
      })
    } else if (workspace_id) {
      // Verify workspace belongs to this team
      const ws = await prisma.workspace.findFirst({
        where: { id: workspace_id, team_id: teamId },
        select: { id: true },
      })
      if (!ws) return reply.badRequest('工作区不存在或不属于此团队')
      targetWsId = ws.id
    }

    // Check if user already exists
    let user = await prisma.user.findFirst({
      where: email ? { email } : { phone },
      select: { id: true, email: true, phone: true },
    })

    const identifier = email ?? phone!

    if (!user) {
      // Create placeholder user
      const account = identifier
      const username = email ? email.split('@')[0] : phone!.slice(-4)
      const result = await prisma.user.create({
        data: {
          account,
          email: email ?? null,
          phone: phone ?? null,
          username,
          password_hash: '',  // placeholder, filled on accept-invite
          role: 'member',
          status: 'suspended',  // inactive until invite accepted
          plan_tier: 'free',
        },
        select: { id: true },
      })
      user = { id: result.id, email: email ?? null, phone: phone ?? null }
    }

    // Check if already a team member
    const existing = await prisma.teamMember.findFirst({
      where: { team_id: teamId, user_id: user.id },
      select: { user_id: true },
    })

    if (existing) {
      // If user hasn't accepted invite yet (suspended), allow regenerating the invite
      const targetUser = await prisma.user.findFirst({
        where: { id: user.id },
        select: { id: true, status: true },
      })

      if (targetUser?.status === 'suspended') {
        // Invalidate old invite tokens before creating a new one
        await prisma.emailVerification.updateMany({
          where: { user_id: user.id, used_at: null },
          data: { used_at: new Date() },
        })

        const inviteToken = crypto.randomBytes(32).toString('hex')
        const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex')

        await prisma.emailVerification.create({
          data: {
            user_id: user.id,
            token_hash: tokenHash,
            type: 'verify_email',
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
          },
        })

        return reply.status(200).send({
          user_id: user.id,
          email: user.email,
          phone: user.phone,
          role: memberRole,
          invite_token: inviteToken, // SECURITY: Remove once email service sends tokens directly
          regenerated: true,
        })
      }

      return reply.status(409).send({
        success: false,
        error: { code: 'ALREADY_MEMBER', message: '该用户已是团队成员' },
      })
    }

    // Add to team
    await prisma.teamMember.create({
      data: {
        team_id: teamId,
        user_id: user.id,
        role: memberRole,
        credit_quota: 1000,
      },
    })

    // Add to workspace
    if (targetWsId) {
      await prisma.workspaceMember.create({
        data: {
          workspace_id: targetWsId,
          user_id: user.id,
          role: memberRole === 'owner' ? 'admin' : memberRole === 'viewer' ? 'viewer' : 'editor',
        },
      })
    }

    // Create invite token
    const inviteToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex')

    await prisma.emailVerification.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        type: 'verify_email',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    })

    return reply.status(201).send({
      user_id: user.id,
      email: user.email,
      phone: user.phone,
      role: memberRole,
      invite_token: inviteToken, // SECURITY: Remove once email service sends tokens directly
    })
  })

  // POST /teams/:id/members/create — create single member with default password (aligned with batch)
  app.post<{
    Params: { id: string }
    Body: {
      identifier: string
      role?: 'editor' | 'viewer'
      credit_quota?: number
      default_password: string
    }
  }>('/teams/:id/members/create', {
    preHandler: teamRoleGuard('owner'),
    schema: {
      body: {
        type: 'object',
        required: ['identifier', 'default_password'],
        properties: {
          identifier: { type: 'string', maxLength: 254 },
          role: { type: 'string', enum: ['editor', 'viewer'] },
          credit_quota: { type: 'number', minimum: 0, maximum: 1000000 },
          default_password: { type: 'string', minLength: 6, maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { identifier: rawIdentifier, role = 'editor', credit_quota = 1000, default_password } = request.body
    const teamId = request.params.id

    const identifier = rawIdentifier.trim()
    if (!identifier) {
      return reply.badRequest('账号不能为空')
    }

    // Determine if email or phone
    const isEmail = identifier.includes('@')
    const isPhone = /^\d{11}$/.test(identifier)

    if (!isEmail && !isPhone) {
      return reply.badRequest('格式错误（需要邮箱或11位手机号）')
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: isEmail ? { email: identifier } : { phone: identifier },
      select: { id: true, account: true },
    })

    if (existingUser) {
      // Check if already a team member
      const isMember = await prisma.teamMember.findFirst({
        where: { team_id: teamId, user_id: existingUser.id },
        select: { user_id: true },
      })

      if (isMember) {
        return reply.status(409).send({
          success: false,
          error: { code: 'ALREADY_MEMBER', message: '该用户已是团队成员' },
        })
      }
    }

    // Generate username
    const baseUsername = isEmail ? identifier.split('@')[0] : identifier.slice(-4)
    let username = baseUsername
    let suffix = 1
    while (true) {
      const existing = await prisma.user.findFirst({
        where: { username },
        select: { id: true },
      })
      if (!existing) break
      username = `${baseUsername}_${suffix++}`
    }

    // Hash password
    const passwordHash = await bcrypt.hash(default_password, 10)

    // Create user if not exists
    let userId: string
    if (!existingUser) {
      const newUser = await prisma.user.create({
        data: {
          account: identifier,
          email: isEmail ? identifier : null,
          phone: isPhone ? identifier : null,
          username,
          password_hash: passwordHash,
          role: 'member',
          status: 'active',
          plan_tier: 'free',
          password_change_required: true,
        },
        select: { id: true },
      })
      userId = newUser.id
    } else {
      userId = existingUser.id
    }

    // Add to team
    await prisma.teamMember.create({
      data: {
        team_id: teamId,
        user_id: userId,
        role,
        credit_quota,
      },
    })

    // Create personal workspace
    const workspaceName = `${username}工作区`
    const workspace = await prisma.workspace.create({
      data: {
        team_id: teamId,
        name: workspaceName,
        created_by: request.user.id,
      },
      select: { id: true },
    })

    // Add user to workspace
    const wsRole = role === 'viewer' ? 'viewer' : 'editor'
    await prisma.workspaceMember.create({
      data: {
        workspace_id: workspace.id,
        user_id: userId,
        role: wsRole,
      },
    })

    // Also add owner to workspace as admin
    await prisma.workspaceMember.create({
      data: {
        workspace_id: workspace.id,
        user_id: request.user.id,
        role: 'admin',
      },
    })

    return reply.status(201).send({
      user_id: userId,
      username,
      workspace_id: workspace.id,
      workspace_name: workspaceName,
      account: identifier,
    })
  })

  // POST /teams/:id/members/batch — batch create members with default password
  app.post<{
    Params: { id: string }
    Body: {
      identifiers: string[]
      role?: 'editor' | 'viewer'
      credit_quota?: number
      default_password: string
    }
  }>('/teams/:id/members/batch', {
    preHandler: teamRoleGuard('owner'),
    schema: {
      body: {
        type: 'object',
        required: ['identifiers', 'default_password'],
        properties: {
          identifiers: {
            type: 'array',
            items: { type: 'string', maxLength: 254 },
            minItems: 1,
            maxItems: 50,
          },
          role: { type: 'string', enum: ['editor', 'viewer'] },
          credit_quota: { type: 'number', minimum: 0, maximum: 1000000 },
          default_password: { type: 'string', minLength: 6, maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { identifiers, role = 'editor', credit_quota = 1000, default_password } = request.body
    const teamId = request.params.id

    // Hash password once for all users
    const passwordHash = await bcrypt.hash(default_password, 10)

    interface BatchResult {
      identifier: string
      status: 'success' | 'failed' | 'exists'
      user_id?: string
      workspace_id?: string
      workspace_name?: string
      username?: string
      error?: string
    }

    const results: BatchResult[] = []
    let successCount = 0
    let failedCount = 0
    let existsCount = 0

    // Helper: generate unique username
    async function generateUsername(baseUsername: string): Promise<string> {
      let username = baseUsername
      let suffix = 1
      while (true) {
        const existing = await prisma.user.findFirst({
          where: { username },
          select: { id: true },
        })
        if (!existing) return username
        username = `${baseUsername}_${suffix++}`
      }
    }

    // Process each identifier
    for (const rawIdentifier of identifiers) {
      const identifier = rawIdentifier.trim()
      if (!identifier) {
        results.push({ identifier, status: 'failed', error: '标识符为空' })
        failedCount++
        continue
      }

      try {
        // Determine if email or phone
        const isEmail = identifier.includes('@')
        const isPhone = /^\d{11}$/.test(identifier)

        if (!isEmail && !isPhone) {
          results.push({ identifier, status: 'failed', error: '格式错误（需要邮箱或11位手机号）' })
          failedCount++
          continue
        }

        // Check if user already exists
        let existingUser = await prisma.user.findFirst({
          where: isEmail ? { email: identifier } : { phone: identifier },
          select: { id: true, account: true },
        })

        if (existingUser) {
          // Check if already a team member
          const isMember = await prisma.teamMember.findFirst({
            where: { team_id: teamId, user_id: existingUser.id },
            select: { user_id: true },
          })

          if (isMember) {
            results.push({ identifier, status: 'exists', user_id: existingUser.id, error: '已是团队成员' })
            existsCount++
            continue
          }
        }

        // Generate username
        const baseUsername = isEmail ? identifier.split('@')[0] : identifier.slice(-4)
        const username = await generateUsername(baseUsername)

        // Create user if not exists
        let userId: string
        if (!existingUser) {
          const newUser = await prisma.user.create({
            data: {
              account: identifier,
              email: isEmail ? identifier : null,
              phone: isPhone ? identifier : null,
              username,
              password_hash: passwordHash,
              role: 'member',
              status: 'active',
              plan_tier: 'free',
              password_change_required: true,
            },
            select: { id: true },
          })
          userId = newUser.id
        } else {
          userId = existingUser.id
        }

        // Add to team
        await prisma.teamMember.create({
          data: {
            team_id: teamId,
            user_id: userId,
            role,
            credit_quota,
          },
        })

        // Create personal workspace
        const workspaceName = `${username}工作区`
        const workspace = await prisma.workspace.create({
          data: {
            team_id: teamId,
            name: workspaceName,
            created_by: request.user.id,
          },
          select: { id: true },
        })

        // Add user to workspace
        const wsRole = role === 'viewer' ? 'viewer' : 'editor'
        await prisma.workspaceMember.create({
          data: {
            workspace_id: workspace.id,
            user_id: userId,
            role: wsRole,
          },
        })

        // Also add owner to workspace as admin
        await prisma.workspaceMember.create({
          data: {
            workspace_id: workspace.id,
            user_id: request.user.id,
            role: 'admin',
          },
        })

        results.push({
          identifier,
          status: 'success',
          user_id: userId,
          workspace_id: workspace.id,
          workspace_name: workspaceName,
          username,
        })
        successCount++
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        app.log.error({ identifier, err: errMsg }, 'Batch user creation failed for identifier')
        results.push({ identifier, status: 'failed', error: errMsg.slice(0, 200) })
        failedCount++
      }
    }

    return reply.status(200).send({
      success: successCount,
      failed: failedCount,
      exists: existsCount,
      results,
    })
  })

  // PATCH /teams/:id/members/:uid — update member role, quota, or period
  app.patch<{ Params: { id: string; uid: string }; Body: { role?: string; credit_quota?: number | null; quota_period?: string | null; priority_boost?: boolean } }>('/teams/:id/members/:uid', {
    preHandler: teamRoleGuard('owner'),
    config: { rateLimit: false },
  }, async (request, reply) => {
    const { role, credit_quota, quota_period, priority_boost } = request.body ?? {}
    if (role === undefined && credit_quota === undefined && quota_period === undefined && priority_boost === undefined) {
      return reply.badRequest('At least one field (role, credit_quota, quota_period, priority_boost) is required')
    }

    // Only global admin can set priority_boost
    if (priority_boost !== undefined && request.user.role !== 'admin') {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '只有管理员可以设置优先特权' } })
    }

    if (quota_period !== undefined && quota_period !== null && quota_period !== 'weekly' && quota_period !== 'monthly') {
      return reply.badRequest('quota_period must be "weekly", "monthly", or null')
    }

    const updates: Record<string, unknown> = {}
    if (role !== undefined) updates.role = role
    if (credit_quota !== undefined) updates.credit_quota = credit_quota
    if (priority_boost !== undefined) updates.priority_boost = priority_boost
    if (quota_period !== undefined) {
      updates.quota_period = quota_period
      if (quota_period) {
        // Set first reset date based on period
        const now = new Date()
        if (quota_period === 'weekly') {
          updates.quota_reset_at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
        } else {
          updates.quota_reset_at = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
        }
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

  // POST /teams/:id/members/:uid/reset-credits — manually reset member credit_used to 0
  app.post<{ Params: { id: string; uid: string } }>('/teams/:id/members/:uid/reset-credits', {
    preHandler: teamRoleGuard('owner'),
    config: { rateLimit: false },
  }, async (request, reply) => {
    const member = await prisma.teamMember.findFirst({
      where: {
        team_id: request.params.id,
        user_id: request.params.uid,
      },
      select: {
        credit_used: true,
        quota_period: true,
      },
    })

    if (!member) return reply.notFound('成员不存在')

    const updates: Record<string, unknown> = { credit_used: 0 }

    // If periodic quota is set, recalculate next reset from now
    if (member.quota_period) {
      const now = new Date()
      if (member.quota_period === 'weekly') {
        updates.quota_reset_at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
      } else {
        updates.quota_reset_at = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
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

    return { success: true, credit_used: 0 }
  })

  // DELETE /teams/:id/members/:uid — remove member
  app.delete<{ Params: { id: string; uid: string } }>(
    '/teams/:id/members/:uid',
    {
      preHandler: teamRoleGuard('owner'),
      config: { rateLimit: false },
    }, async (request, reply) => {
    // Don't allow removing the owner
    const member = await prisma.teamMember.findFirst({
      where: {
        team_id: request.params.id,
        user_id: request.params.uid,
      },
      select: { role: true },
    })

    if (!member) return reply.notFound('Member not found')
    if (member.role === 'owner') {
      return reply.status(403).send({
        success: false,
        error: { code: 'CANNOT_REMOVE_OWNER', message: 'Cannot remove the team owner' },
      })
    }

    // Check for in-flight generation tasks
    const pendingBatches = await prisma.taskBatch.count({
      where: {
        team_id: request.params.id,
        user_id: request.params.uid,
        status: { in: ['pending', 'processing'] },
      },
    })

    if (pendingBatches > 0) {
      return reply.status(409).send({
        success: false,
        error: {
          code: 'HAS_PENDING_TASKS',
          message: '该成员有进行中的生成任务，请等待任务完成后再移除',
        },
      })
    }

    // Remove from all workspaces in this team
    const workspaceIds = await prisma.workspace.findMany({
      where: { team_id: request.params.id },
      select: { id: true },
    })

    const workspaceIdList = workspaceIds.map((w) => w.id)
    if (workspaceIdList.length > 0) {
      await prisma.workspaceMember.deleteMany({
        where: {
          user_id: request.params.uid,
          workspace_id: { in: workspaceIdList },
        },
      })
    }

    await prisma.teamMember.delete({
      where: {
        team_id_user_id: {
          team_id: request.params.id,
          user_id: request.params.uid,
        },
      },
    })

    // If user has no remaining teams, suspend the account
    const remainingTeams = await prisma.teamMember.count({
      where: { user_id: request.params.uid },
    })

    if (remainingTeams === 0) {
      await prisma.user.update({
        where: { id: request.params.uid },
        data: { status: 'suspended' },
      })

      // Revoke all refresh tokens so suspended user can't keep using the app
      await prisma.refreshToken.updateMany({
        where: { user_id: request.params.uid, revoked_at: null },
        data: { revoked_at: new Date() },
      })
    }

    return { success: true }
  })

  // PATCH /teams/:id/members/batch-quota — bulk update quota & period for multiple members
  app.patch<{
    Params: { id: string }
    Body: { user_ids: string[]; credit_quota?: number | null; quota_period?: string | null }
  }>('/teams/:id/members/batch-quota', {
    preHandler: teamRoleGuard('owner'),
    config: { rateLimit: false },
    schema: {
      body: {
        type: 'object',
        required: ['user_ids'],
        properties: {
          user_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 200 },
          credit_quota: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
          quota_period: { type: ['string', 'null'], enum: ['weekly', 'monthly', null] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { user_ids, credit_quota, quota_period } = request.body
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

    await prisma.teamMember.updateMany({
      where: {
        team_id: request.params.id,
        user_id: { in: user_ids },
        role: { not: 'owner' },
      },
      data: updates,
    })

    return { success: true, updated: user_ids.length }
  })

  // GET /teams/:id/workspaces — all workspaces in team (for team owner management view)
  app.get<{ Params: { id: string } }>('/teams/:id/workspaces', {
    preHandler: teamRoleGuard('owner'),
    config: { rateLimit: false },
  }, async (request) => {
    const workspaces = await prisma.workspace.findMany({
      where: {
        team_id: request.params.id,
        is_deleted: false,
      },
      select: {
        id: true,
        name: true,
        description: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    })

    const workspaceIds = workspaces.map((w) => w.id)

    // 获取每个 workspace 的成员数量
    const memberCounts = await prisma.workspaceMember.groupBy({
      by: ['workspace_id'],
      _count: { id: true },
      where: { workspace_id: { in: workspaceIds } },
    })

    const countMap = Object.fromEntries(memberCounts.map((r) => [r.workspace_id, r._count.id]))
    return { data: workspaces.map((w) => ({ ...w, member_count: countMap[w.id] ?? 0 })) }
  })

  // GET /teams/:id/batches — all team generation records
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/teams/:id/batches', {
    preHandler: teamRoleGuard('owner'),
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100)

    const where: any = {
      team_id: request.params.id,
    }

    if (request.query.cursor) {
      where.created_at = { lt: new Date(request.query.cursor) }
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

  // PATCH /teams/:id/allow-member-topup — owner toggles member topup permission
  app.patch<{ Params: { id: string }; Body: { allow: boolean } }>('/teams/:id/allow-member-topup', {
    preHandler: teamRoleGuard('owner'),
    schema: {
      body: {
        type: 'object',
        required: ['allow'],
        properties: { allow: { type: 'boolean' } },
      },
    },
  }, async (request) => {
    await prisma.team.update({
      where: { id: request.params.id },
      data: { allow_member_topup: request.body.allow },
    })
    return { success: true }
  })
}