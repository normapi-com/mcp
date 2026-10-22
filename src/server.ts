import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, ScopeChallengeHandler } from '@modelcontextprotocol/server'
import {
  InvoiceNotPermittedError,
  NormapiError,
  RateLimitError,
  ValidatorBusyError,
  type Finding,
  type Normapi,
  type ValidationResult,
} from '@normapi/client'
import { z } from 'zod'
import { invoiceSchema } from './invoice-schema'

// Relative imports only, and none from the app: the stdio package in
// packages/mcp bundles this directory as it is.

/**
 * The NormAPI MCP server: three tools over the public API, built once and
 * served two ways — over HTTP at normapi.com/mcp, and over stdio by the npm
 * package. What differs between the two (where the key comes from, what to
 * tell an agent that has none, how the API sees the caller) arrives through
 * {@link ServerSettings}; the tools themselves cannot tell which one they run
 * in.
 */

export type Language = 'de' | 'en'

/** The scope that lets a token generate invoices; validation needs none. */
export const GENERATE_SCOPE = 'invoices:write'

/** The limit /v1/validate enforces; checked here first so the refusal can say why. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

export interface ServerSettings {
  readonly version: string
  /** A client for one explanation language; it owns the base URL, the key and the headers. */
  readonly client: (language: Language) => Normapi
  /** False when no key is available, so generation can answer with the remedy at once. */
  readonly canGenerate: boolean
  /** What an agent without a key is told to do — different over HTTP and over stdio. */
  readonly missingKeyAdvice: string
  /** HTTP only: asks a token without the generation scope to come back with it. */
  readonly generateScopeChallenge?: ScopeChallengeHandler
}

const language = z
  .enum(['en', 'de'])
  .default('en')
  .describe('Language of the plain-language explanations: en (default) or de')

const explanationOutput = z.object({
  meaning: z.string(),
  cause: z.string(),
  fix: z.string(),
  url: z.string(),
})

const findingOutput = z.object({
  code: z.string(),
  severity: z.enum(['ERROR', 'WARNING', 'INFORMATION']),
  origin: z.enum(['SCHEMA', 'SCHEMATRON']),
  text: z.string().describe('The rule as the official rule set words it'),
  location: z
    .string()
    .nullable()
    .describe('XPath of the offending node; null for schema findings'),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  explanation: explanationOutput
    .nullable()
    .describe(
      'Plain-language meaning, cause and fix; every business rule has one, schema findings none',
    ),
})

const validationOutput = z.object({
  acceptable: z
    .boolean()
    .describe('The verdict: true when no ERROR-severity finding remains'),
  rulesetVersion: z
    .string()
    .describe('The KoSIT rule set release that produced the verdict'),
  scenario: z
    .string()
    .nullable()
    .describe('The rules that judged the document; null means nothing was checked'),
  schemaValid: z.boolean(),
  businessRulesEvaluated: z
    .boolean()
    .describe(
      'False when a schema failure stopped the run, so an empty list is not a pass',
    ),
  errors: z.number().int(),
  warnings: z.number().int(),
  findings: z.array(findingOutput),
})

const profile = z
  .enum(['xrechnung', 'en16931'])
  .describe(
    'xrechnung for public-sector buyers: it requires buyerReference (the Leitweg-ID), a seller contact and both electronic addresses. en16931 for businesses (§ 14 UStG accepts it), without those.',
  )

const generationOutput = z.object({
  syntax: z.enum(['ubl', 'cii', 'zugferd']),
  profile,
  fileName: z.string(),
  mimeType: z.string(),
  bytes: z.number().int(),
  rulesetVersion: z
    .string()
    .nullable()
    .describe('The rule set the document passed before it was returned'),
  scenario: z.string().nullable(),
  xml: z
    .string()
    .exactOptional()
    .describe(
      'The XML document; absent for the ZUGFeRD PDF, which is the attached resource',
    ),
})

const ruleOutput = z.object({
  code: z.string(),
  language: z.enum(['de', 'en']),
  meaning: z.string(),
  cause: z.string(),
  fix: z.string(),
  url: z.string(),
})

