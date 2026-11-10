import { asRecord } from './record'

export interface ReportedUsage {
  uncached: number | null
  cacheRead: number | null
  cacheWrite: number | null
  input: number | null
  output: number | null
  reasoning: number | null
  total: number | null
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function sumCounts(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) throw new Error('reported token sum exceeds the safe integer range')
  return total
}

export function usageOf(data: Record<string, unknown>): ReportedUsage {
  let usage = asRecord(data.usage)
  if (usage === null && Array.isArray(data.stream)) {
    for (const entry of data.stream) {
      const record = asRecord(entry)
      const chunk = record?.type === 'chunk' ? asRecord(record.chunk) : null
      if (chunk?.type === 'usage') usage = asRecord(chunk.usage)
    }
  }
  const uncached = count(usage?.inputTokens)
  const cacheRead = count(usage?.cacheReadTokens)
  const cacheWrite = count(usage?.cacheWriteTokens)
  const output = count(usage?.outputTokens)
  const reportedTotal = count(usage?.totalTokens)
  const knownInput = sumCounts([uncached ?? 0, cacheRead ?? 0, cacheWrite ?? 0])
  let input = uncached !== null && cacheRead !== null && cacheWrite !== null ? knownInput : null
  if (reportedTotal !== null && output !== null) {
    const derived = reportedTotal - output
    input = derived >= knownInput && (input === null || input === derived) ? derived : null
  }
  const reasoning = count(usage?.reasoningTokens)
  return {
    uncached,
    cacheRead,
    cacheWrite,
    input,
    output,
    reasoning: reasoning !== null && output !== null && reasoning <= output ? reasoning : null,
    total: input !== null && output !== null ? sumCounts([input, output]) : null,
  }
}

export function sumUsage(
  rows: readonly { usage: ReportedUsage }[],
): { values: ReportedUsage; known: Record<keyof ReportedUsage, number>; coverage: Record<string, number> } {
  const values = usageOf({})
  const known = { uncached: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, reasoning: 0, total: 0 }
  const coverage: Record<string, number> = {}
  for (const key of Object.keys(values) as (keyof ReportedUsage)[]) {
    let total = 0
    let present = 0
    for (const row of rows) {
      const value = row.usage[key]
      if (value !== null) { total = sumCounts([total, value]); present++ }
    }
    coverage[key] = present
    known[key] = total
    values[key] = present === rows.length ? total : null
  }
  return { values, known, coverage }
}
