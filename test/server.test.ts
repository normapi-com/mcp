import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { createNormapiServer, documentFrom, type Language } from '../src/server'

/**
 * The tools as an agent meets them: a real MCP client over an in-memory
 * transport, the real @normapi/client, and only the network replaced. What
 * the fake fetch records is exactly what would have gone to api.normapi.de.
 */

const explanation = {
  meaning: 'Every XRechnung needs a buyer reference in BT-10.',
  cause: 'It is usually missing because the buyer never sent one.',
  fix: 'Enter the Leitweg-ID or the reference the buyer gave you.',
  url: 'https://normapi.com/en/errors/br-de-15',
}

const finding = {
  code: 'BR-DE-15',
  severity: 'ERROR',
  text: '[BR-DE-15] Das Element "Buyer reference" (BT-10) muss übermittelt werden.',
  origin: 'SCHEMATRON',
  location: '/Q{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice[1]',
  line: null,
  column: null,
  test: 'cbc:BuyerReference',
  explanation,
}

const rejected = {
  acceptable: false,
  wellFormed: true,
  schemaValid: true,
  schematronValid: false,
  businessRulesEvaluated: true,
  rulesetVersion: 'v2026-01-31',
  scenario: 'EN16931 XRechnung (UBL Invoice)',
  findings: [finding],
}

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

type Answer = (url: string, init: RequestInit | undefined) => Response

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function connect(answer: Answer, options: { canGenerate?: boolean } = {}) {
  const calls: Call[] = []
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push({ url, init })
    return Promise.resolve(answer(url, init))
  }
  const server = createNormapiServer({
    version: '0.0.0-test',
    connection: (language: Language) => ({
      baseUrl: 'https://api.normapi.de',
      apiKey: 'nk_live_test',
      language,
      fetch: fetchImpl,
    }),
    canGenerate: options.canGenerate ?? true,
    missingKeyAdvice: 'Set NORMAPI_API_KEY.',
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientTransport)
  return { client, calls }
}

function textOf(result: unknown): string {
  const parsed = toolResult(result)
  return parsed.content
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n')
}

interface ToolResultView {
  readonly isError: boolean
  readonly content: readonly {
    readonly type: string
    readonly text?: unknown
    readonly resource?: unknown
  }[]
  readonly structuredContent: unknown
}

function toolResult(result: unknown): ToolResultView {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('not a tool result')
  }
  const content: ToolResultView['content'] = result.content.map((block: unknown) => {
    if (
      typeof block !== 'object' ||
      block === null ||
      !('type' in block) ||
      typeof block.type !== 'string'
    ) {
      throw new Error('not a content block')
    }
    return {
      type: block.type,
      ...('text' in block ? { text: block.text } : {}),
      ...('resource' in block ? { resource: block.resource } : {}),
    }
  })
  return {
    isError: 'isError' in result && result.isError === true,
    content,
    structuredContent:
      'structuredContent' in result ? result.structuredContent : undefined,
  }
}

const invoice = {
  invoiceNumber: 'RE 2026/0815',
  issueDate: '2026-08-13',
  currency: 'EUR',
  buyerReference: '04011000-12345-03',
  seller: {
    name: 'Muster Software GmbH',
    vatId: 'DE123456789',
    address: { city: 'Berlin', postcode: '10115', country: 'DE' },
    contact: { name: 'Maria Muster', phone: '+49 30 1234567', email: 'maria@muster.de' },
  },
  buyer: {
    name: 'Beispiel Handel AG',
    address: { city: 'Hamburg', postcode: '20095', country: 'DE' },
  },
  payment: { meansCode: '58', iban: 'DE02120300000000202051' },
  lines: [
    {
      name: 'Lizenz',
      quantity: '3',
      unit: 'C62',
      unitPrice: '199.00',
      vatCategory: 'S',
      vatRate: 19,
    },
  ],
}

describe('tool list', () => {
  it('offers the four tools, read-only where they are', async () => {
    const { client } = await connect(() => json(500, {}))
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'explain_rule',
      'generate_invoice',
      'parse_invoice',
      'validate_invoice',
    ])
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    expect(byName.get('validate_invoice')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('explain_rule')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('parse_invoice')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('parse_invoice')?.outputSchema).toBeDefined()
    expect(byName.get('generate_invoice')?.annotations?.readOnlyHint).toBe(false)
    expect(byName.get('generate_invoice')?.outputSchema).toBeDefined()
  })

  /** The description is all an agent reads; fields missing there are never sent. */
  it('describes the invoice down to the BT numbers', async () => {
    const { client } = await connect(() => json(500, {}))
    const { tools } = await client.listTools()
    const schema = JSON.stringify(
      tools.find((tool) => tool.name === 'generate_invoice')?.inputSchema,
    )

    expect(schema).toContain('buyerReference')
    expect(schema).toContain('BR-DE-15')
    expect(schema).toContain('taxNumber')
    expect(schema).toContain('directDebit')
  })
})

