import { createHash } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { analysisExportSchema, analysisQuerySchema } from '../shared/analysis'
import type { AnalysisExport, AnalysisQuery } from '../shared/analysis'
import type { FoldBounds } from './config'
import type { ColdReadGate } from './coldRead'
import { withCost, type CostSource } from './cost'
import { foldLog } from './detailShadow'
import { buildTimelineHead } from './foldWire'
import { leaseOf, observeOf } from './postRoute'
import { asRecord } from './record'
import type { SessionQueryFace } from './faces'
import { buildAnalysisLedger } from './analysisLedger'
import type { AnalysisEvent, AnalysisLedger } from './analysisLedger'
import { analysisOverview, analysisView } from './analysisViews'
import { familyOverview } from './analysisFamily'
import { fleetDetailOfEvents } from './fleet'

interface Cut {
  schemaVersion: number
  sessionId: string
  header: unknown
  source: unknown
  untilSeq: number
  snapshot: string
  eventCount: number
  eventTypes: Record<string, number>
  boundary: string
}

export interface AnalysisService {
  query(input: unknown, signal?: AbortSignal, currentSessionId?: string): Promise<unknown>
  export(input: unknown, signal?: AbortSignal, currentSessionId?: string): Promise<unknown>
}

function sessionIdOf(id: string | undefined, current: string | undefined): string {
  const value = id ?? current
  if (value === undefined || value === '') throw new Error('sessionId is required outside a dsh session')
  return value
}

async function cutOf(
  observation: unknown, sessionId: string, wanted: { untilSeq?: number; snapshot?: string },
  completed: boolean, signal?: AbortSignal,
): Promise<{ cut: Cut; events: readonly AnalysisEvent[] }> {
  const record = asRecord(observation)
  const events: unknown = record?.events
  if (!Array.isArray(events)) throw new Error('session observation has no complete event log')
  let until = wanted.untilSeq
  let boundary = until === undefined ? 'observed' : 'explicit'
  if (until === undefined && completed && events.some(raw => asRecord(raw)?.type === 'turn/start')) {
    until = -1
    for (let index = events.length - 1; index >= 0; index--) {
      const event = asRecord(events[index])
      if (event?.type === 'turn/end' && typeof event.seq === 'number') { until = event.seq; break }
    }
    boundary = 'last-completed-turn'
  }
  const hash = createHash('sha256')
  const eventTypes: Record<string, number> = Object.create(null) as Record<string, number>
  let lastSeq = -1
  let count = 0
  for (const raw of events) {
    const event = asRecord(raw)
    const seq = event?.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq !== lastSeq + 1 || typeof event?.type !== 'string') {
      throw new Error('session observation is not a contiguous event log')
    }
    lastSeq = seq
    if (until !== undefined && seq > until) break
    hash.update(JSON.stringify(raw)).update('\n')
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
    count++
    if (count % 1000 === 0) { await new Promise(done => setTimeout(done, 0)); signal?.throwIfAborted() }
  }
  const untilSeq = count - 1
  if (until !== undefined && untilSeq !== until) throw new Error('requested session cut is no longer available')
  const snapshot = hash.digest('hex')
  if (wanted.snapshot !== undefined && wanted.snapshot !== snapshot) throw new Error('session cut changed; restart pagination')
  return {
    cut: {
      schemaVersion: 1,
      sessionId,
      header: record?.header ?? null,
      source: record?.source ?? 'unknown',
      untilSeq,
      snapshot,
      eventCount: count,
      eventTypes,
      boundary,
    },
    events: events as AnalysisEvent[],
  }
}

async function statistics(
  events: readonly AnalysisEvent[], cut: Cut, bounds: FoldBounds, cost: CostSource | undefined, signal?: AbortSignal,
): Promise<unknown> {
  const prefix = cut.eventCount === events.length ? events : events.slice(0, cut.eventCount)
  const { state } = await foldLog(prefix, bounds, () => signal?.aborted === true)
  signal?.throwIfAborted()
  return withCost(cost, buildTimelineHead(state))
}

function eventPage(events: readonly AnalysisEvent[], cut: Cut, wanted: AnalysisQuery): unknown {
  const types = wanted.types === undefined ? undefined : new Set(wanted.types)
  const rows: AnalysisEvent[] = []
  let total = 0
  let more = false
  for (let index = 0; index < cut.eventCount; index++) {
    const event = events[index]
    if (types !== undefined && !types.has(event.type)) continue
    total++
    if (event.seq <= wanted.afterSeq) continue
    if (rows.length < wanted.limit) rows.push(event)
    else more = true
  }
  return { ...cut, total, events: rows, nextAfterSeq: more ? rows[rows.length - 1].seq : null }
}

async function writeExport(
  path: string, format: AnalysisExport['format'], metadata: Cut & { statistics: unknown },
  events: readonly AnalysisEvent[], signal?: AbortSignal, report?: AnalysisLedger, includeEvents = true,
): Promise<void> {
  if (!isAbsolute(path)) throw new Error('export path must be absolute on the dsh host')
  signal?.throwIfAborted()
  const file = await open(path, 'wx', 0o600)
  try {
    if (format === 'jsonl') await file.writeFile(`${JSON.stringify({ type: 'dsh-context/export', ...metadata })}\n`)
    else await file.writeFile(`${JSON.stringify(metadata).slice(0, -1)},"events":[`)
    const eventCount = includeEvents ? metadata.eventCount : 0
    for (let index = 0; index < eventCount; index++) {
      signal?.throwIfAborted()
      const separator = format === 'jsonl' ? '\n' : index + 1 === eventCount ? '' : ','
      await file.writeFile(JSON.stringify(events[index]) + separator)
    }
    if (format === 'json') await file.writeFile(']')
    if (report !== undefined) {
      for (const [name, rows] of [['requests', report.requests], ['items', report.items], ['calls', report.calls]] as const) {
        if (format === 'json') await file.writeFile(`,"${name}":[`)
        for (const [index, row] of rows.entries()) {
          signal?.throwIfAborted()
          await file.writeFile(format === 'jsonl'
            ? `${JSON.stringify({ type: `dsh-context/${name}`, value: row })}\n`
            : JSON.stringify(row) + (index + 1 < rows.length ? ',' : ''))
        }
        if (format === 'json') await file.writeFile(']')
      }
    }
    if (format === 'json') await file.writeFile('}\n')
    await file.sync()
  } catch (error) {
    await file.close()
    await unlink(path)
    throw error
  }
  await file.close()
}

