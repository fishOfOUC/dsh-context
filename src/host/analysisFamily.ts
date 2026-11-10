import type { AnalysisQuery } from '../shared/analysis'
import type { analysisOverview } from './analysisViews'
import { sumCounts, sumUsage, type ReportedUsage } from './analysisUsage'

export interface FamilyMember {
  sessionId: string
  untilSeq: number
  snapshot: string
  eventCount: number
  boundary: string
  children: string[]
  analysis: ReturnType<typeof analysisOverview>
}

export async function familyOverview(
  root: string, wanted: AnalysisQuery, read: (id: string) => Promise<FamilyMember>,
  signal?: AbortSignal,
) {
  const queue = [root]
  const seen = new Set(queue)
  const members: FamilyMember[] = []
  const failures: { sessionId: string; error: string }[] = []
  for (const id of queue) {
    signal?.throwIfAborted()
    try {
      const member = await read(id)
      members.push(member)
      for (const child of member.children) {
        if (!seen.has(child)) { seen.add(child); queue.push(child) }
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (id === root) throw error
      failures.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const usage = sumUsage(members.map(member => ({ usage: member.analysis.reportedUsage.values })))
  for (const key of Object.keys(usage.known) as (keyof ReportedUsage)[]) {
    usage.known[key] = sumCounts(members.map(member => member.analysis.reportedUsage.known[key]))
    usage.coverage[key] = members.reduce((sum, member) => sum + member.analysis.reportedUsage.coverage[key], 0)
    if (failures.length > 0) usage.values[key] = null
  }
  const categories: Record<string, number> = {}
  for (const member of members) {
    for (const [key, value] of Object.entries(member.analysis.attribution.categories)) categories[key] = (categories[key] ?? 0) + value
  }
  const page = <T>(rows: T[]) => ({ total: rows.length,
    rows: rows.slice(wanted.offset, wanted.offset + wanted.limit),
    nextOffset: wanted.offset + wanted.limit < rows.length ? wanted.offset + wanted.limit : null })
  return {
    analysisVersion: 1,
    sessionId: root,
    scope: 'family-own-attempts',
    complete: failures.length === 0,
    consistency: 'independent-session-cuts',
    reportedUsage: { ...usage, requests: members.reduce((sum, member) => sum + member.analysis.reportedUsage.requests, 0) },
    attribution: { basis: 'per-attempt-plugin-surface-estimate', categories, cacheByItem: 'unknown' },
    members: page(members.map(({ analysis, children, ...member }) => ({ ...member,
      childCount: children.length,
      reportedUsage: analysis.reportedUsage,
      attribution: analysis.attribution,
      calls: analysis.calls }))),
    failures: page(failures),
  }
}