describe('validate_invoice', () => {
  it('sends the XML and returns verdict, rule set and explained findings', async () => {
    const { client, calls } = await connect(() =>
      json(200, rejected, { 'X-Normapi-Ruleset': 'v2026-01-31' }),
    )

    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: '<Invoice/>', language: 'de', fileName: 'r.xml' },
    })

    expect(calls[0]?.url).toBe('https://api.normapi.de/v1/validate')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('Accept-Language')).toBe('de')
    expect(headers.get('X-Document-Name')).toBe('r.xml')
    expect(calls[0]?.init?.body).toBe('<Invoice/>')

    const view = toolResult(result)
    expect(view.isError).toBe(false)
    expect(view.structuredContent).toMatchObject({
      acceptable: false,
      rulesetVersion: 'v2026-01-31',
      errors: 1,
      findings: [{ code: 'BR-DE-15', explanation }],
    })
    const text = textOf(result)
    expect(text).toContain('NOT ACCEPTABLE')
    expect(text).toContain(`Fix: ${explanation.fix}`)
    expect(text).toContain('v2026-01-31')
  })

  it('decodes a base64 PDF and sends the bytes', async () => {
    const { client, calls } = await connect(() =>
      json(200, { ...rejected, acceptable: true, findings: [] }),
    )
    const pdf = btoa('%PDF-1.7 fake')

    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { pdfBase64: pdf },
    })

    expect(toolResult(result).isError).toBe(false)
    const body = calls[0]?.init?.body
    expect(body).toBeInstanceOf(Uint8Array)
    expect(textOf(result)).toContain('ACCEPTABLE')
  })

  it('refuses both inputs at once without calling the API', async () => {
    const { client, calls } = await connect(() => json(200, rejected))

    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: '<Invoice/>', pdfBase64: btoa('%PDF') },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toContain('exactly one')
    expect(calls).toHaveLength(0)
  })

  it('passes the rate limit on as a wait the agent can respect', async () => {
    const { client } = await connect(() =>
      json(429, { detail: 'slow down' }, { 'Retry-After': '17' }),
    )

    const result = await client.callTool({
      name: 'validate_invoice',
      arguments: { xml: '<Invoice/>' },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toContain('17 seconds')
  })
})

