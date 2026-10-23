import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { PUBLIC_API_BASE_URL } from './api'
import { createNormapiServer } from './server'
import { MCP_SERVER_VERSION } from './version'

/**
 * `npx @normapi/mcp` — the NormAPI MCP server over stdio, for clients that
 * start servers as local processes. The same tools as normapi.com/mcp; the
 * key comes from the environment, as the MCP spec has stdio servers do.
 */

function setting(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

const apiKey = setting('NORMAPI_API_KEY')
const baseUrl = setting('NORMAPI_BASE_URL') ?? PUBLIC_API_BASE_URL

/** Lets the API count calls from this package apart from other traffic. */
const network: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('X-Normapi-Channel', 'mcp-stdio')
  return fetch(input, { ...init, headers })
}

serveStdio(
  () =>
    createNormapiServer({
      version: MCP_SERVER_VERSION,
      connection: (language) => ({
        baseUrl,
        apiKey: apiKey ?? null,
        language,
        fetch: network,
      }),
      canGenerate: apiKey !== undefined,
      missingKeyAdvice:
        "Generating invoices needs a NormAPI API key. Create one free at https://normapi.com/en/account/keys (50 generated invoices a month are included) and set it as NORMAPI_API_KEY in this server's configuration. Validation, reading invoices and rule lookups work without one.",
    }),
  // stdout is the protocol; anything else goes to stderr.
  { onerror: (error) => console.error('normapi-mcp:', error.message) },
)
