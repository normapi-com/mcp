// The built package as a client starts it: `node dist/stdio.js`, JSON-RPC
// over stdin and stdout. Run with `pnpm test`, which builds first.
//
// No network: the calls made here are the ones that must answer without the
// API — the handshake, the tool list, and generation without a key.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

function start(env = {}) {
  const child = spawn(process.execPath, ['dist/stdio.js'], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const waiting = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
    }
  })
  let nextId = 1
  function request(method, params = {}) {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000)
      waiting.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  return { child, request, notify }
}

async function initialized(env) {
  const server = start(env)
  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '1.0.0' },
  })
  server.notify('notifications/initialized')
  return { ...server, init }
}

describe('npx @normapi/mcp', () => {
  it('introduces itself as normapi, at the package version', async () => {
    const { child, init } = await initialized()
    try {
      const version = JSON.parse(readFileSync('package.json', 'utf8')).version
      assert.equal(init.result.serverInfo.name, 'normapi')
      assert.equal(init.result.serverInfo.version, version)
      assert.match(init.result.instructions, /never stored/)
    } finally {
      child.kill()
    }
  })

  it('lists the three tools', async () => {
    const { child, request } = await initialized()
    try {
      const listed = await request('tools/list')
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name).sort(),
        ['explain_rule', 'generate_invoice', 'validate_invoice'],
      )
    } finally {
      child.kill()
    }
  })

  it('without a key, generation answers with where to get one', async () => {
    const { child, request } = await initialized()
    try {
      const called = await request('tools/call', {
        name: 'generate_invoice',
        arguments: {
          invoice: {
            invoiceNumber: 'RE-1',
            issueDate: '2026-10-09',
            currency: 'EUR',
            buyerReference: 'x',
            seller: { name: 'S', address: { city: 'Berlin', postcode: '10115', country: 'DE' } },
            buyer: { name: 'B', address: { city: 'Hamburg', postcode: '20095', country: 'DE' } },
            payment: { meansCode: '58' },
            lines: [{ name: 'L', quantity: 1, unit: 'C62', unitPrice: 1, vatCategory: 'S', vatRate: 19 }],
          },
        },
      })
      assert.equal(called.result.isError, true)
      assert.match(called.result.content[0].text, /NORMAPI_API_KEY/)
    } finally {
      child.kill()
    }
  })
})

describe('server.json, for the official MCP Registry', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const server = JSON.parse(readFileSync('server.json', 'utf8'))

  it('names the package the registry checks ownership of', () => {
    assert.equal(server.name, pkg.mcpName)
    assert.equal(server.packages[0].identifier, pkg.name)
  })

  it('carries the package version everywhere', () => {
    assert.equal(server.version, pkg.version)
    assert.equal(server.packages[0].version, pkg.version)
  })

  it('stays within the registry description limit', () => {
    assert.ok(server.description.length <= 100)
  })
})