/** A real answer of POST /v1/parse: sample 01 of the library, its second line left out. */
function parsedSample() {
  return {
    syntax: 'ubl',
    documentKind: 'invoice',
    source: {
      kind: 'xml',
      attachment: null,
    },
    specificationId:
      'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
    businessProcess: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    profile: 'xrechnung',
    invoice: {
      invoiceNumber: 'RE-2026-1001',
      issueDate: '2026-10-01',
      typeCode: '380',
      precedingInvoices: [],
      dueDate: '2026-10-31',
      deliveryDate: '2026-09-28',
      deliverTo: null,
      invoicePeriod: null,
      currency: 'EUR',
      buyerReference: '4500012345',
      orderReference: null,
      contractReference: null,
      projectReference: null,
      despatchAdviceReference: null,
      attachments: [],
      note: 'Fiktive Beispielrechnung von NormAPI, frei nutzbar (CC0). Namen, Nummern und Konten sind erfunden.',
      seller: {
        name: 'Muster Software GmbH',
        identifier: null,
        vatId: 'DE123456789',
        taxNumber: null,
        electronicAddress: 'rechnung@muster-software.example',
        electronicAddressScheme: 'EM',
        address: {
          street: 'Beispielstraße 12',
          city: 'Berlin',
          postcode: '10115',
          country: 'DE',
        },
        contact: {
          name: 'Maria Muster',
          phone: '+49 30 1234567',
          email: 'maria.muster@muster-software.example',
        },
        tradingName: null,
        registrationId: null,
        registrationIdScheme: null,
        legalInformation: null,
      },
      buyer: {
        name: 'Beispiel Handel AG',
        identifier: null,
        vatId: null,
        taxNumber: null,
        electronicAddress: 'einkauf@beispiel-handel.example',
        electronicAddressScheme: 'EM',
        address: {
          street: 'Handelsweg 3',
          city: 'Hamburg',
          postcode: '20095',
          country: 'DE',
        },
        contact: null,
        tradingName: null,
        registrationId: null,
        registrationIdScheme: null,
        legalInformation: null,
      },
      payment: {
        meansCode: '58',
        iban: 'DE17100500000123456789',
        reference: 'RE-2026-1001',
        meansText: null,
        accountName: 'Muster Software GmbH',
        bic: 'BELADEBEXXX',
        card: null,
        directDebit: null,
      },
      paymentTerms: 'Zahlbar innerhalb von 30 Tagen ohne Abzug.',
      allowances: [],
      charges: [],
      prepaidAmount: null,
      lines: [
        {
          id: '1',
          name: 'Softwareentwicklung ERP-Schnittstelle',
          description: 'Anbindung des Warenwirtschaftssystems, September 2026',
          quantity: 24,
          unit: 'HUR',
          unitPrice: 95.0,
          vatCategory: 'S',
          vatRate: 19,
          vatExemptionReason: null,
          allowances: [],
          charges: [],
          period: null,
          orderLineReference: null,
          note: null,
          sellerItemId: null,
          buyerItemId: null,
          standardItemId: null,
          standardItemIdScheme: null,
          listPrice: null,
          baseQuantity: null,
        },
      ],
    },
    stated: {
      lineTotal: '2940.00',
      allowanceTotal: null,
      chargeTotal: null,
      netTotal: '2940.00',
      vatTotal: '558.60',
      vatAccountingCurrency: null,
      vatTotalInAccountingCurrency: null,
      grossTotal: '3498.60',
      prepaidAmount: null,
      roundingAmount: null,
      amountDue: '3498.60',
      vatBreakdown: [
        {
          category: 'S',
          rate: '19.00',
          taxableAmount: '2940.00',
          vatAmount: '558.60',
          exemptionReason: null,
          exemptionReasonCode: null,
        },
      ],
      lines: [
        {
          netAmount: '2280.00',
          priceDiscount: null,
          allowances: [],
          charges: [],
        },
      ],
      allowances: [],
      charges: [],
    },
    notMapped: [],
    validation: null,
  }
}