const INSTRUCTIONS = [
  'NormAPI checks and produces German e-invoices (XRechnung in UBL or CII, ZUGFeRD/Factur-X PDF) against the official KoSIT rule set, and states the rule set version with every result.',
  'validate_invoice needs no account. Its verdict is `acceptable`; every business-rule finding carries a plain-language explanation (meaning, cause, fix) — quote the fix rather than paraphrasing the rule text.',
  "generate_invoice turns invoice data into a document that passed validation before it was returned. It needs the user's NormAPI account and counts against their monthly allowance, so build the invoice from data the user gave you and do not retry blindly: a refusal names the rules the data breaks.",
  'Pick its profile by the recipient: xrechnung (the default) for a public-sector buyer, en16931 for a business, which then needs no Leitweg-ID, contact person or electronic addresses.',
  'explain_rule explains a rule code (e.g. BR-DE-15) the user already has.',
  'Invoices are processed in memory and never stored. This is technical validation, not tax or legal advice.',
].join('\n\n')

export function createNormapiServer(settings: ServerSettings): McpServer {
  const server = new McpServer(
    {
      name: 'normapi',
      title: 'NormAPI — German e-invoices',
      version: settings.version,
      description:
        'Validate and generate XRechnung and ZUGFeRD e-invoices against the official KoSIT rules, with a plain-language explanation for every business-rule finding.',
      websiteUrl: 'https://normapi.com/en/docs/mcp',
      icons: [
        {
          src: 'https://normapi.com/icon.png',
          mimeType: 'image/png',
          sizes: ['512x512'],
        },
      ],
    },
    { instructions: INSTRUCTIONS },
  )

  server.registerTool(
    'validate_invoice',
    {
      title: 'Validate an e-invoice',
      description:
        'Check an XRechnung (UBL or CII XML) or a ZUGFeRD/Factur-X PDF against the official KoSIT rules. Returns the verdict, the rule set version, and every finding; each business-rule finding comes with a plain-language meaning, cause and fix. Send the XML as text in `xml`, or the PDF base64-encoded in `pdfBase64` — exactly one. Free, no account needed, 5 MB at most.',
      inputSchema: z.object({
        xml: z
          .string()
          .max(MAX_DOCUMENT_BYTES)
          .exactOptional()
          .describe('The invoice XML as text'),
        pdfBase64: z
          .string()
          .max(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4)
          .exactOptional()
          .describe('A ZUGFeRD or Factur-X PDF, base64-encoded'),
        fileName: z
          .string()
          .max(200)
          .exactOptional()
          .describe('The file name, echoed into the report only'),
        language,
      }),
      outputSchema: validationOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ xml, pdfBase64, fileName, language }) => {
      const document = documentFrom(xml, pdfBase64)
      if (typeof document === 'string' && document.startsWith('refused:')) {
        return failure(document.slice('refused:'.length))
      }
      try {
        const result = await settings
          .client(language)
          .validate(document, fileName === undefined ? {} : { documentName: fileName })
        const output = validationView(result)
        return {
          content: [{ type: 'text', text: describeValidation(output) }],
          structuredContent: output,
        }
      } catch (error) {
        return failure(describeError(error, 'validate'))
      }
    },
  )

  server.registerTool(
    'generate_invoice',
    {
      title: 'Generate an e-invoice',
      description:
        "Produce an e-invoice as `ubl` or `cii` XML or a ZUGFeRD hybrid PDF (`zugferd`) from invoice data: an XRechnung for a public-sector buyer (profile `xrechnung`, the default), a plain EN 16931 invoice for a business (profile `en16931`). Totals are computed server-side in decimal arithmetic, and the document is validated against the official rules before it is returned. Data the rules do not permit is refused with the broken rules and how to fix each. Needs the user's NormAPI account; each document counts against the monthly allowance (50 free).",
      inputSchema: z.object({
        syntax: z
          .enum(['ubl', 'cii', 'zugferd'])
          .default('ubl')
          .describe(
            'ubl or cii for XML, zugferd for the PDF/A-3 with the invoice embedded',
          ),
        profile: profile.default('xrechnung'),
        invoice: invoiceSchema,
        language,
      }),
      outputSchema: generationOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...(settings.generateScopeChallenge === undefined
        ? {}
        : { scopeChallenge: settings.generateScopeChallenge }),
    },
    async ({ syntax, profile, invoice, language }) => {
      if (!settings.canGenerate) {
        return failure(settings.missingKeyAdvice)
      }
      const client = settings.client(language)
      const base = fileBase(invoice.invoiceNumber)
      try {
        if (syntax === 'zugferd') {
          const { pdf, rulesetVersion, scenario } = await client.generateInvoicePdf(
            invoice,
            { profile },
          )
          const output = {
            syntax,
            profile,
            fileName: `${base}.pdf`,
            mimeType: 'application/pdf',
            bytes: pdf.byteLength,
            rulesetVersion,
            scenario,
          }
          return {
            content: [
              { type: 'text', text: describeGeneration(output) },
              {
                type: 'resource',
                resource: {
                  uri: `normapi://invoices/${encodeURIComponent(output.fileName)}`,
                  mimeType: output.mimeType,
                  blob: base64Of(pdf),
                },
              },
            ],
            structuredContent: output,
          }
        }
        const { xml, rulesetVersion, scenario } = await client.generateInvoice(invoice, {
          syntax,
          profile,
        })
        const output = {
          syntax,
          profile,
          fileName: `${base}.xml`,
          mimeType: 'application/xml',
          bytes: new TextEncoder().encode(xml).byteLength,
          rulesetVersion,
          scenario,
          xml,
        }
        return {
          content: [
            { type: 'text', text: describeGeneration(output) },
            {
              type: 'resource',
              resource: {
                uri: `normapi://invoices/${encodeURIComponent(output.fileName)}`,
                mimeType: output.mimeType,
                text: xml,
              },
            },
          ],
          structuredContent: output,
        }
      } catch (error) {
        return failure(describeError(error, 'generate'))
      }
    },
  )

  server.registerTool(
    'explain_rule',
    {
      title: 'Explain an e-invoice rule',
      description:
        'Explain one EN 16931 / XRechnung / Peppol business rule by its code (e.g. BR-DE-15, BR-CO-10, PEPPOL-EN16931-R010): what it requires, why invoices typically break it, and how to fix it, with a link to the full page. Case does not matter. Schema findings (cvc-*) have no explanation.',
      inputSchema: z.object({
        code: z.string().min(2).max(60).describe('The rule code, e.g. BR-DE-15'),
        language,
      }),
      outputSchema: ruleOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ code, language }) => {
      try {
        const rule = await settings.client(language).explainRule(code)
        if (rule === null) {
          return failure(
            `No explained rule has the code ${code}. Codes look like BR-DE-15, BR-CO-10 or BR-S-08; schema findings (cvc-*) carry no explanation.`,
          )
        }
        const output = { code: rule.code, language: rule.language, ...rule.explanation }
        return {
          content: [{ type: 'text', text: describeRule(output) }],
          structuredContent: output,
        }
      } catch (error) {
        return failure(describeError(error, 'explain'))
      }
    },
  )

  return server
}

