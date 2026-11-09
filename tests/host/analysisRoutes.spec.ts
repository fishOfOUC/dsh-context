import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ANALYSIS_ROUTE, EXPORT_ROUTE, watchAnalysisInterfaces } from '../../src/host/analysisRoutes'
import type { AnalysisTool } from '../../src/host/analysisRoutes'
import type { AnalysisService } from '../../src/host/analysis'
import { connectionOf, fakeCtx, postJson } from './helpers/ctx'

test('registers authenticated host routes and native tools with canonical JSON output', async () => {
  const tools = new Map<string, AnalysisTool>()
  const calls: unknown[][] = []
  const service: AnalysisService = {
    query: (...args) => { calls.push(args); return Promise.resolve({ total: 2 }) },
    export: (...args) => { calls.push(args); return Promise.resolve({ path: 'saved' }) },
  }
  const fake = fakeCtx({ connection: connectionOf(), tools: { register(tool: AnalysisTool) { tools.set(tool.name, tool); return () => {} } } })
  watchAnalysisInterfaces(fake.ctx, service)
  for (const [path, result] of [[ANALYSIS_ROUTE, { total: 2 }], [EXPORT_ROUTE, { path: 'saved' }]] as const) {
    assert.deepEqual(await postJson(fake.routes.get(path)!, path, {}), { ok: true, value: result })
    assert.equal(calls.at(-1)?.[1] instanceof AbortSignal, true)
    assert.equal((await postJson(fake.routes.get(path)!, path, '{bad')).ok, false)
  }
  assert.deepEqual([...tools.keys()], ['context_query', 'context_export'])
  const query = tools.get('context_query')!
  assert.deepEqual((query.parameters as { required: string[] }).required, ['action'])
  assert.deepEqual((tools.get('context_export')!.parameters as { required: string[] }).required, ['path'])
  assert.deepEqual(query.output.schema, { type: 'object' })
  assert.deepEqual(await query.execute({ action: 'stats' }, { signal: new AbortController().signal, agent: { id: 'current' } }), { total: 2 })
  assert.equal(calls.at(-1)?.[2], 'current')
  assert.deepEqual(query.output.render({}, { total: 2 }), [{ type: 'text', text: '{"total":2}' }])
  await tools.get('context_export')!.execute({}, { signal: new AbortController().signal })
  assert.equal(calls.at(-1)?.[2], undefined)
  fake.dispose()
})

test('isolates route failures and leaves missing native-tool capabilities inert', async () => {
  for (const error of [new Error('broken'), 'broken']) {
    const fake = fakeCtx({ connection: connectionOf(), tools: {} })
    watchAnalysisInterfaces(fake.ctx, { query: () => Promise.reject(error), export: () => Promise.reject(error) })
    assert.deepEqual(await postJson(fake.routes.get(ANALYSIS_ROUTE)!, ANALYSIS_ROUTE, {}), { ok: false, error: { code: 'dsh-context/analysis-failed', message: 'broken' } })
  }
  const absent = fakeCtx({}, { injectAll: true })
  watchAnalysisInterfaces(absent.ctx, { query: () => Promise.resolve({}), export: () => Promise.resolve({}) })
  assert.equal(absent.routes.size, 0)
})
