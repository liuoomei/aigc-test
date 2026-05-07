import { prisma } from '../lib/prisma.js'

interface FilterRule {
  id: string
  pattern: string
  type: 'keyword' | 'regex'
  action: 'reject' | 'flag'
  description: string | null
}

interface FilterResult {
  allowed: boolean
  ruleId?: string
  ruleLabel?: string
}

let cachedRules: FilterRule[] | null = null
let cacheExpiry = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function loadRules(): Promise<FilterRule[]> {
  const now = Date.now()
  if (cachedRules && now < cacheExpiry) return cachedRules

  const rows = await prisma.promptFilterRule.findMany({
    where: { is_active: true },
    select: { id: true, pattern: true, type: true, action: true, description: true },
  })

  cachedRules = rows as FilterRule[]
  cacheExpiry = now + CACHE_TTL
  return cachedRules
}

export async function checkPrompt(
  userId: string,
  prompt: string,
): Promise<FilterResult> {
  const rules = await loadRules()
  const lowerPrompt = prompt.toLowerCase()

  for (const rule of rules) {
    let matched = false

    if (rule.type === 'keyword') {
      matched = lowerPrompt.includes(rule.pattern.toLowerCase())
    } else if (rule.type === 'regex') {
      try {
        const re = new RegExp(rule.pattern, 'i')
        matched = re.test(prompt)
      } catch {
        // Skip invalid regex
      }
    }

    if (matched && rule.action === 'reject') {
      await prisma.promptFilterLog.create({
        data: {
          user_id: userId,
          prompt,
          matched_rules: JSON.stringify([{ id: rule.id, pattern: rule.pattern }]),
          action: 'rejected',
        },
      })

      return {
        allowed: false,
        ruleId: rule.id,
        ruleLabel: rule.description ?? rule.pattern,
      }
    }
  }

  await prisma.promptFilterLog.create({
    data: {
      user_id: userId,
      prompt,
      matched_rules: JSON.stringify([]),
      action: 'pass',
    },
  })

  return { allowed: true }
}
