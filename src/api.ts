import {
  Normapi,
  NormapiError,
  RateLimitError,
  ValidatorBusyError,
} from '@normapi/client'
import { z } from 'zod'

// Relative imports only, and none from the app: the stdio package in
// packages/mcp bundles this directory as it is.

/**
 * The API as the tools reach it. Each transport says where the API is, whose
 * key to send and which fetch carries the call — its own headers, the relay's
 * — and the tools build what they call from that.
 *
 * Most calls go through @normapi/client. POST /v1/parse does not yet: the
 * client has parse() from 0.7.0, and both the hosted endpoint and the npm
 * package depend on 0.5.0 until that release is published. Until then the
 * call is made here, over the same connection, and its answer is checked with
 * zod as the client would check it. Once the dependency moves, parseDocument
 * becomes `clientFor(connection).parse(…)`.
 */

export type Language = 'de' | 'en'

/** Where the public API answers; the client's own default. */
export const PUBLIC_API_BASE_URL = 'https://api.normapi.de'

export interface ApiConnection {
  readonly baseUrl: string
  /** The caller's API key, sent as a Bearer token; null for an anonymous caller. */
  readonly apiKey: string | null
  /** The language of the findings' explanations. */
  readonly language: Language
  /** Carries every call, with whatever headers the transport adds. */
  readonly fetch: typeof fetch
}

export function clientFor(connection: ApiConnection): Normapi {
  return new Normapi({
    baseUrl: connection.baseUrl,
    language: connection.language,
    fetch: connection.fetch,
    ...(connection.apiKey === null ? {} : { apiKey: connection.apiKey }),
  })
}

// ---------------------------------------------------------------------------
// The response of POST /v1/parse. Every field is present, null where the
// document has no value: an incoming invoice may lack what generation
// requires, so nothing is required here. The field names are the request's —
// lib/mcp/api.test.ts holds them to the generation schema, which
// invoice-schema.test.ts holds to the backend's record.
// ---------------------------------------------------------------------------

const text = z.string().nullable()
const amount = z.number().nullable()

const period = z.object({ startDate: text, endDate: text })

const address = z.object({ street: text, city: text, postcode: text, country: text })

const party = z.object({
  name: text,
  identifier: text,
  vatId: text,
  taxNumber: text,
  electronicAddress: text,
  electronicAddressScheme: text,
  address: address.nullable(),
  contact: z.object({ name: text, phone: text, email: text }).nullable(),
  tradingName: text,
  registrationId: text,
  registrationIdScheme: text,
  legalInformation: text,
})

const lineAdjustment = z.object({
  amount,
  percent: amount,
  baseAmount: amount,
  reason: text,
  reasonCode: text,
})

const line = z.object({
  id: text,
  name: text,
  description: text,
  quantity: amount,
  unit: text,
  unitPrice: amount,
  vatCategory: text,
  vatRate: amount,
  vatExemptionReason: text,
  allowances: z.array(lineAdjustment),
  charges: z.array(lineAdjustment),
  period: period.nullable(),
  orderLineReference: text,
  note: text,
  sellerItemId: text,
  buyerItemId: text,
  standardItemId: text,
  standardItemIdScheme: text,
  listPrice: amount,
  baseQuantity: amount,
})

const adjustment = lineAdjustment.extend({
  vatCategory: text,
  vatRate: amount,
  vatExemptionReason: text,
})

export const parsedInvoiceSchema = z.object({
  invoiceNumber: text,
  issueDate: text,
  typeCode: z.string(),
  precedingInvoices: z.array(z.object({ number: text, issueDate: text })),
  dueDate: text,
  deliveryDate: text,
  deliverTo: z
    .object({
      name: text,
      locationId: text,
      locationIdScheme: text,
      address: address.nullable(),
    })
    .nullable(),
  invoicePeriod: period.nullable(),
  currency: text,
  buyerReference: text,
  orderReference: text,
  contractReference: text,
  projectReference: text,
  despatchAdviceReference: text,
  attachments: z.array(
    z.object({
      id: text,
      description: text,
      filename: text,
      mimeCode: text,
      content: text,
      url: text,
    }),
  ),
  note: text,
  seller: party.nullable(),
  buyer: party.nullable(),
  payment: z
    .object({
      meansCode: text,
      iban: text,
      reference: text,
      meansText: text,
      accountName: text,
      bic: text,
      card: z.object({ number: text, holder: text, network: text }).nullable(),
      directDebit: z
        .object({ mandateReference: text, creditorId: text, debitedAccount: text })
        .nullable(),
    })
    .nullable(),
  paymentTerms: text,
  allowances: z.array(adjustment),
  charges: z.array(adjustment),
  prepaidAmount: amount,
  lines: z.array(line),
})

export type ParsedInvoice = z.infer<typeof parsedInvoiceSchema>

const statedAdjustment = z.object({ amount: text })