// ---------------------------------------------------------------------------
// Input and output shaping. Exported for the tests.
// ---------------------------------------------------------------------------

/** The bytes to validate, or a refusal prefixed `refused:` that the agent can act on. */
export function documentFrom(
  xml: string | undefined,
  pdfBase64: string | undefined,
): string | Uint8Array {
  if ((xml === undefined) === (pdfBase64 === undefined)) {
    return 'refused:Send exactly one of `xml` (the XML as text) or `pdfBase64` (a PDF, base64-encoded).'
  }
  if (xml !== undefined) {
    return xml
  }
  const compact = (pdfBase64 ?? '')
    .replace(/\s+/g, '')
    .replace(/^data:application\/pdf;base64,/, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return 'refused:`pdfBase64` is not base64. Encode the PDF file bytes as standard base64.'
  }
  const bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0))
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return `refused:The PDF is ${bytes.byteLength} bytes; the limit is ${MAX_DOCUMENT_BYTES}.`
  }
  // %PDF — anything else is refused by the API too, with a less specific word.
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    return 'refused:`pdfBase64` does not decode to a PDF. For an XML invoice, send it as text in `xml`.'
  }
  return bytes
}

type ValidationView = z.infer<typeof validationOutput>

export function validationView(result: ValidationResult): ValidationView {
  const findings = result.findings.map((finding: Finding) => ({
    code: finding.code,
    severity: finding.severity,
    origin: finding.origin,
    text: finding.text,
    location: finding.location,
    line: finding.line,
    column: finding.column,
    explanation: finding.explanation,
  }))
  return {
    acceptable: result.acceptable,
    rulesetVersion: result.rulesetVersion,
    scenario: result.scenario,
    schemaValid: result.schemaValid,
    businessRulesEvaluated: result.businessRulesEvaluated,
    errors: findings.filter((finding) => finding.severity === 'ERROR').length,
    warnings: findings.filter((finding) => finding.severity === 'WARNING').length,
    findings,
  }
}

/**
 * The verdict as text, for the clients that hand the model only the text
 * block. Everything an agent needs to fix the invoice is in it: each finding's
 * rule, where it fired, and the explanation's cause and fix.
 */