describe('parse_invoice', () => {
  it('reads the invoice into the shape generate_invoice takes', async () => {
    const { client, calls } = await connect(() => json(200, parsedSample()))

    const result = await client.callTool({
      name: 'parse_invoice',
      arguments: { xml: '<Invoice/>' },
    })

    expect(calls[0]?.url).toBe('https://api.normapi.de/v1/parse')
    expect(calls[0]?.init?.body).toBe('<Invoice/>')
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer nk_live_test',
    )
    const view = toolResult(result)
    expect(view.isError).toBe(false)
    expect(view.structuredContent).toMatchObject({
      syntax: 'ubl',
      profile: 'xrechnung',
      readyToGenerate: true,
      missingForGeneration: [],
      validation: null,
      stated: { grossTotal: '3498.60', amountDue: '3498.60' },
    })
    // Nulls and empty lists are gone: generate_invoice takes a field or its absence.
    const structured = view.structuredContent
    const invoice = JSON.stringify(
      typeof structured === 'object' && structured !== null && 'invoice' in structured
        ? structured.invoice
        : null,
    )
    expect(invoice).toContain('"invoiceNumber":"RE-2026-1001"')
    expect(invoice).not.toContain('"deliverTo"')
    expect(invoice).not.toContain('"allowances"')
    expect(invoice).not.toContain('null')
    const text = textOf(result)
    expect(text).toContain('Invoice RE-2026-1001 of 2026-10-01')
    expect(text).toContain(
      'Seller: Muster Software GmbH, VAT ID DE123456789, 10115 Berlin, DE',
    )
    expect(text).toContain('24 HUR × 95 = 2280.00, VAT S 19%')
    expect(text).toContain('gross 3498.60')
    expect(text).toContain('Not mapped: nothing')
    expect(text).toContain(
      'can be passed to generate_invoice as it is, with profile xrechnung',
    )
  })

  it('hands what it read to generate_invoice, which takes it as it is', async () => {
    const { client } = await connect(() => json(200, parsedSample()))
    const parsed = toolResult(
      await client.callTool({ name: 'parse_invoice', arguments: { xml: '<Invoice/>' } }),
    ).structuredContent
    const invoice =
      typeof parsed === 'object' && parsed !== null && 'invoice' in parsed
        ? parsed.invoice
        : null
    const generating = await connect(() => new Response('<Invoice/>', { status: 200 }))

    const result = await generating.client.callTool({
      name: 'generate_invoice',
      arguments: { invoice },
    })

    expect(toolResult(result).isError).toBe(false)
    const sent = generating.calls[0]?.init?.body
    expect(typeof sent === 'string' ? JSON.parse(sent) : null).toMatchObject({
      invoiceNumber: 'RE-2026-1001',
      lines: [{ name: 'Softwareentwicklung ERP-Schnittstelle', unitPrice: 95 }],
    })
  })

  it('names what is missing and what was not read', async () => {
    const sample = parsedSample()
    const { client } = await connect(() =>
      json(200, {
        ...sample,
        invoice: {
          ...sample.invoice,
          invoiceNumber: null,
          seller: { ...sample.invoice.seller, address: null },
        },
        notMapped: [
          {
            path: '/Invoice/cac:InvoiceLine/cac:Item/cac:CommodityClassification/cbc:ItemClassificationCode',
            count: 3,
          },
        ],
      }),
    )

    const result = await client.callTool({
      name: 'parse_invoice',
      arguments: { xml: '<Invoice/>' },
    })

    const view = toolResult(result)
    expect(view.isError).toBe(false)
    expect(view.structuredContent).toMatchObject({ readyToGenerate: false })
    const text = textOf(result)
    expect(text).toContain('(no number)')
    expect(text).toContain('Before generate_invoice could take it: invoiceNumber')
    expect(text).toContain('seller.address')
    expect(text).toContain('cbc:ItemClassificationCode (3×)')
  })

  it('asks for the verdict on request and reports it', async () => {
    const { client, calls } = await connect(() =>
      json(200, { ...parsedSample(), validation: rejected }),
    )

    const result = await client.callTool({
      name: 'parse_invoice',
      arguments: { xml: '<Invoice/>', validate: true, language: 'de' },
    })

    expect(calls[0]?.url).toBe('https://api.normapi.de/v1/parse?validate=true')
    expect(new Headers(calls[0]?.init?.headers).get('Accept-Language')).toBe('de')
    expect(toolResult(result).structuredContent).toMatchObject({
      validation: { acceptable: false, errors: 1 },
    })
    expect(textOf(result)).toContain(`Fix: ${explanation.fix}`)
  })

  it('passes on why a document is no invoice', async () => {
    const { client } = await connect(() =>
      json(422, {
        detail:
          'The root element is project (no namespace). An e-invoice is a UBL Invoice, a UBL CreditNote or a CII CrossIndustryInvoice.',
      }),
    )

    const result = await client.callTool({
      name: 'parse_invoice',
      arguments: { xml: '<project/>' },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toContain(
      'NormAPI could not read this invoice: The root element is project',
    )
  })

  it('refuses an answer of another shape rather than guess', async () => {
    const { client } = await connect(() => json(200, { ...parsedSample(), stated: null }))

    const result = await client.callTool({
      name: 'parse_invoice',
      arguments: { xml: '<Invoice/>' },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toContain('did not have the shape')
  })
})

describe('documentFrom', () => {
  it('refuses base64 that is not a PDF', () => {
    expect(documentFrom(undefined, btoa('<Invoice/>'))).toMatch(
      /^refused:.*does not decode to a PDF/,
    )
  })

  it('refuses text that is not base64', () => {
    expect(documentFrom(undefined, 'not base64!')).toMatch(/^refused:.*not base64/)
  })

  it('accepts a data URL prefix and line breaks', () => {
    const encoded = btoa('%PDF-1.7 fake')
    const document = documentFrom(
      undefined,
      `data:application/pdf;base64,${encoded.slice(0, 4)}\n${encoded.slice(4)}`,
    )
    expect(document).toBeInstanceOf(Uint8Array)
  })
})

describe('generate_invoice', () => {
  it('returns the XML as a resource and in the structured result', async () => {
    const xml = '<Invoice>…</Invoice>'
    const { client, calls } = await connect(
      () =>
        new Response(xml, {
          status: 200,
          headers: {
            'Content-Type': 'application/xml',
            'X-Normapi-Ruleset': 'v2026-01-31',
            'X-Normapi-Scenario': 'EN16931 XRechnung (CII)',
          },
        }),
    )

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { syntax: 'cii', invoice },
    })

    expect(calls[0]?.url).toBe(
      'https://api.normapi.de/v1/invoices?syntax=cii&profile=xrechnung',
    )
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer nk_live_test',
    )
    const sent = calls[0]?.init?.body
    expect(typeof sent === 'string' ? JSON.parse(sent) : null).toMatchObject({
      invoiceNumber: 'RE 2026/0815',
    })

    const view = toolResult(result)
    expect(view.isError).toBe(false)
    expect(view.structuredContent).toMatchObject({
      syntax: 'cii',
      profile: 'xrechnung',
      fileName: 'RE-2026-0815.xml',
      rulesetVersion: 'v2026-01-31',
      xml,
    })
    expect(view.content[1]?.resource).toMatchObject({
      mimeType: 'application/xml',
      text: xml,
    })
  })

  /** A business needs none of what XRechnung adds, and the tool says which rules it met. */
  it('makes an EN 16931 invoice for a business without reference or contact', async () => {
    const { seller } = invoice
    const business = {
      ...Object.fromEntries(
        Object.entries(invoice).filter(([key]) => key !== 'buyerReference'),
      ),
      seller: { name: seller.name, vatId: seller.vatId, address: seller.address },
    }
    const { client, calls } = await connect(
      () =>
        new Response('<Invoice/>', {
          status: 200,
          headers: { 'X-Normapi-Scenario': 'EN16931 (UBL Invoice)' },
        }),
    )

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { syntax: 'ubl', profile: 'en16931', invoice: business },
    })

    expect(calls[0]?.url).toBe(
      'https://api.normapi.de/v1/invoices?syntax=ubl&profile=en16931',
    )
    const view = toolResult(result)
    expect(view.isError).toBe(false)
    expect(view.structuredContent).toMatchObject({ profile: 'en16931' })
    expect(textOf(result)).toContain('Generated EN 16931 (UBL)')
  })

  it('returns the ZUGFeRD PDF as a base64 resource', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 hybrid')
    const { client, calls } = await connect(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
    )

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { syntax: 'zugferd', invoice },
    })

    expect(calls[0]?.url).toBe(
      'https://api.normapi.de/v1/invoices?syntax=zugferd&profile=xrechnung',
    )
    const view = toolResult(result)
    expect(view.isError).toBe(false)
    expect(view.content[1]?.resource).toMatchObject({
      mimeType: 'application/pdf',
      blob: btoa('%PDF-1.7 hybrid'),
    })
    expect(view.structuredContent).toMatchObject({
      fileName: 'RE-2026-0815.pdf',
      bytes: bytes.byteLength,
    })
  })

  it('turns a 422 into the broken rules with their fixes', async () => {
    const { client } = await connect(() =>
      json(422, {
        detail: 'The invoice is not permitted.',
        rulesetVersion: 'v2026-01-31',
        findings: [finding],
      }),
    )

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { invoice },
    })

    expect(toolResult(result).isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('NOT GENERATED')
    expect(text).toContain('BR-DE-15')
    expect(text).toContain(`Fix: ${explanation.fix}`)
  })

  it('says the allowance is used up on a 402, and that validation still works', async () => {
    const { client } = await connect(() => json(402, { detail: 'quota' }))

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { invoice },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toContain('allowance is used up')
    expect(textOf(result)).toContain('Validation still works')
  })

  it('answers with the remedy and calls nothing when there is no key', async () => {
    const { client, calls } = await connect(() => json(200, {}), { canGenerate: false })

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { invoice },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toBe('Set NORMAPI_API_KEY.')
    expect(calls).toHaveLength(0)
  })

  it('rejects data that does not fit the schema before it reaches the API', async () => {
    const { client, calls } = await connect(() => json(200, {}))

    const result = await client.callTool({
      name: 'generate_invoice',
      arguments: { invoice: { ...invoice, currency: 'euro' } },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('explain_rule', () => {
  it('returns the explanation for a code', async () => {
    const { client, calls } = await connect(() =>
      json(200, { code: 'BR-DE-15', language: 'en', explanation }),
    )

    const result = await client.callTool({
      name: 'explain_rule',
      arguments: { code: 'br-de-15' },
    })

    expect(calls[0]?.url).toBe('https://api.normapi.de/v1/rules/br-de-15')
    expect(toolResult(result).structuredContent).toEqual({
      code: 'BR-DE-15',
      language: 'en',
      ...explanation,
    })
    expect(textOf(result)).toContain(explanation.fix)
  })

  it('says what codes look like when there is no such rule', async () => {
    const { client } = await connect(() => json(404, { detail: 'unknown' }))

    const result = await client.callTool({
      name: 'explain_rule',
      arguments: { code: 'cvc-x' },
    })

    expect(toolResult(result).isError).toBe(true)
    expect(textOf(result)).toContain('Codes look like BR-DE-15')
  })
})
