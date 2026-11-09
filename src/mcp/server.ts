import { McpServer } from '@modelcontextprotocol/server'
import { ANALYSIS_TOOLS, analysisExportSchema, analysisQuerySchema } from '../shared/analysis'
import type { AnalysisClient } from './client'

export function createAnalysisMcpServer(client: AnalysisClient): McpServer {
  const server = new McpServer({ name: 'dsh-context-analysis', version: '1.0.0' })
  const call = async (method: 'query' | 'export', input: unknown, signal: AbortSignal) => {
    try {
      const result = await client.call(method, input, signal)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
    }
  }
  server.registerTool('context_query', {
    description: ANALYSIS_TOOLS.context_query,
    inputSchema: analysisQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (input, extra) => call('query', input, extra.mcpReq.signal))
  server.registerTool('context_export', {
    description: ANALYSIS_TOOLS.context_export,
    inputSchema: analysisExportSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (input, extra) => call('export', input, extra.mcpReq.signal))
  return server
}
