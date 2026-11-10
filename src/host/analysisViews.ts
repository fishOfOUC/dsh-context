import { billedParts } from '../shared/categories'
import type { AnalysisQuery } from '../shared/analysis'
import type { AnalysisCall, AnalysisEvent, AnalysisItem, AnalysisLedger, AnalysisRequest } from './analysisLedger'
import { digest, itemContent } from './analysisLedger'
import { sumUsage } from './analysisUsage'
import { asRecord } from './record'
import { buildTimelineHead } from './foldWire'
import { withCost, type CostSource } from './cost'

function owned(ledger: AnalysisLedger): AnalysisRequest[] {
  return ledger.requests.filter(row => !row.inherited)
}

function shortItem(item: AnalysisItem): Omit<AnalysisItem, 'ranges'> & { pathsTotal: number } {
  const { ranges: _ranges, paths, ...row } = item
  return { ...row, paths: paths.slice(0, 3), pathsTotal: paths.length }
}

function shortCall(call: AnalysisCall) {
  return { ...call, paths: call.paths.slice(0, 3), pathsTotal: call.paths.length }
}

function shortRequest(request: AnalysisRequest) {
  return { ...request, eventSeqs: request.eventSeqs.slice(0, 3), eventSeqsTotal: request.eventSeqs.length }
}

function present(item: AnalysisItem, index: number): boolean {
  return item.ranges.some(([from, to]) => index >= from && index < to)
}

function page(rows: readonly unknown[], wanted: Pick<AnalysisQuery, 'offset' | 'limit'>): object {
  const end = wanted.offset + wanted.limit
  return { total: rows.length, rows: rows.slice(wanted.offset, end), nextOffset: end < rows.length ? end : null }
}

function textPage(value: unknown, wanted: Pick<AnalysisQuery, 'contentOffset' | 'maxChars'>): object {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const end = wanted.contentOffset + wanted.maxChars
  return {
    encoding: 'utf-16-code-units',
    content: text.slice(wanted.contentOffset, end),
    totalChars: text.length,
    offset: wanted.contentOffset,
    truncated: wanted.contentOffset > 0 || end < text.length,
    nextContentOffset: end < text.length ? end : null,
  }
}

