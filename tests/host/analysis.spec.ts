import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { createAnalysisService } from '../../src/host/analysis'
import { resolveBounds } from '../../src/host/config'
import { assistantMessage, header, userMessage } from './helpers/events'
import { fakeCtx, observing, OPEN_GATE, SKIP_GATE } from './helpers/ctx'

const bounds = resolveBounds({ maxNodes: 1, maxEvents: 1, maxRequestSteps: 1, maxKeptTurns: 1 })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function service(events: unknown, over: Record<string, unknown> = {}) {
  const source = observing(events, { header: { id: 's1' }, source: 'prepared', ...over })
  const fake = fakeCtx({ sessionQuery: source })
  return { source, api: createAnalysisService(fake.ctx, bounds, OPEN_GATE) }
}

async function output(name = 'session.jsonl'): Promise<string> {
  const root = await mkdtemp(resolve('.tmp/analysis-test-'))
  roots.push(root)
  return resolve(root, name)
}

const query = { action: 'events', sessionId: 's1' }

describe('session analysis', () => {
  test('queries the complete corpus and filters before pagination', async () => {
    const records = ['one', 'two', 'three'].map(id => ({ header: { id } }))
    const api = createAnalysisService(fakeCtx({ sessionQuery: { listSessions: () => Promise.resolve(records) } }).ctx, bounds, OPEN_GATE)
    assert.deepEqual(await api.query({ action: 'sessions', limit: 1 }), { schemaVersion: 1, total: 3, sessions: [{ ...records[0], isCurrent: null }], currentSessionId: null, nextOffset: 1 })
    assert.deepEqual(await api.query({ action: 'sessions', query: 'T', offset: 1, limit: 1 }), { schemaVersion: 1, total: 2, sessions: [{ ...records[2], isCurrent: null }], currentSessionId: null, nextOffset: null })
    const native = await api.query({ action: 'sessions' }, undefined, 'two') as { currentSessionId: string; sessions: { isCurrent: boolean }[] }
    assert.equal(native.currentSessionId, 'two')
    assert.deepEqual(native.sessions.map(row => row.isCurrent), [false, true, false])
    const missing = createAnalysisService(fakeCtx({}).ctx, bounds, OPEN_GATE)
    await assert.rejects(missing.query({ action: 'sessions' }), /listSessions is unavailable/)
    const malformed = createAnalysisService(fakeCtx({ sessionQuery: { listSessions: () => Promise.resolve(null) } }).ctx, bounds, OPEN_GATE)
    await assert.rejects(malformed.query({ action: 'sessions' }), /invalid session list/)
  })

  test('paginates every event beyond UI retention and pins a prefix while the session grows', async () => {
    const events = Array.from({ length: 405 }, (_, seq) => ({ seq, type: seq % 2 ? 'custom/b' : 'custom/a', data: { text: `row ${seq}` } }))
    const { api, source } = service(events)
    const first = await api.query({ ...query, limit: 200 }) as { untilSeq: number; snapshot: string; nextAfterSeq: number; eventCount: number; events: unknown[] }
    assert.equal(first.eventCount, 405)
    assert.equal(first.untilSeq, 404)
    assert.equal(first.nextAfterSeq, 199)
    events.push({ seq: 405, type: 'custom/a', data: { text: 'late' } })
    const rest = await api.query({ ...query, untilSeq: first.untilSeq, snapshot: first.snapshot, afterSeq: 199, limit: 200 }) as typeof first
    const last = await api.query({ ...query, untilSeq: first.untilSeq, snapshot: first.snapshot, afterSeq: rest.nextAfterSeq }) as typeof first
    assert.deepEqual([...first.events, ...rest.events, ...last.events], events.slice(0, 405))
    assert.equal(last.nextAfterSeq, null)
    const selected = await api.query({ ...query, types: ['custom/b'], limit: 1 }) as { total: number; events: { seq: number }[] }
    assert.equal(selected.total, 202)
    assert.equal(selected.events[0].seq, 1)
    events[1].data.text = 'rewritten'
    await assert.rejects(api.query({ ...query, untilSeq: first.untilSeq, snapshot: first.snapshot }), /cut changed/)
    await assert.rejects(api.query({ ...query, untilSeq: 500 }), /no longer available/)
    assert.equal(source.disposeCount(), 6)
  })

  test('refolds all events for statistics even when UI windows retain a single row', async () => {
    const events = [header(0, { model: 'deepseek-v4-flash', provider: 'deepseek' }), userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })]
    for (let seq = 2; seq < 12; seq++) events.push(assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
    const { api } = service(events)
    const result = await api.query({ action: 'stats' }, undefined, 's1') as { eventCount: number; statistics: { counts: { steps: number }; cost: { inputTokens?: number } } }
    assert.equal(result.eventCount, 12)
    assert.equal(result.statistics.counts.steps, 10)
    const prefix = await api.query({ action: 'stats', sessionId: 's1', untilSeq: 3 }) as typeof result
    assert.equal(prefix.eventCount, 4)
    assert.equal(prefix.statistics.counts.steps, 2)
    const cost = { read: () => ({ usd: null, ready: false }), usd: () => null, ready: () => false }
    const priced = createAnalysisService(fakeCtx({ sessionQuery: observing(events) }).ctx, bounds, OPEN_GATE, cost)
    assert.equal((await priced.query({ action: 'stats', sessionId: 's1' }) as { statistics: { costRead: { ready: boolean } } }).statistics.costRead.ready, false)
  })

  test('freezes processed analysis before the current review turn and requires pinned evidence', async () => {
    const events = [
      { seq: 0, type: 'turn/start' },
      header(1),
      userMessage(2, [{ type: 'text', text: 'work' }]),
      assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 } }),
      { seq: 4, type: 'turn/end' },
      { seq: 5, type: 'turn/start' },
      userMessage(6, [{ type: 'text', text: 'review your token usage' }]),
    ]
    const { api } = service(events, { inheritedEventCount: 0 })
    const result = await api.query({ action: 'overview', sessionId: 's1' }) as { untilSeq: number; snapshot: string; boundary: string }
    assert.equal(result.untilSeq, 4)
    assert.equal(result.boundary, 'last-completed-turn')
    const live = await api.query({ action: 'overview', sessionId: 's1', includeInProgress: true }) as typeof result
    assert.equal(live.untilSeq, 6)
    assert.equal(live.boundary, 'observed')
    const detail = { action: 'detail', sessionId: 's1', ref: 'item:2' }
    await assert.rejects(api.query(detail), /detail requires/)
    await assert.rejects(api.query({ ...detail, untilSeq: 4 }), /detail requires/)
    await assert.rejects(api.query({ ...detail, snapshot: result.snapshot }), /detail requires/)
    const evidence = await api.query({ ...detail, untilSeq: 4, snapshot: result.snapshot }) as { evidence: { eventSeq: number } }
    assert.equal(evidence.evidence.eventSeq, 2)
    const empty = await service([{ seq: 0, type: 'turn/start' }]).api.query({ action: 'overview', sessionId: 's1' }) as typeof result
    assert.equal(empty.untilSeq, -1)
  })

  test('exports processed ledgers with optional lossless evidence in both formats', async () => {
    const events = [userMessage(0, [{ type: 'text', text: 'hi' }]), assistantMessage(1, { turn: 1, step: 0 })]
    const { api } = service(events)
    for (const format of ['json', 'jsonl']) {
      for (const includeEvents of [false, true]) {
        const path = await output(`report.${format}`)
        await api.export({ sessionId: 's1', path, format, report: true, includeEvents })
        const source = await readFile(path, 'utf8')
        const value = format === 'json' ? JSON.parse(source) : JSON.parse(source.split('\n')[0])
        assert.equal(value.analysis.reportedUsage.requests, 1)
        assert.equal(value.analysis.attribution.reconciled, true)
        assert.equal(value.exportedEventCount, includeEvents ? 2 : 0)
        if (format === 'json') {
          assert.equal(value.requests.length, 1)
          assert.equal(value.items.length, 2)
          assert.equal(value.calls.length, 0)
          assert.deepEqual(value.events, includeEvents ? events : [])
        } else {
          const rows = source.trim().split('\n').slice(1).map(line => JSON.parse(line))
          assert.equal(rows.filter(row => row.type === 'dsh-context/requests').length, 1)
          assert.equal(rows.filter(row => row.type === 'dsh-context/items').length, 2)
        }
      }
    }
  })

  test('exports JSON and JSONL losslessly, includes unknown event types, and refuses overwrites', async () => {
    const events = [{ seq: 0, type: 'future/event', data: { text: 'hello\n世界', nested: [true, null] } }, { seq: 1, type: '__proto__', data: {} }]
    const { api, source } = service(events)
    for (const format of ['json', 'jsonl']) {
      const path = await output(`session.${format}`)
      const result = await api.export({ sessionId: 's1', path, format }) as { eventCount: number; path: string; snapshot: string }
      assert.equal(result.eventCount, 2)
      assert.equal(result.path, path)
      const text = await readFile(path, 'utf8')
      const value = format === 'json' ? JSON.parse(text) : JSON.parse(text.split('\n')[0])
      const exported = format === 'json' ? value.events : text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line))
      assert.deepEqual(exported, events)
      assert.equal(value.snapshot, result.snapshot)
      assert.equal(value.eventTypes.__proto__, 1)
      assert.equal(value.source, 'prepared')
      await assert.rejects(api.export({ sessionId: 's1', path, format }), /EEXIST/)
      assert.equal(await readFile(path, 'utf8'), text)
    }
    assert.equal(source.disposeCount(), 4)
    const path = await output()
    const empty = service([], { header: undefined, source: undefined }).api
    await empty.export({ path, format: 'json' }, undefined, 's1')
    const value = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(value.events, [])
    assert.equal(value.header, null)
    assert.equal(value.source, 'unknown')
    await assert.rejects(api.export({ sessionId: 's1', path: 'relative.json' }), /must be absolute/)
    await assert.rejects(api.export({ sessionId: 's1', path: await output(), format: 'csv' }))
  })

  test('rejects invalid sources, missing capabilities, bad arguments and skipped reads explicitly', async () => {
    for (const events of [null, [{ seq: 1, type: 'x' }], [{ seq: 0 }], [{ seq: 0.1, type: 'x' }], [null]]) {
      const { api, source } = service(events)
      await assert.rejects(api.query(query), /complete event log|contiguous/)
      assert.equal(source.disposeCount(), 1)
    }
    await assert.rejects(service([]).api.query({ action: 'stats' }), /sessionId is required/)
    await assert.rejects(service([]).api.query({ ...query, limit: 201 }))
    const noQuery = createAnalysisService(fakeCtx({}).ctx, bounds, OPEN_GATE)
    await assert.rejects(noQuery.query(query), /observeSession is unavailable/)
    const skip = createAnalysisService(fakeCtx({ sessionQuery: observing([]) }).ctx, bounds, SKIP_GATE)
    await assert.rejects(skip.query(query), /memory pressure/)
    const unavailable = createAnalysisService(fakeCtx({ sessionQuery: observing([], { events: undefined }) }).ctx, bounds, OPEN_GATE)
    await assert.rejects(unavailable.query(query), /complete event log/)
  })

  test('cancels queued reads and long folds without releasing an incomplete result', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await assert.rejects(service([]).api.query(query, controller.signal), /cancelled/)
    await assert.rejects(service([]).api.export({ path: await output() }, controller.signal, 's1'), /cancelled/)
    const queued = new AbortController()
    const api = createAnalysisService(fakeCtx({ sessionQuery: observing([]) }).ctx, bounds, { admit: read => { queued.abort(new Error('queued')); return read() } })
    await assert.rejects(api.query(query, queued.signal), /queued/)
    const observed = new AbortController()
    let released = false
    const reading = createAnalysisService(fakeCtx({ sessionQuery: { observeSession: () => {
      observed.abort(new Error('observed'))
      return Promise.resolve({ events: [], [Symbol.dispose]: () => { released = true } })
    } } }).ctx, bounds, OPEN_GATE)
    await assert.rejects(reading.query(query, observed.signal), /observed/)
    assert.equal(released, true)
    const folding = new AbortController()
    const long = service(Array.from({ length: 2000 }, (_, seq) => ({ seq, type: 'custom' })))
    setTimeout(() => { folding.abort(new Error('folding')) }, 0)
    await assert.rejects(long.api.query({ action: 'stats', sessionId: 's1' }, folding.signal), /folding/)
    assert.equal(long.source.disposeCount(), 1)
  })

  test('removes an interrupted export instead of leaving a successful-looking file', async () => {
    const path = await output()
    const controller = new AbortController()
    const { api, source } = service(Array.from({ length: 2000 }, (_, seq) => ({ seq, type: 'custom' })))
    const exporting = api.export({ path }, controller.signal, 's1')
    const failed = assert.rejects(exporting, /stop export/)
    for (let attempt = 0; attempt < 1000; attempt++) {
      const content = await readFile(path, 'utf8').catch(() => '')
      if (content !== '') break
      await new Promise(done => setTimeout(done, 1))
    }
    controller.abort(new Error('stop export'))
    await failed
    await assert.rejects(readFile(path), /ENOENT/)
    assert.equal(source.disposeCount(), 1)
  })
})
