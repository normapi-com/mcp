import { defineConfig } from 'vitest/config'

// The tool tests. test/stdio.test.mjs uses node:test and runs with `node --test`.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
