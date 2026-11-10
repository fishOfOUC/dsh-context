import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createAnalysisService } from '../../src/host/analysis'
import { familyOverview, type FamilyMember } from '../../src/host/analysisFamily'
import { analysisOverview } from '../../src/host/analysisViews'
import { buildAnalysisLedger } from '../../src/host/analysisLedger'
import { analysisQuerySchema } from '../../src/shared/analysis'
import { resolveBounds } from '../../src/host/config'
import { fakeCtx, OPEN_GATE } from './helpers/ctx'
import { assistantMessage } from './helpers/events'

const catalog = (seq: number, childId: string) => ({ seq, type: 'subagent/catalog',
  data: { childId, childCreatedAt: 10, mode: 'one-shot' } })
const message = (seq: number, inputTokens: number) => assistantMessage(seq, { turn: 1, step: seq,
  usage: { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } })
const parse = (value: unknown) => JSON.parse(JSON.stringify(value))

describe('family analysis', () => {
  test('sums each session own attempts once, follows full delegation history and pins member evidence', async () => {
    const observations: Record<string, unknown> = {
      root: { events: [message(0, 10), catalog(1, 'child'), catalog(2, 'child'), catalog(3, 'missing')] },
      child: { events: [message(0, 10), { seq: 1, type: 'session/end-seed', data: { inherited: true } },
        catalog(2, 'root'), message(3, 20)], inheritedEventCount: 2 },
    }
    let released = 0
    const order: string[] = []
    const api = createAnalysisService(fakeCtx({ sessionQuery: { observeSession: (id: string) => {
      order.push(id)
      if (!(id in observations)) throw new Error('missing child')
      return Promise.resolve({ ...parse(observations[id]), [Symbol.dispose]: () => { released++ } })
    } } }).ctx, resolveBounds({}), OPEN_GATE)
    const wanted = { action: 'overview', scope: 'family', sessionId: 'root', limit: 1 }
    const result = parse(await api.query(wanted))
    assert.deepEqual(order, ['root', 'child', 'missing'])
    assert.equal(released, 2)
    assert.equal(result.complete, false)
    assert.equal(result.reportedUsage.values.input, null)
    assert.equal(result.reportedUsage.known.input, 30)
    assert.equal(result.reportedUsage.coverage.input, 2)
    assert.equal(result.reportedUsage.requests, 2)
    assert.equal(result.members.total, 2)
    assert.equal(result.members.nextOffset, 1)
    assert.equal(result.failures.rows[0].sessionId, 'missing')
    const second = parse(await api.query({ ...wanted, offset: 1 }))
    const cuts = [...result.members.rows, ...second.members.rows].map(({ sessionId, untilSeq, snapshot }) => ({ sessionId, untilSeq, snapshot }))
    const pinned = parse(await api.query({ ...wanted, familyCuts: cuts, includeInProgress: true, limit: 200 }))
    assert.equal(pinned.members.rows[1].boundary, 'explicit')
    assert.equal(pinned.members.rows[1].reportedUsage.values.input, 20)
    assert.equal(second.failures.rows.length, 0)
    await assert.rejects(api.query({ action: 'items', sessionId: 'root', scope: 'family' }), /family scope supports overview/)
    const good = parse(await api.query({ ...wanted, untilSeq: 0, snapshot: cuts[0].snapshot, familyCuts: cuts }))
    assert.equal(good.members.total, 2)
    const withoutChildren = parse(await api.query({ ...wanted, untilSeq: 0 }))
    assert.equal(withoutChildren.complete, true)
    assert.equal(withoutChildren.reportedUsage.values.input, 10)
    await assert.rejects(api.query({ ...wanted, sessionId: 'missing' }), /missing child/)
  })

  test('preserves missing measurements, non-Error failures and cancellation without partial success', async () => {
    const wanted = analysisQuerySchema.parse({ action: 'overview', scope: 'family', limit: 1 })
    const analysis = analysisOverview(await buildAnalysisLedger([{ seq: 0, type: 'assistant/message', data: {} }]))
    const member: FamilyMember = { sessionId: 'root', untilSeq: 0, snapshot: 's', eventCount: 1,
      boundary: 'observed', children: ['missing'], analysis }
    const result = await familyOverview('root', wanted, id => id === 'root' ? Promise.resolve(member) : Promise.reject('unavailable'))
    assert.equal(result.failures.rows[0].error, 'unavailable')
    assert.equal(result.reportedUsage.values.input, null)
    assert.equal(result.reportedUsage.known.input, 0)
    const controller = new AbortController()
    await assert.rejects(familyOverview('root', wanted, () => {
      controller.abort(new Error('cancel family'))
      return Promise.reject(new Error('request failed'))
    }, controller.signal), /cancel family/)
    await assert.rejects(familyOverview('root', wanted, () => Promise.resolve(member), controller.signal), /cancel family/)
  })
})