export function analysisOverview(ledger: AnalysisLedger, cost?: CostSource) {
  const requests = owned(ledger)
  const usage = sumUsage(requests)
  const categories: Record<string, number> = {}
  for (const request of requests) {
    for (const [key, value] of Object.entries(request.categories)) categories[key] = (categories[key] ?? 0) + value
  }
  const head = withCost(cost, buildTimelineHead(ledger.state))
  const input = usage.known.input
  const uiUsage = {
    uncachedInputTokens: usage.known.uncached,
    cacheReadTokens: usage.known.cacheRead,
    cacheWriteTokens: usage.known.cacheWrite,
    outputTokens: usage.known.output,
  }
  const calls = ledger.calls.filter(call => !call.inherited && !call.transport)
  const estimated = requests.reduce((sum, row) => sum + row.estimatedInputTokens, 0)
  const attributed = ledger.items.reduce((sum, item) => sum + item.estimatedInputTokens, 0)
  const top = (sort: (left: AnalysisItem, right: AnalysisItem) => number): object[] => ledger.items
    .filter(item => item.exposures > 0).sort(sort).slice(0, 5).map(shortItem)
  return {
    analysisVersion: 1,
    pricingVersion: cost?.version?.() ?? null,
    scope: { requests: 'own-attempts', inheritedUntilSeq: ledger.inheritedUntilSeq },
    statistics: head,
    reportedUsage: { ...usage,
      requests: requests.length,
      cacheHitPercent: usage.values.input !== null && input > 0
      && usage.values.cacheRead !== null ? usage.values.cacheRead / input * 100 : null },
    display: {
      basis: 'shared-billedParts/current-fold-estimate',
      tokenCategories: billedParts(head.current, null, uiUsage, {
        reasoning: head.generatedReasoning, answers: head.generatedAnswerTokens, calls: head.generatedCallTokens,
      }).map(part => ({ category: part.key, tokens: part.value })),
    },
    attribution: {
      basis: 'per-attempt-plugin-surface-estimate',
      categories,
      estimatedInputTokens: estimated,
      attributedEstimatedInputTokens: attributed,
      unattributedEstimatedInputTokens: estimated - attributed,
      reconciled: estimated === attributed,
      cacheByItem: 'unknown',
      providerWireReconstruction: false,
    },
    calls: { total: calls.length,
      failed: calls.filter(call => call.failed === true).length,
      unsettled: calls.filter(call => call.resultSeq === null).length,
      repeatedArguments: calls.filter(call => call.duplicateOf !== null).length },
    rankings: {
      carriedInput: top((left, right) => right.estimatedInputTokens - left.estimatedInputTokens),
      largestItems: top((left, right) => right.tokens - left.tokens),
      unusedDefinitions: ledger.items.filter(item => item.category === 'tools' && item.calls === 0 && item.exposures > 0)
        .sort((left, right) => right.estimatedInputTokens - left.estimatedInputTokens).slice(0, 5).map(shortItem),
      repeatedCalls: calls.filter(call => call.duplicateOf !== null).slice(0, 5).map(shortCall),
      failedCalls: calls.filter(call => call.failed === true).slice(0, 5).map(shortCall),
      unsettledCalls: calls.filter(call => call.resultSeq === null).slice(0, 5).map(shortCall),
    },
    limitations: [
      'Category and item token prices are structural estimates, not provider measurements.',
      'Provider-anchored item shares are estimates; cache buckets cannot be attributed to individual items.',
      'Superseded system prompts and provider-side transformations follow the documented plugin fold limitations.',
      'Repeated content or unused definitions are investigation candidates, not proven waste or guaranteed savings.',
      'This session may reference subagents; their usage is excluded unless queried separately.',
    ],
  }
}

interface ItemGroup {
  ref: string
  key: string
  members: string[]
  tokens: number
  estimatedInputTokens: number
  anchoredInputTokens: number
  exposures: number
  calls: number
}

function selectedItems(ledger: AnalysisLedger, wanted: Pick<AnalysisQuery, 'category' | 'query'>): AnalysisItem[] {
  const query = wanted.query?.toLowerCase()
  return ledger.items.filter(item => (wanted.category === undefined || item.category === wanted.category)
    && (query === undefined || `${item.name}\n${item.paths.join('\n')}`.toLowerCase().includes(query)))
}

function groupsOf(items: readonly AnalysisItem[], by: string, category = 'all'): ItemGroup[] {
  const groups = new Map<string, ItemGroup>()
  for (const item of items) {
    const keys = by === 'file' ? item.paths : [by === 'content' ? `${item.category}:${item.contentHash}` : item.name]
    for (const key of new Set(keys)) {
      let group = groups.get(key)
      if (group === undefined) {
        group = { ref: `group:${by}:${category}:${digest(key)}`,
          key,
          members: [],
          tokens: 0,
          estimatedInputTokens: 0,
          anchoredInputTokens: 0,
          exposures: 0,
          calls: 0 }
        groups.set(key, group)
      }
      group.members.push(item.ref)
      group.tokens += item.tokens
      group.estimatedInputTokens += item.estimatedInputTokens
      group.anchoredInputTokens += item.anchoredInputTokens
      group.exposures += item.exposures
      group.calls += item.calls
    }
  }
  return [...groups.values()]
}

function requestsView(ledger: AnalysisLedger, wanted: AnalysisQuery): object {
  const rows = owned(ledger).filter(row => (wanted.fromSeq === undefined || row.seq >= wanted.fromSeq)
    && (wanted.toSeq === undefined || row.seq <= wanted.toSeq))
  const metric = (row: AnalysisRequest): number => {
    if (wanted.sort === 'input') return row.usage.input ?? -1
    if (wanted.sort === 'output') return row.usage.output ?? -1
    if (wanted.sort === 'growth') return row.growth
    if (wanted.sort === 'tokens') return row.estimatedInputTokens
    return -row.seq
  }
  rows.sort((left, right) => metric(right) - metric(left) || left.seq - right.seq)
  return { ...page(rows.map(shortRequest), wanted),
    reportedUsage: sumUsage(rows),
    estimatedInputTokens: rows.reduce((sum, row) => sum + row.estimatedInputTokens, 0) }
}