export function createAnalysisService(ctx: Context, bounds: FoldBounds, coldReads: ColdReadGate, cost?: CostSource): AnalysisService {
  const read = async <T>(
    wanted: { sessionId?: string; untilSeq?: number; snapshot?: string }, signal: AbortSignal | undefined,
    current: string | undefined, consume: (cut: Cut, events: readonly AnalysisEvent[], inherited: number) => Promise<T>,
    completed = false,
  ): Promise<T> => {
    const id = sessionIdOf(wanted.sessionId, current)
    signal?.throwIfAborted()
    const observe = observeOf(ctx)
    if (observe === undefined) throw new Error('Harness sessionQuery.observeSession is unavailable')
    const value = await coldReads.admit(async () => {
      signal?.throwIfAborted()
      const observation = await observe(id, { projectionMode: 'none', ...(signal === undefined ? {} : { signal }) })
      const release = leaseOf(observation)
      try {
        signal?.throwIfAborted()
        const { cut, events } = await cutOf(observation, id, wanted, completed, signal)
        const inherited = asRecord(observation)?.inheritedEventCount
        return await consume(cut, events, typeof inherited === 'number' ? inherited : 0)
      } finally {
        release()
      }
    })
    if (value === undefined) throw new Error('session analysis deferred under host memory pressure; retry later')
    return value
  }
  return {
    async query(input, signal, current) {
      const wanted = analysisQuerySchema.parse(input)
      signal?.throwIfAborted()
      if (wanted.action === 'sessions') {
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        if (typeof query?.listSessions !== 'function') throw new Error('Harness sessionQuery.listSessions is unavailable')
        const records = await query.listSessions(signal)
        signal?.throwIfAborted()
        if (!Array.isArray(records)) throw new Error('Harness returned an invalid session list')
        const term = wanted.query?.toLowerCase()
        const matched = term === undefined ? records : records.filter(row => JSON.stringify(row).toLowerCase().includes(term))
        const end = wanted.offset + wanted.limit
        return {
          schemaVersion: 1,
          total: matched.length,
          sessions: matched.slice(wanted.offset, end).map(row => ({ ...asRecord(row),
            isCurrent: current === undefined ? null : asRecord(asRecord(row)?.header)?.id === current })),
          currentSessionId: current ?? null,
          nextOffset: end < matched.length ? end : null,
        }
      }
      const rich = wanted.action !== 'events' && wanted.action !== 'stats'
      if (wanted.scope === 'family') {
        if (wanted.action !== 'overview') throw new Error('family scope supports overview; drill into each member using its own cut')
        const id = sessionIdOf(wanted.sessionId, current)
        return familyOverview(id, wanted, async (memberId) => {
          const pin = wanted.familyCuts?.find(row => row.sessionId === memberId)
          const selection = pin ?? (memberId === id ? wanted : { sessionId: memberId })
          return read(selection, signal, current, async (cut, events, inherited) => {
            const prefix = events.slice(0, cut.eventCount)
            const ledger = await buildAnalysisLedger(prefix, inherited, signal)
            const children = fleetDetailOfEvents(prefix, 'preview', ledger.inheritedUntilSeq + 1).delegations?.map(row => row.to) ?? []
            return { ...cut, children, analysis: analysisOverview(ledger, cost) }
          }, !wanted.includeInProgress)
        }, signal)
      }
      if (wanted.action === 'detail' && (wanted.ref === undefined || wanted.snapshot === undefined || wanted.untilSeq === undefined)) {
        throw new Error('detail requires ref, untilSeq and snapshot from the parent result')
      }
      return read(wanted, signal, current, async (cut, events, inherited) => {
        if (wanted.action === 'events') return eventPage(events, cut, wanted)
        if (wanted.action === 'stats') return { ...cut, statistics: await statistics(events, cut, bounds, cost, signal) }
        const ledger = await buildAnalysisLedger(events.slice(0, cut.eventCount), inherited, signal)
        return { ...cut, ...analysisView(ledger, events, wanted, cost) }
      }, rich && !wanted.includeInProgress)
    },
    async export(input, signal, current) {
      const wanted = analysisExportSchema.parse(input)
      return read(wanted, signal, current, async (cut, events, inherited) => {
        const ledger = wanted.report ? await buildAnalysisLedger(events.slice(0, cut.eventCount), inherited, signal) : undefined
        const summary = ledger === undefined ? await statistics(events, cut, bounds, cost, signal)
          : withCost(cost, buildTimelineHead(ledger.state))
        const metadata = { ...cut,
          statistics: summary,
          exportedEventCount: wanted.includeEvents ? cut.eventCount : 0,
          ...(ledger === undefined ? {} : { analysis: analysisOverview(ledger, cost) }) }
        await writeExport(wanted.path, wanted.format, metadata, events, signal, ledger, wanted.includeEvents)
        return { ...cut, path: wanted.path, format: wanted.format }
      }, wanted.report && !wanted.includeInProgress)
    },
  }
}
