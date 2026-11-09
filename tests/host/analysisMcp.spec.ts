import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createAnalysisMcpServer } from '../../src/mcp/server'
import { createAnalysisClient, environmentUrl } from '../../src/mcp/client'
import { main } from '../../src/mcp/main'

const { serve } = vi.hoisted(() => ({ serve: vi.fn() }))
vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: serve }))
afterEach(() => { vi.restoreAllMocks(); serve.mockReset() })

test('negotiates MCP and calls both tools through real protocol messages', async () => {
  const calls: unknown[][] = []
  const server = createAnalysisMcpServer({ call: (...args) => {
    calls.push(args)
    if ((args[1] as { sessionId?: string }).sessionId === 'error') return Promise.reject(new Error('unreadable'))
    if ((args[1] as { sessionId?: string }).sessionId === 'string') return Promise.reject('failed')
    return Promise.resolve({ count: 42 })
  } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const pending = new Map<number, (value: unknown) => void>()
  clientTransport.onmessage = message => {
    if ('id' in message && typeof message.id === 'number') pending.get(message.id)?.(message)
  }
  await clientTransport.start()
  await server.connect(serverTransport)
  let id = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const nextId = ++id
    const result = new Promise<unknown>(done => { pending.set(nextId, done) })
    await clientTransport.send({ jsonrpc: '2.0', id: nextId, method, params })
    return await result as { result: { tools: { name: string }[]; isError?: boolean; content: { text: string }[] } }
  }
  try {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const listed = await request('tools/list', {})
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['context_query', 'context_export'])
    for (const [name, method, args] of [
      ['context_query', 'query', { action: 'stats', sessionId: 's1' }],
      ['context_export', 'export', { sessionId: 's1', path: 'C:/export.json' }],
    ] as const) {
      const called = await request('tools/call', { name, arguments: args })
      assert.deepEqual(JSON.parse(called.result.content[0].text), { count: 42 })
      assert.equal(calls.at(-1)?.[0], method)
      assert.equal(calls.at(-1)?.[2] instanceof AbortSignal, true)
    }
    for (const [sessionId, text] of [['error', 'unreadable'], ['string', 'failed']]) {
      const failed = await request('tools/call', { name: 'context_query', arguments: { action: 'stats', sessionId } })
      assert.equal(failed.result.isError, true)
      assert.equal(failed.result.content[0].text, text)
    }
  } finally {
    await clientTransport.close()
    await server.close()
  }
})

test('authenticates once, preserves proxy prefixes, refreshes credentials, and forwards errors', async () => {
  let url = 'http://dsh.test/prefix/?token=first'
  let mode = 'ok'
  const requests: { url: string; options?: RequestInit }[] = []
  const fetcher = (async (input: URL | RequestInfo, options?: RequestInit) => {
    requests.push({ url: String(input), options })
    if (String(input).includes('?token=')) {
      return new Response(null, { status: mode === 'auth' ? 401 : 303, headers: mode === 'cookie' ? {} : { 'set-cookie': 'dsh=secret; HttpOnly' } })
    }
    if (mode === 'http') return new Response('unauthorized', { status: 401 })
    return Response.json(mode === 'error' ? { ok: false, error: { message: 'missing session' } } : mode === 'empty' ? {} : { ok: true, value: { count: 5 } })
  }) as typeof fetch
  const client = createAnalysisClient(() => Promise.resolve(url), fetcher)
  assert.deepEqual(await client.call('query', { action: 'sessions' }), { count: 5 })
  assert.equal(requests[1].url, 'http://dsh.test/prefix/api/dsh-context/analysis')
  assert.equal((requests[1].options?.headers as Record<string, string>).cookie, 'dsh=secret')
  await client.call('export', {})
  assert.equal(requests.length, 3)
  mode = 'http'
  await assert.rejects(client.call('query', {}), /HTTP 401/)
  mode = 'ok'
  await client.call('query', {})
  mode = 'error'
  await assert.rejects(client.call('query', {}), /missing session/)
  mode = 'empty'
  await assert.rejects(client.call('query', {}), /dsh analysis failed/)
  for (const rejected of ['auth', 'cookie']) {
    mode = rejected
    url = `http://dsh.test/?token=${rejected}`
    await assert.rejects(client.call('query', {}), /authentication failed/)
  }
  mode = 'ok'
  url = 'https://dsh.test?token=next'
  await client.call('query', {})
  url = 'https://dsh.test/prefix?token=next'
  await client.call('query', {})
  url = 'file:///tmp/data'
  await assert.rejects(client.call('query', {}), /HTTP or HTTPS/)
})

test('reads saved URLs, exports through the CLI and starts a stdio server without stdout noise', async () => {
  const root = await mkdtemp(resolve('.tmp/analysis-mcp-'))
  const urlFile = resolve(root, 'url.txt')
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(303, { 'set-cookie': 'dsh=test; HttpOnly', location: './' })
      response.end()
    } else {
      assert.equal(request.headers.cookie, 'dsh=test')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, value: { path: 'saved.jsonl', eventCount: 100 } }))
    }
  })
  await new Promise<void>(done => { server.listen(0, '127.0.0.1', done) })
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/?token=local`
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    await writeFile(urlFile, url)
    assert.equal(await environmentUrl({ DSH_CONTEXT_URL: url })(), url)
    assert.equal(await environmentUrl({ DSH_CONTEXT_URL: 'ignored', DSH_CONTEXT_URL_FILE: urlFile })(), url)
    await assert.rejects(environmentUrl({})(), /Set DSH_CONTEXT_URL_FILE/)
    await main(['--export', 's1', '--output', 'C:/saved.jsonl'], { DSH_CONTEXT_URL_FILE: urlFile })
    assert.equal(stdout.mock.calls.length, 1)
    assert.equal(JSON.parse(String(stdout.mock.calls[0][0])).eventCount, 100)
    await assert.rejects(main(['--export', 's1'], {}), /requires --output/)
    await main([], { DSH_CONTEXT_URL: url })
    assert.equal(serve.mock.calls.length, 1)
    const factory = serve.mock.calls[0][0] as () => ReturnType<typeof createAnalysisMcpServer>
    await factory().close()
    assert.equal(stdout.mock.calls.length, 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()) })
    await rm(root, { recursive: true, force: true })
  }
})
