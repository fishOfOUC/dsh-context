import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { ANALYSIS_TOOLS, analysisExportSchema, analysisQuerySchema } from '../shared/analysis'
import type { AnalysisService } from './analysis'
import { failure, mountPostRoute, readBody, reply } from './postRoute'

export const ANALYSIS_ROUTE = '/api/dsh-context/analysis'
export const EXPORT_ROUTE = '/api/dsh-context/export'

interface RunContext {
  signal: AbortSignal
  agent?: { id?: string }
}

export interface AnalysisTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: { type: 'object' }; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  execute(input: unknown, exec: RunContext): Promise<unknown>
}

interface ToolsFace {
  register?(definition: AnalysisTool): () => void
}

export function watchAnalysisInterfaces(ctx: Context, service: AnalysisService): void {
  for (const [path, method] of [[ANALYSIS_ROUTE, 'query'], [EXPORT_ROUTE, 'export']] as const) {
    mountPostRoute({
      ctx,
      deps: ['connection'],
      path,
      label: `dsh-context: ${method} analysis`,
      handler: () => async (request) => {
        const body = await readBody(request)
        if (!body.ok) return body.response
        try {
          return reply({ ok: true, value: await service[method](body.body, request.signal) })
        } catch (error) {
          return failure('dsh-context/analysis-failed', error instanceof Error ? error.message : String(error))
        }
      },
    })
  }
  ctx.inject(['tools'], (c) => {
    const tools = c.get('tools') as ToolsFace | undefined
    if (typeof tools?.register !== 'function') return
    for (const [name, method, schema] of [
      ['context_query', 'query', analysisQuerySchema],
      ['context_export', 'export', analysisExportSchema],
    ] as const) {
      tools.register({
        name,
        description: ANALYSIS_TOOLS[name],
        parameters: z.toJSONSchema(schema, { io: 'input' }),
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (input, exec) => service[method](input, exec.signal, exec.agent?.id),
      })
    }
  })
}
