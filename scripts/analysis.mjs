#!/usr/bin/env node
import { main } from '../lib/analysis.js'

await main(process.argv.slice(2), process.env).catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
