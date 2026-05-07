import { prisma } from '../lib/prisma.js'

export async function buildUserProfile(db: typeof prisma, userId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      phone: true,
      username: true,
      avatar_url: true,
      role: true,
      password_change_required: true,
    },
  })

  const teamRows = await db.teamMember.findMany({
    where: {
      user_id: userId,
      team: { is_deleted: false },
    },
    select: {
      role: true,
      team: {
        select: {
          id: true,
          name: true,
          owner_id: true,
          team_type: true,
          allow_member_topup: true,
        },
      },
    },
  })

  // 批量获取 owner 信息
  const ownerIds = [...new Set(teamRows.map((t) => t.team.owner_id).filter(Boolean) as string[])]
  const ownerMap = new Map<string, { email: string | null; username: string }>()
  if (ownerIds.length > 0) {
    const owners = await db.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, email: true, username: true },
    })
    for (const o of owners) ownerMap.set(o.id, { email: o.email, username: o.username })
  }

  // 批量获取 workspace 成员关系，避免 N+1
  const teamIds = teamRows.map((t) => t.team.id)
  const allWsRows = teamIds.length > 0
    ? await db.workspaceMember.findMany({
        where: {
          user_id: userId,
          workspace: { team_id: { in: teamIds }, is_deleted: false },
        },
        select: {
          role: true,
          workspace: {
            select: { id: true, name: true, team_id: true },
          },
        },
      })
    : []

  // 按 team_id 分组 workspace
  const wsByTeam = new Map<string, Array<{ id: string; name: string; role: string }>>()
  for (const w of allWsRows) {
    if (!w.workspace.team_id) continue
    const list = wsByTeam.get(w.workspace.team_id) ?? []
    list.push({ id: w.workspace.id, name: w.workspace.name, role: w.role })
    wsByTeam.set(w.workspace.team_id, list)
  }

  const teams = teamRows.map((t) => ({
    id: t.team.id,
    name: t.team.name,
    role: t.role,
    team_type: t.team.team_type,
    allow_member_topup: t.team.allow_member_topup,
    owner: ownerMap.get(t.team.owner_id) ?? null,
    workspaces: wsByTeam.get(t.team.id) ?? [],
  }))

  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    username: user.username,
    avatar_url: user.avatar_url,
    role: user.role,
    password_change_required: user.password_change_required,
    teams,
  }
}
