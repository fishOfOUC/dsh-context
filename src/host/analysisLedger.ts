import { createHash } from 'node:crypto'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SurfaceNode } from '../shared/types'
import { estimateToolSchema, estimateToolsTotal } from './pricing'
import { applyTimeline, argsRawOf } from './fold'
import { createTimelineState } from './foldState'
import type { TimelineEvent, TimelineState } from './foldState'
import { DEFAULT_BOUNDS } from './config'
import { asRecord } from './record'
import { usageOf, type ReportedUsage } from './analysisUsage'
import { opsOfCall } from '../shared/fileOps'

export interface AnalysisEvent {
  seq: number
  type: string
  data?: unknown
  time?: unknown
  surfaceOp?: unknown
}

export interface AnalysisItem {
  ref: string
  seq: number
  slot: number | null
  category: string
  name: string
  tokens: number
  contentHash: string
  ranges: [number, number][]
  exposures: number
  estimatedInputTokens: number
  anchoredInputTokens: number
  anchoredExposures: number
  calls: number
  callRef: string | null
  paths: string[]
  duplicateOf: string | null
}

export interface AnalysisRequest {
  ref: string
  seq: number
  contextSeq: number
  eventSeqs: number[]
  turn: number | null
  step: number | null
  attempt: number
  inherited: boolean
  outcome: string
  model: string | null
  provider: string | null
  usage: ReportedUsage
  estimatedInputTokens: number
  categories: Record<string, number>
  growth: number
}

export interface AnalysisCall {
  ref: string
  seq: number
  resultSeq: number | null
  callId: string
  name: string
  parentCallId: string | null
  argumentsHash: string
  duplicateOf: string | null
  failed: boolean | null
  ms: number | null
  paths: string[]
  inherited: boolean
  transport: boolean
}

export interface AnalysisLedger {
  requests: AnalysisRequest[]
  items: AnalysisItem[]
  calls: AnalysisCall[]
  state: TimelineState
  inheritedUntilSeq: number
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex')
}

export function itemContent(item: Pick<AnalysisItem, 'seq' | 'slot'>, events: readonly AnalysisEvent[]): unknown {
  const event = events[item.seq]
  const data = asRecord(event.data)
  if (item.slot !== null) return (asRecord(data?.header)?.tools as unknown[])[item.slot]
  const message = deriveEventMessage(event as never)
  return message ?? asRecord(data?.message) ?? data
}

const BOUNDS = { ...DEFAULT_BOUNDS, maxRequestSteps: 1, maxKeptTurns: 1, maxEvents: 1, maxArchiveNodes: 1, maxFileOps: 1, maxCommands: 1 }

function coordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function appendPaths(target: string[], paths: readonly string[]): void {
  const unique = new Set(target)
  for (const path of paths) unique.add(path)
  target.length = 0
  for (const path of unique) target.push(path)
}

