import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { analysisQuerySchema } from '../../src/shared/analysis'
import { buildAnalysisLedger, digest, itemContent, type AnalysisEvent } from '../../src/host/analysisLedger'
import { analysisOverview, analysisView } from '../../src/host/analysisViews'
import { count, sumUsage, usageOf } from '../../src/host/analysisUsage'
import {
  assistantMessage, assistantAttempt, header, systemMessage, userMessage, toolCall, toolResult,
  codeDispatch, codeDispatchStart, compaction, endSeed,
} from './helpers/events'

const text = (value: string) => [{ type: 'text' as const, text: value }]
const usage = { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 5 }
const parse = (value: unknown) => JSON.parse(JSON.stringify(value))

function fixture(): AnalysisEvent[] {
  return [
    header(0, { tools: [{ name: 'read', description: 'Read a file', input_schema: {} }, { name: 'unused' }], model: 'm', provider: 'p' }),
    systemMessage(1),
    userMessage(2, text('Investigate this project'), { kind: 'user' }),
    assistantMessage(3, { turn: 1, step: 0, usage }),
    toolCall(4, { callId: 'c1', name: 'read', arguments: '{"path":"src/main.ts"}' }),
    toolResult(5, { callId: 'c1', content: text('long result '.repeat(80)), error: true }),
    assistantMessage(6, { turn: 1, step: 1, usage: { ...usage, inputTokens: 200 } }),
    toolCall(7, { callId: 'c2', name: 'read', arguments: '{"path":"src/main.ts"}' }),
    toolResult(8, { callId: 'c2', content: text('long result '.repeat(80)) }),
    assistantMessage(9, { turn: 1, step: 2, usage: { ...usage, inputTokens: 300 } }),
    compaction(10, 'summary', { shadowedSeqs: [2, 3, 5, 6, 8, 9] }),
    userMessage(11, text('compact summary'), { kind: 'summary' }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 9 } }),
    header(12, { tools: [], model: 'next' }),
    systemMessage(13, { content: text('New prompt') }),
    assistantMessage(14, { turn: 2, step: 0, usage: { ...usage, inputTokens: 10 } }),
  ] as AnalysisEvent[]
}