export const statedSchema = z.object({
  lineTotal: text.describe('BT-106, the sum of the line nets'),
  allowanceTotal: text.describe('BT-107'),
  chargeTotal: text.describe('BT-108'),
  netTotal: text.describe('BT-109, the total without VAT'),
  vatTotal: text.describe('BT-110, in the invoice currency'),
  vatAccountingCurrency: text.describe(
    'BT-6, when VAT is also accounted in another currency',
  ),
  vatTotalInAccountingCurrency: text.describe('BT-111, the VAT total in that currency'),
  grossTotal: text.describe('BT-112, the total with VAT'),
  prepaidAmount: text.describe('BT-113'),
  roundingAmount: text.describe('BT-114'),
  amountDue: text.describe('BT-115'),
  vatBreakdown: z
    .array(
      z.object({
        category: text,
        rate: text,
        taxableAmount: text,
        vatAmount: text,
        exemptionReason: text,
        exemptionReasonCode: text.describe(
          'BT-121, which the invoice data does not carry',
        ),
      }),
    )
    .describe('BG-23, one entry per VAT category and rate'),
  lines: z
    .array(
      z.object({
        netAmount: text.describe('BT-131'),
        priceDiscount: text.describe('BT-147'),
        allowances: z.array(statedAdjustment),
        charges: z.array(statedAdjustment),
      }),
    )
    .describe('One per invoice line, in the same order'),
  allowances: z.array(statedAdjustment).describe('One per document allowance'),
  charges: z.array(statedAdjustment).describe('One per document charge'),
})

export const notMappedSchema = z.object({
  path: z.string(),
  count: z.number().int(),
})

/** The verdict as /v1/validate sends it; @normapi/client's ValidationResult. */
const validationResultSchema = z.object({
  acceptable: z.boolean(),
  wellFormed: z.boolean(),
  schemaValid: z.boolean(),
  schematronValid: z.boolean(),
  businessRulesEvaluated: z.boolean(),
  rulesetVersion: z.string(),
  scenario: text,
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['ERROR', 'WARNING', 'INFORMATION']),
      text: z.string(),
      origin: z.enum(['SCHEMA', 'SCHEMATRON']),
      location: text,
      line: z.number().int().nullable(),
      column: z.number().int().nullable(),
      test: text,
      explanation: z
        .object({
          meaning: z.string(),
          cause: z.string(),
          fix: z.string(),
          url: z.string(),
        })
        .nullable(),
    }),
  ),
})

export const parseResponseSchema = z.object({
  syntax: z.enum(['ubl', 'cii']),
  documentKind: z.enum(['invoice', 'creditNote']),
  source: z.object({ kind: z.enum(['xml', 'pdf']), attachment: text }),
  specificationId: text,
  businessProcess: text,
  profile: z.enum(['xrechnung', 'en16931']).nullable(),
  invoice: parsedInvoiceSchema,
  stated: statedSchema,
  notMapped: z.array(notMappedSchema),
  validation: validationResultSchema.nullable(),
})

export type ParseResponse = z.infer<typeof parseResponseSchema>

/**
 * POST /v1/parse. Throws the client's own errors — RateLimitError,
 * ValidatorBusyError, NormapiError with the problem's detail — so a refusal
 * reads the same as one from validation.
 */
export async function parseDocument(
  connection: ApiConnection,
  document: string | Uint8Array,
  validate: boolean,
): Promise<ParseResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml',
    'Accept-Language': connection.language,
  }
  if (connection.apiKey !== null && connection.apiKey !== '') {
    headers['Authorization'] = `Bearer ${connection.apiKey}`
  }
  const base = connection.baseUrl.replace(/\/+$/, '')
  const response = await connection.fetch(
    `${base}/v1/parse${validate ? '?validate=true' : ''}`,
    { method: 'POST', headers, body: bodyOf(document) },
  )
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw errorOf(response, body)
  }
  const parsed = parseResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new NormapiError(
      'unexpected response shape from the parse service',
      response.status,
      'its answer did not have the shape this server expects',
    )
  }
  return parsed.data
}

/** fetch wants bytes backed by a plain ArrayBuffer; a copy guarantees one. */
function bodyOf(document: string | Uint8Array): string | Uint8Array<ArrayBuffer> {
  if (typeof document === 'string') {
    return document
  }
  const copy = new Uint8Array(document.byteLength)
  copy.set(document)
  return copy
}

const problemSchema = z.object({ detail: z.string() })

function errorOf(response: Response, body: unknown): NormapiError {
  const problem = problemSchema.safeParse(body)
  const detail = problem.success ? problem.data.detail : ''
  const header = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
  const retryAfter = Number.isFinite(header) && header > 0 ? header : 5
  if (response.status === 429) {
    return new RateLimitError(detail, retryAfter)
  }
  if (response.status === 503) {
    return new ValidatorBusyError(detail, retryAfter)
  }
  return new NormapiError(
    detail === '' ? `request failed with status ${response.status}` : detail,
    response.status,
    detail,
  )
}
