import { readFile } from 'node:fs/promises'

export interface AnalysisClient {
  call(method: 'query' | 'export', input: unknown, signal?: AbortSignal): Promise<unknown>
}

export function createAnalysisClient(readUrl: () => Promise<string>, fetcher: typeof fetch = fetch): AnalysisClient {
  let credential: { url: string; cookie: string; base: URL } | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const invoke = async (method: 'query' | 'export', input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const raw = (await readUrl()).trim()
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('DSH_CONTEXT_URL must use HTTP or HTTPS')
    if (credential?.url !== raw) {
      const response = await fetcher(url, { redirect: 'manual', signal })
      const cookie = response.headers.get('set-cookie')?.split(';')[0]
      await response.body?.cancel()
      if (response.status !== 303 || cookie === undefined) throw new Error('dsh authentication failed; refresh the tokenized URL from dsh web')
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      credential = { url: raw, cookie, base: url }
    }
    const response = await fetcher(new URL(`api/dsh-context/${method === 'query' ? 'analysis' : 'export'}`, credential.base), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json', cookie: credential.cookie },
      body: JSON.stringify(input),
    })
    if (!response.ok) {
      credential = undefined
      await response.body?.cancel()
      throw new Error(`dsh analysis HTTP ${response.status}; check the server and tokenized URL`)
    }
    const result = await response.json() as { ok?: boolean; value?: unknown; error?: { message?: string } }
    if (result.ok !== true) throw new Error(result.error?.message ?? 'dsh analysis failed')
    return result.value
  }
  return {
    call(method, input, signal) {
      const result = tail.then(() => invoke(method, input, signal))
      tail = result.then(() => {}, () => {})
      return result
    },
  }
}

export function environmentUrl(env: NodeJS.ProcessEnv): () => Promise<string> {
  return async () => {
    if (env.DSH_CONTEXT_URL_FILE !== undefined) return readFile(env.DSH_CONTEXT_URL_FILE, 'utf8')
    if (env.DSH_CONTEXT_URL !== undefined) return env.DSH_CONTEXT_URL
    throw new Error('Set DSH_CONTEXT_URL_FILE to the saved tokenized dsh web URL, or set DSH_CONTEXT_URL')
  }
}