describe('processed session evidence', () => {
  test('reconciles historical attribution and traces expensive content through requests, calls and replacements', async () => {
    const events = fixture()
    const ledger = await buildAnalysisLedger(events)
    const overview = parse(analysisOverview(ledger))
    assert.equal(overview.reportedUsage.values.input, 1810)
    assert.equal(overview.reportedUsage.values.output, 80)
    assert.equal(overview.attribution.reconciled, true)
    assert.equal(overview.attribution.unattributedEstimatedInputTokens, 0)
    assert.deepEqual(overview.calls, { total: 2, failed: 1, unsettled: 0, repeatedArguments: 1 })
    assert.equal(overview.rankings.unusedDefinitions[0].name, 'unused')
    assert.equal(overview.rankings.repeatedCalls[0].ref, 'call:7')
    assert.equal(overview.rankings.failedCalls[0].ref, 'call:4')
    assert.equal(overview.attribution.cacheByItem, 'unknown')
    const result = ledger.items.find(item => item.seq === 5)!
    assert.equal(result.exposures, 2)
    assert.equal(result.estimatedInputTokens, result.tokens * 2)
    assert.equal(result.callRef, 'call:4')
    assert.deepEqual(result.paths, ['src/main.ts'])
    assert.equal(ledger.items.find(item => item.seq === 8)!.duplicateOf, result.ref)
    assert.equal(ledger.calls[0].ms, 1000)
    const view = (input: Record<string, unknown>) => parse(analysisView(ledger, events, analysisQuerySchema.parse(input)))
    const request = view({ action: 'detail', ref: 'request:14' })
    assert.equal(request.contributors.rows.some((row: { ref: string }) => row.ref === result.ref), false)
    assert.equal(request.removed.rows.some((row: { ref: string }) => row.ref === result.ref), true)
    assert.equal(request.added.rows.some((row: { ref: string }) => row.ref === 'item:11'), true)
    assert.equal(view({ action: 'detail', ref: 'request:3' }).calls.total, 1)
    assert.equal(view({ action: 'detail', ref: 'request:14' }).calls.total, 0)
    const detail = view({ action: 'detail', ref: result.ref, maxChars: 27, limit: 1 })
    assert.equal(detail.requests.total, 2)
    assert.equal(detail.requests.nextOffset, 1)
    assert.equal(detail.content.nextContentOffset, 27)
    assert.deepEqual(detail.evidence, { eventSeq: 5, definitionIndex: null })
    let content = detail.content.content
    let offset = detail.content.nextContentOffset
    while (offset !== null) {
      const next = view({ action: 'detail', ref: result.ref, contentOffset: offset, maxChars: 27 })
      content += next.content.content
      offset = next.content.nextContentOffset
    }
    assert.equal(JSON.parse(content).content[0].text, 'long result '.repeat(80))
    const call = view({ action: 'detail', ref: detail.call.ref })
    assert.equal(call.arguments.content, '{"path":"src/main.ts"}')
    assert.equal(JSON.parse(call.result.content).message.isError, true)
    assert.equal(call.items.rows[0].ref, result.ref)
    for (const sort of ['seq', 'input', 'output', 'growth', 'tokens']) {
      const rows = view({ action: 'requests', sort, fromSeq: 6, toSeq: 9, limit: 1 })
      assert.equal(rows.total, 2)
      assert.equal(rows.reportedUsage.values.input, 1100)
    }
    for (const groupBy of ['file', 'tool', 'content']) {
      const rows = view({ action: 'items', groupBy, category: 'tool', query: 'read', sort: 'tokens', limit: 1 })
      assert.equal(rows.total, 1)
      assert.equal(rows.rows[0].memberCount, 2)
      const group = view({ action: 'detail', ref: rows.rows[0].ref, limit: 1 })
      assert.equal(group.members.total, 2)
      assert.equal(group.members.rows[0], result.ref)
    }
    const definition = view({ action: 'detail', ref: 'definition:0:0' })
    assert.equal(JSON.parse(definition.content.content).name, 'read')
    assert.equal(view({ action: 'items', category: 'tools', query: 'absent' }).total, 0)
    assert.throws(() => view({ action: 'detail', ref: 'absent' }), /not present/)
    assert.throws(() => view({ action: 'detail', ref: 'group:tool:all:absent' }), /not present/)
  })

  test('settles usage samples once per attempt and retains paid retries independently', async () => {
    const stream = [{ type: 'chunk', chunk: { type: 'usage', usage } }]
    const events = [
      userMessage(0, text('work')),
      { seq: 1, type: 'step/start' },
      assistantAttempt(2, { turn: 1, step: 0, stream }),
      assistantMessage(3, { turn: 1, step: 0 }),
      { seq: 4, type: 'llm/retry-started' },
      assistantAttempt(5, { turn: 1, step: 0, stream }),
      assistantMessage(6, { turn: 1, step: 0, usage: { ...usage, inputTokens: 200 } }),
      { seq: 7, type: 'step/end' },
      { seq: 8, type: 'step/start' },
      { seq: 9, type: 'step/end' },
    ] as AnalysisEvent[]
    const ledger = await buildAnalysisLedger(events)
    assert.deepEqual(ledger.requests.map(row => row.eventSeqs), [[2, 3], [5, 6], [9]])
    assert.deepEqual(ledger.requests.map(row => row.attempt), [0, 1, 0])
    assert.deepEqual(ledger.requests.map(row => row.usage.input), [400, 500, null])
    const report = parse(analysisOverview(ledger))
    assert.equal(report.reportedUsage.values.input, null)
    assert.equal(report.reportedUsage.known.input, 900)
    assert.equal(report.reportedUsage.coverage.input, 2)
    assert.equal(report.reportedUsage.cacheHitPercent, null)
  })

  test('excludes inherited bills while attributing reused content and logical program calls', async () => {
    const events = [
      userMessage(0, text('inherited user')),
      assistantMessage(1, { turn: 1, step: 0, usage }),
      endSeed(2, { inherited: true }),
      toolCall(3, { callId: 'parent', name: 'code', arguments: 'program' }),
      codeDispatchStart(4, { rootCallId: 'parent', name: 'read', arguments: { path: 'a.ts' } }),
      codeDispatch(5, { rootCallId: 'parent', name: 'read', isError: true }),
      codeDispatchStart(6, { parentCallId: 'unknown', subCallId: 'pending', name: 'write' }),
      toolResult(7, { callId: 'parent', content: text('program result') }),
      { seq: 8, type: 'tool/result', data: { message: {} } },
      { seq: 9, type: 'tool/call', data: { callId: null, name: 2 } },
      assistantMessage(10, { turn: 2, step: 0, usage }),
    ] as AnalysisEvent[]
    const ledger = await buildAnalysisLedger(events, 2)
    const report = parse(analysisOverview(ledger))
    assert.equal(report.reportedUsage.values.input, 400)
    assert.equal(report.attribution.reconciled, true)
    assert.equal(ledger.items[0].exposures, 1)
    assert.deepEqual(report.calls, { total: 2, failed: 1, unsettled: 1, repeatedArguments: 0 })
    assert.deepEqual(ledger.calls[1].paths, ['a.ts'])
    const files = parse(analysisView(ledger, events, analysisQuerySchema.parse({ action: 'items', groupBy: 'file' })))
    assert.equal(files.rows[0].key, 'a.ts')
    assert.equal(files.rows[0].sampleRefs[0], 'item:7')
    const pending = parse(analysisView(ledger, events, analysisQuerySchema.parse({ action: 'detail', ref: 'call:6' })))
    assert.equal(pending.result, null)
    assert.equal(pending.call.ms, null)
    const inherited = await buildAnalysisLedger([toolCall(0, { callId: 'old', name: 'read' })] as AnalysisEvent[], 1)
    assert.equal(parse(analysisOverview(inherited)).calls.total, 0)
  })

  test('keeps full ledgers past retained UI limits and cooperatively cancels', async () => {
    const events: AnalysisEvent[] = Array.from({ length: 1001 }, (_, seq) => assistantMessage(seq, { turn: seq, step: 0, usage })) as AnalysisEvent[]
    const ledger = await buildAnalysisLedger(events)
    assert.equal(ledger.requests.length, 1001)
    assert.equal(ledger.state.requests.length, 1)
    assert.equal(ledger.items.length, 1001)
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('stop')) }, 0)
    await assert.rejects(buildAnalysisLedger(events, 0, controller.signal), /stop/)
  })

  test('ranks unused definitions and empty settlements without fabricating reported tokens', async () => {
    const events = [
      header(0, { tools: [{ name: 'unused', description: 'large '.repeat(30) }, {}, { name: 'small' }] }),
      userMessage(1, text('one')),
      assistantMessage(2, { turn: 1, step: 0 }),
      toolCall(3, { callId: 'noargs', name: 'small' }),
      { seq: 4, type: 'tool/call', data: { callId: 'raw', name: 'small' } },
      toolResult(5, { callId: 'raw', content: [] }),
      assistantMessage(6, { turn: 1, step: 1 }),
    ] as AnalysisEvent[]
    const ledger = await buildAnalysisLedger(events)
    const view = (input: Record<string, unknown>) => parse(analysisView(ledger, events, analysisQuerySchema.parse(input)))
    assert.equal(ledger.items[1].name, '(unnamed)')
    assert.equal(parse(analysisOverview(ledger)).rankings.unusedDefinitions.length, 2)
    for (const sort of ['input', 'output']) {
      assert.equal(view({ action: 'requests', sort }).rows[0].usage.input, null)
    }
    const items = view({ action: 'items', sort: 'tokens' })
    assert.equal(items.total, 7)
    assert.equal(view({ action: 'items' }).rows[0].ref, 'definition:0:0')
    assert.equal(view({ action: 'detail', ref: 'call:4' }).arguments.content, 'null')
    assert.equal(view({ action: 'detail', ref: 'item:1' }).call, null)
    assert.deepEqual(itemContent({ seq: 0, slot: null }, [{ seq: 0, type: 'future', data: { message: { content: [] } } }]), { content: [] })
    assert.deepEqual(itemContent({ seq: 0, slot: null }, [{ seq: 0, type: 'future', data: { field: 1 } }]), { field: 1 })
    const anonymous = await buildAnalysisLedger([{ seq: 0, type: 'assistant/message', data: {} }])
    assert.equal(parse(analysisOverview(anonymous)).attribution.reconciled, true)
    assert.equal(parse(analysisView(anonymous, [{ seq: 0, type: 'assistant/message', data: {} }],
      analysisQuerySchema.parse({ action: 'detail', ref: 'request:0' }))).contributors.total, 0)
  })

  test('keeps newer context when a prefix is replaced', async () => {
    const events = [userMessage(0, text('old')), userMessage(1, text('keep')),
      userMessage(2, text('summary'), { kind: 'summary' }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }),
      assistantMessage(3, { turn: 1, step: 0, usage })] as AnalysisEvent[]
    const ledger = await buildAnalysisLedger(events)
    assert.equal(ledger.items.find(item => item.seq === 0)!.exposures, 0)
    assert.equal(ledger.items.find(item => item.seq === 1)!.exposures, 1)
    assert.equal(ledger.items.find(item => item.seq === 2)!.exposures, 1)
    assert.equal(parse(analysisOverview(ledger)).attribution.reconciled, true)
  })

  test('resolves inherited duplicate evidence without rebilling it', async () => {
    const events = [
      toolCall(0, { callId: 'old', name: 'read', arguments: '{"path":"a.ts"}' }),
      toolResult(1, { callId: 'old', content: text('old result') }),
      assistantMessage(2, { turn: 1, step: 0, usage }),
      endSeed(3, { inherited: true }),
      toolCall(4, { callId: 'new', name: 'read', arguments: '{"path":"a.ts"}' }),
      toolResult(5, { callId: 'new', content: text('new result') }),
      assistantMessage(6, { turn: 2, step: 0, usage }),
    ] as AnalysisEvent[]
    const ledger = await buildAnalysisLedger(events, 4)
    const view = (input: Record<string, unknown>) => parse(analysisView(ledger, events, analysisQuerySchema.parse(input)))
    const own = view({ action: 'detail', ref: 'call:4' })
    const previous = view({ action: 'detail', ref: own.call.duplicateOf })
    assert.equal(previous.call.inherited, true)
    assert.equal(previous.arguments.content, own.arguments.content)
    assert.equal(JSON.parse(previous.result.content).message.content[0].text, 'old result')
    const request = view({ action: 'detail', ref: 'request:2' })
    assert.equal(request.request.inherited, true)
    assert.equal(request.usageSamples.rows[0], 2)
    assert.equal(view({ action: 'requests' }).total, 1)
    assert.equal(parse(analysisOverview(ledger)).calls.total, 1)
    assert.equal(parse(analysisOverview(ledger)).reportedUsage.values.input, 400)
  })

  test('attributes the surviving system prompt when empty updates or replacements restore it', async () => {
    const events = [
      systemMessage(0), systemMessage(1, { content: [] }),
      assistantMessage(2, { turn: 1, step: 0, usage }),
      systemMessage(3, { content: text('New prompt') }),
      assistantMessage(4, { turn: 1, step: 1, usage }),
      systemMessage(5, { content: [], surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
      assistantMessage(6, { turn: 1, step: 2, usage }),
    ] as AnalysisEvent[]
    for (let seq = 7; seq < 15; seq++) events.push(systemMessage(seq, { content: [] }) as AnalysisEvent)
    events.push(assistantMessage(15, { turn: 1, step: 3, usage }) as AnalysisEvent)
    const ledger = await buildAnalysisLedger(events)
    const prompt = ledger.items.find(item => item.seq === 0)!
    assert.equal(prompt.exposures, 2)
    assert.deepEqual(prompt.ranges, [[0, 1], [2, 3]])
    assert.equal(ledger.items.find(item => item.seq === 3)!.exposures, 1)
    assert.equal(ledger.requests[3].categories.system, 0)
    assert.equal(parse(analysisOverview(ledger)).attribution.reconciled, true)
  })
})