export function describeValidation(view: ValidationView): string {
  const lines: string[] = []
  if (view.scenario === null) {
    lines.push(
      'NOT CHECKED: no rule scenario matched this document, so no rules ran. It is not an XRechnung or EN 16931 invoice the rule set recognises.',
    )
  } else if (view.acceptable) {
    lines.push(`ACCEPTABLE — the invoice passes the rules (${view.scenario}).`)
  } else {
    lines.push(`NOT ACCEPTABLE — ${view.errors} error(s) (${view.scenario}).`)
  }
  lines.push(`Rule set: ${view.rulesetVersion}. Warnings: ${view.warnings}.`)
  if (!view.businessRulesEvaluated) {
    lines.push(
      'The document failed the XML schema, so the business rules did not run: fix the schema errors first, then validate again.',
    )
  }
  for (const finding of view.findings) {
    lines.push('', `${finding.severity} ${finding.code}: ${finding.text}`)
    if (finding.location !== null) {
      lines.push(`  at ${finding.location}`)
    } else if (finding.line !== null) {
      lines.push(
        `  at line ${finding.line}${finding.column === null ? '' : `, column ${finding.column}`}`,
      )
    }
    if (finding.explanation !== null) {
      lines.push(
        `  Meaning: ${finding.explanation.meaning}`,
        `  Cause: ${finding.explanation.cause}`,
        `  Fix: ${finding.explanation.fix}`,
        `  More: ${finding.explanation.url}`,
      )
    }
  }
  return lines.join('\n')
}

type GenerationView = z.infer<typeof generationOutput>

function describeGeneration(view: GenerationView): string {
  const rules = view.profile === 'xrechnung' ? 'XRechnung' : 'EN 16931'
  const kind =
    view.syntax === 'zugferd'
      ? `ZUGFeRD PDF (${rules})`
      : `${rules} (${view.syntax.toUpperCase()})`
  return [
    `Generated ${kind} ${view.fileName}, ${view.bytes} bytes. It passed ${view.scenario ?? 'the rules'} under rule set ${view.rulesetVersion ?? 'unknown'} before it was returned.`,
    view.syntax === 'zugferd'
      ? 'The PDF is attached as a resource.'
      : 'The XML is attached as a resource and in the structured result.',
  ].join(' ')
}

function describeRule(rule: z.infer<typeof ruleOutput>): string {
  return [
    rule.code,
    `Meaning: ${rule.meaning}`,
    `Cause: ${rule.cause}`,
    `Fix: ${rule.fix}`,
    `More: ${rule.url}`,
  ].join('\n')
}

/** What went wrong, worded for an agent that has to decide what to do next. */
export function describeError(
  error: unknown,
  action: 'validate' | 'generate' | 'explain',
): string {
  if (error instanceof InvoiceNotPermittedError) {
    const view = validationView({
      acceptable: false,
      wellFormed: true,
      schemaValid: true,
      schematronValid: false,
      businessRulesEvaluated: true,
      rulesetVersion: error.rulesetVersion,
      scenario: 'the generated document',
      findings: error.findings,
    })
    return [
      'NOT GENERATED — the rule set does not permit an invoice with this data, so nothing was produced and nothing was counted. Change the data as the fixes say, then generate again.',
      describeValidation(view).split('\n').slice(2).join('\n'),
    ].join('\n')
  }
  if (error instanceof RateLimitError) {
    return `Rate limit reached. Wait ${error.retryAfterSeconds} seconds before the next call.`
  }
  if (error instanceof ValidatorBusyError) {
    return `Every validation slot is busy. Retry in ${error.retryAfterSeconds} seconds.`
  }
  if (error instanceof NormapiError) {
    switch (error.status) {
      case 401:
      case 403:
        return 'NormAPI refused the key: it is unknown or was revoked. Reconnect NormAPI, or create a new key at https://normapi.com/en/account/keys.'
      case 402:
        return "This month's generation allowance is used up, so no invoice was generated. Validation still works. The allowance renews with the month; a larger plan is at https://normapi.com/en/account/plan."
      case 413:
        return 'The document is over the 5 MB limit.'
      default:
        return error.detail !== ''
          ? `NormAPI could not ${action === 'explain' ? 'look up the rule' : `${action} this invoice`}: ${error.detail}`
          : `NormAPI answered ${error.status}.`
    }
  }
  return 'NormAPI could not be reached. Try again in a moment.'
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** A file name from the invoice number: what the user will save it as. */
function fileBase(invoiceNumber: string): string {
  const safe = invoiceNumber
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return safe === '' ? 'invoice' : safe
}

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
