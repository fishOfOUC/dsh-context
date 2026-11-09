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

interface AnalysisEvent extends Record<string, unknown> {
  seq: number
  type: string
}

interface Cut {
  schemaVersion: number
  sessionId: string
  header: unknown
  source: unknown
  untilSeq: number
  snapshot: string
  eventCount: number
  eventTypes: Record<string, number>
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

function cutOf(
  observation: unknown, sessionId: string, wanted: { untilSeq?: number; snapshot?: string },
): { cut: Cut; events: readonly AnalysisEvent[] } {
  const record = asRecord(observation)
  const events: unknown = record?.events
  if (!Array.isArray(events)) throw new Error('session observation has no complete event log')
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
    if (wanted.untilSeq !== undefined && seq > wanted.untilSeq) break
    hash.update(JSON.stringify(raw)).update('\n')
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
    count++
  }
  const untilSeq = count - 1
  if (wanted.untilSeq !== undefined && untilSeq !== wanted.untilSeq) throw new Error('requested session cut is no longer available')
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
  events: readonly AnalysisEvent[], signal?: AbortSignal,
): Promise<void> {
  if (!isAbsolute(path)) throw new Error('export path must be absolute on the dsh host')
  signal?.throwIfAborted()
  const file = await open(path, 'wx', 0o600)
  try {
    if (format === 'jsonl') await file.writeFile(`${JSON.stringify({ type: 'dsh-context/export', ...metadata })}\n`)
    else await file.writeFile(`${JSON.stringify(metadata).slice(0, -1)},"events":[`)
    for (let index = 0; index < metadata.eventCount; index++) {
      signal?.throwIfAborted()
      const separator = format === 'jsonl' ? '\n' : index + 1 === metadata.eventCount ? '' : ','
      await file.writeFile(JSON.stringify(events[index]) + separator)
    }
    if (format === 'json') await file.writeFile(']}\n')
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
    current: string | undefined, consume: (cut: Cut, events: readonly AnalysisEvent[]) => Promise<T>,
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
        const { cut, events } = cutOf(observation, id, wanted)
        return await consume(cut, events)
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
          sessions: matched.slice(wanted.offset, end),
          nextOffset: end < matched.length ? end : null,
        }
      }
      return read(wanted, signal, current, async (cut, events) => wanted.action === 'events'
        ? eventPage(events, cut, wanted)
        : { ...cut, statistics: await statistics(events, cut, bounds, cost, signal) })
    },
    async export(input, signal, current) {
      const wanted = analysisExportSchema.parse(input)
      return read(wanted, signal, current, async (cut, events) => {
        const summary = await statistics(events, cut, bounds, cost, signal)
        await writeExport(wanted.path, wanted.format, { ...cut, statistics: summary }, events, signal)
        return { ...cut, path: wanted.path, format: wanted.format }
      })
    },
  }
}
