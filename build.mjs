// Bundles the stdio entry together with the server it serves into
// dist/stdio.js. Dependencies stay external: they are installed beside the
// package from its own package.json, at the versions the hosted endpoint at
// normapi.com/mcp is built with.

import { build } from 'esbuild'

await build({
  entryPoints: ['src/stdio.ts'],
  outfile: 'dist/stdio.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
})
