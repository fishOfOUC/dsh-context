import { parseArgs } from 'node:util'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createAnalysisClient, environmentUrl } from './client'
import { createAnalysisMcpServer } from './server'

export async function main(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      export: { type: 'string' },
      output: { type: 'string' },
      format: { type: 'string', default: 'jsonl' },
    },
  })
  const client = createAnalysisClient(environmentUrl(env))
  if (values.export !== undefined) {
    if (values.output === undefined) throw new Error('--export requires --output with an absolute host path')
    const result = await client.call('export', { sessionId: values.export, path: values.output, format: values.format })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  serveStdio(() => createAnalysisMcpServer(client))
}