export function analysisView(ledger: AnalysisLedger, events: readonly AnalysisEvent[], wanted: AnalysisQuery, cost?: CostSource): object {
  if (wanted.action === 'overview') return analysisOverview(ledger, cost)
  if (wanted.action === 'requests') return requestsView(ledger, wanted)
  const items = selectedItems(ledger, wanted)
  if (wanted.action === 'items') {
    const grouped = wanted.groupBy === 'none' ? []
      : groupsOf(selectedItems(ledger, { category: wanted.category }), wanted.groupBy, wanted.category)
    const selected = new Set(items.map(item => item.ref))
    const rows = wanted.groupBy === 'none' ? items.map(shortItem) : grouped
      .filter(group => group.members.some(ref => selected.has(ref)))
      .map(({ members, ...group }) => ({ ...group, memberCount: members.length, sampleRefs: members.slice(0, 3) }))
    rows.sort((left, right) => (wanted.sort === 'tokens' ? right.tokens - left.tokens
      : right.estimatedInputTokens - left.estimatedInputTokens) || left.ref.localeCompare(right.ref))
    return { ...page(rows, wanted), basis: 'per-attempt-plugin-surface-estimate' }
  }
  const request = ledger.requests.find(row => row.ref === wanted.ref)
  if (request !== undefined) {
    const index = ledger.requests.indexOf(request)
    const contributors = ledger.items.filter(item => present(item, index))
    const removed = index === 0 ? [] : ledger.items.filter(item => present(item, index - 1) && !present(item, index))
    return {
      request: shortRequest(request),
      usageSamples: page(request.eventSeqs, wanted),
      contributors: page(contributors.map(shortItem), wanted),
      added: page(contributors.filter(item => index === 0 || !present(item, index - 1)).map(shortItem), wanted),
      removed: page(removed.map(shortItem), wanted),
      calls: page(ledger.calls.filter(call => call.seq > request.seq
        && (ledger.requests.at(index + 1) === undefined || call.seq < ledger.requests[index + 1].contextSeq)).map(shortCall), wanted),
    }
  }
  const item = ledger.items.find(row => row.ref === wanted.ref)
  if (item !== undefined) {
    const requests = ledger.requests.filter((row, index) => !row.inherited && present(item, index))
    const associated = ledger.calls.find(row => row.ref === item.callRef)
    return { item: shortItem(item),
      paths: page(item.paths, wanted),
      content: textPage(itemContent(item, events), wanted),
      requests: page(requests.map(shortRequest), wanted),
      evidence: { eventSeq: item.seq, definitionIndex: item.slot },
      call: associated === undefined ? null : shortCall(associated) }
  }
  const call = ledger.calls.find(row => row.ref === wanted.ref)
  if (call !== undefined) {
    const source = events[call.seq]
    const result = call.resultSeq === null ? null : events[call.resultSeq]
    return { call: shortCall(call),
      paths: page(call.paths, wanted),
      arguments: textPage(asRecord(source.data)?.arguments ?? null, wanted),
      result: result === null ? null : textPage(result.data, wanted),
      evidence: { callSeq: call.seq, resultSeq: call.resultSeq },
      items: page(ledger.items.filter(row => row.callRef === call.ref).map(shortItem), wanted) }
  }
  if (wanted.ref?.startsWith('group:') === true) {
    const [, by, category] = wanted.ref.split(':')
    const group = groupsOf(ledger.items.filter(item => category === 'all' || item.category === category), by, category)
      .find(row => row.ref === wanted.ref)
    if (group !== undefined) return { ...group, members: page(group.members, wanted) }
  }
  throw new Error('analysis reference is not present in this cut or filter scope')
}