export async function buildAnalysisLedger(
  events: readonly AnalysisEvent[], inheritedCount = 0, signal?: AbortSignal,
): Promise<AnalysisLedger> {
  const requests: AnalysisRequest[] = []
  const items: AnalysisItem[] = []
  const calls: AnalysisCall[] = []
  const active = new Map<string, { item: AnalysisItem; since: number }>()
  const definitionNames = new Map<string, AnalysisItem>()
  const callAt = new Map<string, AnalysisCall>()
  const contentFirst = new Map<string, string>()
  const callFirst = new Map<string, string>()
  const counts = [0]
  const scales = [0]
  const reportedCounts = [0]
  let state = createTimelineState()
  let inheritedUntilSeq = inheritedCount - 1
  for (const event of events) {
    if (event.type === 'session/end-seed' && asRecord(event.data)?.inherited === true) inheritedUntilSeq = event.seq
  }
  let slot: AnalysisRequest | null = null
  let attempt = 0
  const hasRequest = (): boolean => slot !== null

  const close = (entry: { item: AnalysisItem; since: number }): void => {
    const end = requests.length
    if (entry.since < end) entry.item.ranges.push([entry.since, end])
    active.delete(entry.item.ref)
  }
  const add = (seq: number, index: number | null, category: string, name: string, tokens: number): AnalysisItem => {
    const pointer = { seq, slot: index }
    const content = itemContent(pointer, events)
    const contentHash = digest(asRecord(content)?.content ?? content)
    const ref = index === null ? `item:${seq}` : `definition:${seq}:${index}`
    const duplicateKey = category + ':' + contentHash
    const first = contentFirst.get(duplicateKey) ?? null
    const item: AnalysisItem = {
      ref,
      ...pointer,
      category,
      name,
      tokens,
      contentHash,
      ranges: [],
      exposures: 0,
      estimatedInputTokens: 0,
      anchoredInputTokens: 0,
      anchoredExposures: 0,
      calls: 0,
      callRef: null,
      paths: [],
      duplicateOf: first,
    }
    if (first === null) contentFirst.set(duplicateKey, ref)
    items.push(item)
    active.set(ref, { item, since: requests.length })
    return item
  }
  const request = (event: AnalysisEvent, data: Record<string, unknown>, outcome: string): void => {
    const turn = coordinate(data.turn)
    const step = coordinate(data.step)
    const categories = { system: state.systemTokens, tools: state.toolsTokens, ...state.sums }
    const estimated = Object.values(categories).reduce((sum, value) => sum + value, 0)
    if (slot !== null && slot.turn === turn && slot.step === step && turn !== null && step !== null) {
      slot.seq = event.seq
      slot.eventSeqs.push(event.seq)
      const nextUsage = usageOf(data)
      if (Object.values(nextUsage).some(value => value !== null)) slot.usage = nextUsage
      slot.outcome = outcome
      return
    }
    slot = {
      ref: `request:${event.seq}`,
      seq: event.seq,
      contextSeq: event.seq,
      eventSeqs: [event.seq],
      turn,
      step,
      attempt,
      inherited: event.seq <= inheritedUntilSeq,
      outcome,
      model: state.model ?? null,
      provider: state.provider ?? null,
      usage: usageOf(data),
      estimatedInputTokens: estimated,
      categories,
      growth: estimated - (requests.at(-1)?.estimatedInputTokens ?? 0),
    }
    requests.push(slot)
  }

  for (const [index, event] of events.entries()) {
    signal?.throwIfAborted()
    const data = asRecord(event.data) ?? {}
    let resultCall: AnalysisCall | undefined
    if (event.type === 'step/start') { slot = null; attempt = 0 }
    if (event.type === 'llm/retry-started') { slot = null; attempt++ }
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      request(event, data, event.type === 'assistant/attempt' ? 'attempt' : 'message')
    }
    if (event.type === 'step/end' && !hasRequest()) request(event, data, 'missing-settlement')
    if (event.type === 'request/header') {
      for (const entry of active.values()) if (entry.item.slot !== null) close(entry)
      definitionNames.clear()
      const definitions = asRecord(data.header)?.tools
      if (Array.isArray(definitions)) {
        const weights = definitions.map(estimateToolSchema)
        const total = weights.reduce((sum, value) => sum + value, 0)
        const target = estimateToolsTotal(definitions)
        let assigned = 0
        let cumulative = 0
        for (const [slotIndex, definition] of definitions.entries()) {
          cumulative += weights[slotIndex]
          const next = Math.round(target * cumulative / total)
          const name = asRecord(definition)?.name
          const item = add(event.seq, slotIndex, 'tools', typeof name === 'string' ? name : '(unnamed)', next - assigned)
          assigned = next
          definitionNames.set(item.name, item)
        }
      }
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const id = event.type === 'tool/call' ? data.callId : data.subCallId
      if (typeof id === 'string' && typeof data.name === 'string') {
        const hash = digest(data.arguments)
        const key = data.name + ':' + hash
        const call: AnalysisCall = {
          ref: `call:${event.seq}`,
          seq: event.seq,
          resultSeq: null,
          callId: id,
          name: data.name,
          parentCallId: typeof data.parentCallId === 'string' ? data.parentCallId : null,
          argumentsHash: hash,
          duplicateOf: callFirst.get(key) ?? null,
          failed: null,
          ms: null,
          paths: [],
          inherited: event.seq <= inheritedUntilSeq,
          transport: false,
        }
        if (!callFirst.has(key)) callFirst.set(key, call.ref)
        calls.push(call)
        callAt.set(id, call)
        if (call.parentCallId !== null) {
          const parent = callAt.get(call.parentCallId)
          if (parent !== undefined) parent.transport = true
        }
        const definition = definitionNames.get(call.name)
        if (definition !== undefined && !call.inherited) definition.calls++
      }
    }
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const message = asRecord(data.message)
      const id = event.type === 'tool/result' ? asRecord(message?.source)?.callId ?? message?.toolCallId : data.subCallId
      const call = typeof id === 'string' ? callAt.get(id) : undefined
      resultCall = call
      if (call !== undefined) {
        call.resultSeq = event.seq
        call.failed = event.type === 'tool/result' ? message?.isError === true : data.isError === true
        const start = events[call.seq].time
        call.ms = typeof start === 'number' && typeof event.time === 'number' ? Math.max(0, event.time - start) : null
        const source = asRecord(events[call.seq].data)
        const paths = opsOfCall({ seq: event.seq, tool: call.name, argsRaw: argsRawOf(source?.arguments), meta: data.meta })
          .map(op => op.path)
        appendPaths(call.paths, paths)
        const root = typeof source?.rootCallId === 'string' ? callAt.get(source.rootCallId) : undefined
        if (root !== undefined) appendPaths(root.paths, call.paths)
      }
    }
    const previous = state
    state = applyTimeline(state, event as unknown as TimelineEvent, BOUNDS)
    if (state.surface !== previous.surface) {
      if (asRecord(event.surfaceOp)?.op === 'replace') {
        const remaining = new Set(state.surface.map(node => node.seq))
        for (const entry of active.values()) {
          if (entry.item.category !== 'system' && entry.item.slot === null && !remaining.has(entry.item.seq)) close(entry)
        }
      }
      const tail = state.surface.at(-1)
      const node: SurfaceNode | undefined = tail?.seq === event.seq ? tail : state.surface.find(row => row.seq === event.seq)
      if (node !== undefined && !active.has(`item:${event.seq}`)) {
        const item = add(node.seq, null, node.cat, node.tool ?? node.skill ?? node.cat, node.tokens)
        if (event.type === 'tool/result') {
          if (resultCall !== undefined) { item.callRef = resultCall.ref; item.paths = resultCall.paths }
        }
      }
    }
    if (event.type === 'system/message' && state.systems !== previous.systems) {
      const system = state.systems?.filter(node => node.tokens > 0).at(-1)
      for (const entry of active.values()) {
        if (entry.item.category === 'system' && entry.item.seq !== system?.seq) close(entry)
      }
      if (system !== undefined && !active.has(`item:${system.seq}`)) {
        const existing = items.find(item => item.category === 'system' && item.seq === system.seq)
        if (existing === undefined) add(system.seq, null, 'system', 'system prompt', system.tokens)
        else active.set(existing.ref, { item: existing, since: requests.length })
      }
    }
    if ((index + 1) % 128 === 0) await new Promise<void>(done => setImmediate(done))
  }
  for (const entry of active.values()) close(entry)
  for (const row of requests) {
    counts.push(counts[counts.length - 1] + (row.inherited ? 0 : 1))
    reportedCounts.push(reportedCounts[reportedCounts.length - 1] + (row.inherited || row.usage.input === null ? 0 : 1))
    scales.push(scales[scales.length - 1] + (row.inherited || row.usage.input === null || row.estimatedInputTokens <= 0
      ? 0 : row.usage.input / row.estimatedInputTokens))
  }
  for (const item of items) {
    let scale = 0
    for (const [from, to] of item.ranges) {
      item.exposures += counts[to] - counts[from]
      item.anchoredExposures += reportedCounts[to] - reportedCounts[from]
      scale += scales[to] - scales[from]
    }
    item.estimatedInputTokens = item.tokens * item.exposures
    item.anchoredInputTokens = Math.round(item.tokens * scale * 100) / 100
  }
  signal?.throwIfAborted()
  return { requests, items, calls, state, inheritedUntilSeq }
}
