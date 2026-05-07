import type { FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma.js'

const TEAM_ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 }
const WS_ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 }

export function adminGuard() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user.role !== 'admin') {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      })
    }
  }
}

export function teamRoleGuard(requiredRole: string) {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (request.user.role === 'admin') return

    const membership = await prisma.teamMember.findFirst({
      where: { team_id: request.params.id, user_id: request.user.id },
      select: { role: true },
    })

    if (!membership) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not a member of this team' },
      })
    }

    const userRank = TEAM_ROLE_RANK[membership.role] ?? -1
    const requiredRank = TEAM_ROLE_RANK[requiredRole] ?? 99
    if (userRank < requiredRank) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: `Requires team role: ${requiredRole}` },
      })
    }
  }
}

/**
 * Guard for workspace member management: checks team owner role via workspace's team_id.
 * Per design spec, workspace member CRUD requires TeamRole(owner).
 */
export function workspaceTeamOwnerGuard() {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (request.user.role === 'admin') return

    const workspace = await prisma.workspace.findFirst({
      where: { id: request.params.id },
      select: { team_id: true },
    })

    if (!workspace?.team_id) {
      return reply.notFound('Workspace not found')
    }

    const membership = await prisma.teamMember.findFirst({
      where: { team_id: workspace.team_id, user_id: request.user.id },
      select: { role: true },
    })

    if (!membership || (TEAM_ROLE_RANK[membership.role] ?? -1) < TEAM_ROLE_RANK['owner']) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Requires team owner role' },
      })
    }
  }
}

export function workspaceGuard(requiredRole: string) {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (request.user.role === 'admin') return

    const membership = await prisma.workspaceMember.findFirst({
      where: { workspace_id: request.params.id, user_id: request.user.id },
      select: { role: true },
    })

    if (!membership) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' },
      })
    }

    const userRank = WS_ROLE_RANK[membership.role] ?? -1
    const requiredRank = WS_ROLE_RANK[requiredRole] ?? 99
    if (userRank < requiredRank) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: `Requires workspace role: ${requiredRole}` },
      })
    }
  }
}
