import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { teamRoleGuard, workspaceGuard, workspaceTeamOwnerGuard } from '../plugins/guards.js'
import type { CreateWorkspaceRequest } from '@aigc/types'

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {

  // POST /teams/:id/workspaces — create workspace
  app.post<{ Params: { id: string }; Body: CreateWorkspaceRequest }>('/teams/:id/workspaces', {
    preHandler: teamRoleGuard('owner'),
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: ['string', 'null'], maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { name, description } = request.body

    // Check duplicate workspace name within team
    const existing = await prisma.workspace.findFirst({
      select: { id: true },
      where: {
        team_id: request.params.id,
        name,
        is_deleted: false,
      },
    })
    if (existing) {
      return reply.status(409).send({
        success: false,
        error: { code: 'WORKSPACE_NAME_TAKEN', message: `该团队下已有同名工作区"${name}"` },
      })
    }

    const workspace = await prisma.workspace.create({
      data: {
        team_id: request.params.id,
        name,
        description: description ?? null,
        created_by: request.user.id,
      },
      select: {
        id: true,
        name: true,
        description: true,
        team_id: true,
        created_by: true,
        created_at: true,
      },
    })

    // Add creator as workspace admin
    await prisma.workspaceMember.create({
      data: {
        workspace_id: workspace.id,
        user_id: request.user.id,
        role: 'admin',
      },
    })

    return reply.status(201).send(workspace)
  })

  // GET /workspaces/:id — workspace detail
  app.get<{ Params: { id: string } }>('/workspaces/:id', {
    preHandler: workspaceGuard('viewer'),
  }, async (request) => {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: request.params.id },
    })

    const memberCount = await prisma.workspaceMember.count({
      where: { workspace_id: request.params.id },
    })

    return { ...workspace, member_count: memberCount }
  })

  // GET /workspaces/:id/members — list workspace members
  app.get<{ Params: { id: string } }>('/workspaces/:id/members', {
    preHandler: workspaceTeamOwnerGuard(),
  }, async (request) => {
    const members = await prisma.workspaceMember.findMany({
      where: { workspace_id: request.params.id },
      include: {
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

    // 转换格式以匹配原有返回结构
    const data = members.map((m) => ({
      user_id: m.user.id,
      account: m.user.account,
      username: m.user.username,
      avatar_url: m.user.avatar_url,
      role: m.role,
      created_at: m.created_at,
    }))

    return { data }
  })

  // POST /workspaces/:id/members — add member to workspace
  app.post<{ Params: { id: string }; Body: { user_id: string; role?: string } }>('/workspaces/:id/members', {
    preHandler: workspaceTeamOwnerGuard(),
    schema: {
      body: {
        type: 'object',
        required: ['user_id'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['viewer', 'editor', 'admin'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { user_id, role } = request.body

    // Verify the workspace exists and get its team_id
    const workspace = await prisma.workspace.findUnique({
      select: { team_id: true },
      where: { id: request.params.id },
    })

    if (!workspace) return reply.notFound('Workspace not found')

    // Verify user is a team member
    const teamMember = await prisma.teamMember.findFirst({
      select: { user_id: true, role: true },
      where: {
        team_id: workspace.team_id ?? undefined,
        user_id,
      },
    })

    if (!teamMember) {
      return reply.status(400).send({
        success: false,
        error: { code: 'NOT_TEAM_MEMBER', message: 'User must be a team member first' },
      })
    }

    // Cap workspace role: can't exceed team role level
    const TEAM_TO_WS_MAX: Record<string, number> = { owner: 2, admin: 2, editor: 1, viewer: 0 }
    const WS_ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 }
    const WS_RANK_TO_ROLE = ['viewer', 'editor', 'admin'] as const
    const requestedRole = (role ?? 'editor') as string
    const maxRank = TEAM_TO_WS_MAX[teamMember.role] ?? 0
    const requestedRank = WS_ROLE_RANK[requestedRole] ?? 1
    const effectiveRole = WS_RANK_TO_ROLE[Math.min(requestedRank, maxRank)]

    // Check if already a workspace member
    const existing = await prisma.workspaceMember.findFirst({
      select: { id: true },
      where: {
        workspace_id: request.params.id,
        user_id,
      },
    })

    if (existing) {
      return reply.status(409).send({
        success: false,
        error: { code: 'ALREADY_MEMBER', message: 'User is already a workspace member' },
      })
    }

    await prisma.workspaceMember.create({
      data: {
        workspace_id: request.params.id,
        user_id,
        role: effectiveRole,
      },
    })

    return reply.status(201).send({ success: true })
  })

  // DELETE /workspaces/:id/members/:uid — remove from workspace
  app.delete<{ Params: { id: string; uid: string } }>('/workspaces/:id/members/:uid', {
    preHandler: workspaceTeamOwnerGuard(),
  }, async (request) => {
    await prisma.workspaceMember.deleteMany({
      where: {
        workspace_id: request.params.id,
        user_id: request.params.uid,
      },
    })

    return { success: true }
  })

  // DELETE /teams/:id/workspaces/:wsId — soft-delete workspace + cascade task_batches
  app.delete<{ Params: { id: string; wsId: string } }>('/teams/:id/workspaces/:wsId', {
    preHandler: teamRoleGuard('owner'),
  }, async (request, reply) => {
    const { id: teamId, wsId } = request.params

    const workspace = await prisma.workspace.findFirst({
      select: { id: true, name: true },
      where: {
        id: wsId,
        team_id: teamId,
        is_deleted: false,
      },
    })
    if (!workspace) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '工作区不存在' } })

    const now = new Date()

    // Cascade: soft-delete task_batches
    await prisma.taskBatch.updateMany({
      where: {
        workspace_id: wsId,
        is_deleted: false,
      },
      data: {
        is_deleted: true,
        deleted_at: now,
      },
    })

    // Soft-delete workspace
    await prisma.workspace.updateMany({
      where: { id: wsId },
      data: {
        is_deleted: true,
        deleted_at: now,
      },
    })

    return { success: true }
  })

  // GET /teams/:id/trash — list soft-deleted workspaces (within 7 days)
  app.get<{ Params: { id: string } }>('/teams/:id/trash', {
    preHandler: teamRoleGuard('owner'),
  }, async (request) => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const workspaces = await prisma.workspace.findMany({
      select: {
        id: true,
        name: true,
        deleted_at: true,
      },
      where: {
        team_id: request.params.id,
        is_deleted: true,
        deleted_at: { gte: cutoff },
      },
      orderBy: { deleted_at: 'desc' },
    })

    return { data: workspaces }
  })

  // POST /teams/:id/trash/:wsId/restore — restore soft-deleted workspace
  app.post<{ Params: { id: string; wsId: string } }>('/teams/:id/trash/:wsId/restore', {
    preHandler: teamRoleGuard('owner'),
  }, async (request, reply) => {
    const { id: teamId, wsId } = request.params

    const workspace = await prisma.workspace.findFirst({
      select: { id: true, name: true },
      where: {
        id: wsId,
        team_id: teamId,
        is_deleted: true,
      },
    })
    if (!workspace) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '已删除的工作区不存在或已过期' } })

    // Check name uniqueness before restoring
    const nameConflict = await prisma.workspace.findFirst({
      select: { id: true },
      where: {
        team_id: teamId,
        name: workspace.name,
        is_deleted: false,
      },
    })
    if (nameConflict) {
      return reply.status(409).send({
        success: false,
        error: { code: 'WORKSPACE_NAME_TAKEN', message: `已有同名工作区"${workspace.name}"，恢复前请先重命名现有工作区` },
      })
    }

    await prisma.workspace.updateMany({
      where: { id: wsId },
      data: {
        is_deleted: false,
        deleted_at: null,
      },
    })

    // Restore task_batches
    await prisma.taskBatch.updateMany({
      where: {
        workspace_id: wsId,
        is_deleted: true,
      },
      data: {
        is_deleted: false,
        deleted_at: null,
      },
    })

    return { success: true }
  })

  // DELETE /teams/:id/trash/:wsId — permanently delete workspace
  app.delete<{ Params: { id: string; wsId: string } }>('/teams/:id/trash/:wsId', {
    preHandler: teamRoleGuard('owner'),
  }, async (request, reply) => {
    const { id: teamId, wsId } = request.params

    const workspace = await prisma.workspace.findFirst({
      select: { id: true },
      where: {
        id: wsId,
        team_id: teamId,
        is_deleted: true,
      },
    })
    if (!workspace) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '工作区不存在或未被删除' } })

    // Get batch IDs
    const batches = await prisma.taskBatch.findMany({
      where: { workspace_id: wsId },
      select: { id: true },
    })
    const batchIds = batches.map((b) => b.id)

    if (batchIds.length > 0) {
      await prisma.asset.deleteMany({ where: { batch_id: { in: batchIds } } })
      await prisma.task.deleteMany({ where: { batch_id: { in: batchIds } } })
      await prisma.taskBatch.deleteMany({ where: { id: { in: batchIds } } })
    }

    await prisma.workspaceMember.deleteMany({ where: { workspace_id: wsId } })
    await prisma.workspace.deleteMany({ where: { id: wsId } })

    return { success: true }
  })

  // GET /workspaces/:id/batches — workspace generation records
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/workspaces/:id/batches', {
    preHandler: workspaceGuard('editor'),
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100)

    const where: { workspace_id: string; created_at?: { lt: Date } } = {
      workspace_id: request.params.id,
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
}