describe('reported usage availability', () => {
  test('preserves unknown values and rejects contradictory or invalid measurements', () => {
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null]) assert.equal(count(value), null)
    assert.equal(count(0), 0)
    assert.equal(usageOf({ usage }).total, 420)
    assert.equal(usageOf({ usage: { inputTokens: 1, outputTokens: 2 } }).input, null)
    assert.equal(usageOf({ usage: { outputTokens: 2, totalTokens: 9 } }).input, 7)
    assert.equal(usageOf({ usage: { ...usage, totalTokens: 10 } }).input, null)
    assert.equal(usageOf({ usage: { ...usage, reasoningTokens: 21 } }).reasoning, null)
    assert.equal(usageOf({ usage: { reasoningTokens: 3 } }).reasoning, null)
    assert.equal(usageOf({ usage: { ...usage, totalTokens: 420 } }).input, 400)
    const stream = [null, { chunk: { type: 'usage', usage } }, { type: 'chunk', chunk: { type: 'text' } },
      { type: 'chunk', chunk: { type: 'usage', usage } }]
    assert.deepEqual(usageOf({ stream }), usageOf({ usage }))
    assert.deepEqual(usageOf({ stream: stream.slice(0, 3) }), usageOf({}))
    assert.equal(sumUsage([{ usage: usageOf({}) }, { usage: usageOf({ usage }) }]).values.input, null)
    assert.equal(sumUsage([]).values.input, 0)
    assert.equal(digest(undefined), digest(null))
    assert.throws(() => usageOf({ usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER } }), /safe integer/)
  })
})
