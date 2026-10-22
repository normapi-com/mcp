import { z } from 'zod'

// Relative imports only, and none from the app: the stdio package in
// packages/mcp bundles this directory as it is.

/**
 * The body of POST /v1/invoices, as an agent fills it in.
 *
 * Mirrors the backend's InvoiceRequest record field for field, with its size
 * and pattern constraints, because the description is all an agent reads
 * before it writes the JSON: a field missing here is a field no agent will
 * ever send. invoice-schema.test.ts compares the names against the record.
 * Whether a combination is permitted stays the rule set's verdict — those
 * come back as findings, not as schema errors.
 */

const date = z.iso.date().describe('YYYY-MM-DD')

/** Strings are accepted beside numbers so an amount never has to pass through a float. */
const decimal = (description: string) =>
  z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).describe(description)

const vatCategory = z
  .enum(['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M'])
  .describe(
    'UNTDID 5305: S standard, Z zero-rated, E exempt, AE reverse charge, K intra-community supply, G export, O outside scope, L Canary Islands, M Ceuta/Melilla',
  )

const address = z
  .object({
    street: z.string().max(200).exactOptional().describe('BT-35 / BT-50 / BT-75'),
    city: z
      .string()
      .min(1)
      .max(100)
      .describe('BT-37 / BT-52 / BT-77, mandatory (BR-DE-3, BR-DE-8, BR-DE-10)'),
    postcode: z
      .string()
      .min(1)
      .max(20)
      .describe('BT-38 / BT-53 / BT-78, mandatory (BR-DE-4, BR-DE-9, BR-DE-11)'),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .describe('BT-40 / BT-55 / BT-80, ISO 3166-1 alpha-2, e.g. DE'),
  })
  .describe('BG-5 / BG-8 / BG-15')

const deliverTo = z
  .object({
    name: z
      .string()
      .max(200)
      .exactOptional()
      .describe('BT-70, who received the goods: a branch, a warehouse, a site'),
    locationId: z
      .string()
      .max(100)
      .exactOptional()
      .describe('BT-71, an identifier of the place, e.g. its GLN'),
    locationIdScheme: z
      .string()
      .regex(/^[0-9]{4}$/)
      .exactOptional()
      .describe(
        "BT-71-1, ISO 6523 ICD of locationId: 0088 for a GLN; absent means the seller's own",
      ),
    address: address.exactOptional().describe('BG-15, the delivery address'),
  })
  .describe(
    'BG-13: where the supply went, when not simply to the buyer. Required for VAT category K: the country the goods went to (BR-IC-12).',
  )

const period = z
  .object({
    startDate: date.exactOptional().describe('BT-73 / BT-134, YYYY-MM-DD'),
    endDate: date.exactOptional().describe('BT-74 / BT-135, YYYY-MM-DD'),
  })
  .describe(
    'A period: either end may stand alone (BR-CO-19, BR-CO-20); the end not before the start (BR-29, BR-30)',
  )

const contact = z
  .object({
    name: z.string().min(1).max(200).describe('BT-41'),
    phone: z.string().min(1).max(50).describe('BT-42'),
    email: z.string().min(1).max(254).describe('BT-43'),
  })
  .describe('BG-6. XRechnung requires all three on the seller (BR-DE-2, BR-DE-5 to 7).')

const party = z.object({
  name: z.string().min(1).max(200).describe('BT-27 / BT-44, the legal name'),
  identifier: z
    .string()
    .max(100)
    .exactOptional()
    .describe(
      'BT-29 / BT-46. A seller without a VAT id repeats its tax number here: BT-32 alone satisfies BR-DE-16 but not BR-CO-26.',
    ),
  vatId: z.string().max(30).exactOptional().describe('BT-31 / BT-48, e.g. DE123456789'),
  taxNumber: z
    .string()
    .max(30)
    .exactOptional()
    .describe('BT-32, the German Steuernummer'),
  electronicAddress: z
    .string()
    .max(254)
    .exactOptional()
    .describe('BT-34 / BT-49, an email address unless a scheme says otherwise'),
  electronicAddressScheme: z
    .string()
    .regex(/^[0-9A-Z]{2,10}$/)
    .exactOptional()
    .describe('EAS code for the electronic address; EM (email) when absent'),
  address,
  contact: contact.exactOptional(),
})

const card = z
  .object({
    number: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[^0-9]*([0-9][^0-9]*){0,10}$/)
      .describe(
        'BT-87, masked: at most the first 6 and the last 4 digits, never the full number. Send digits without mask characters.',
      ),
    holder: z.string().max(200).exactOptional().describe('BT-88'),
    network: z
      .string()
      .max(50)
      .exactOptional()
      .describe('VISA, MasterCard …; UBL writes NA when absent'),
  })
  .describe('BG-18, with payment means 48, 54 or 55')

const directDebit = z
  .object({
    mandateReference: z.string().max(35).exactOptional().describe('BT-89'),
    creditorId: z
      .string()
      .max(35)
      .exactOptional()
      .describe('BT-90, the SEPA creditor identifier'),
    debitedAccount: z
      .string()
      .max(34)
      .exactOptional()
      .describe('BT-91, the buyer IBAN debited'),
  })
  .describe('BG-19, with payment means 59. Leave out the payee IBAN (BR-DE-25-b).')

const payment = z
  .object({
    meansCode: z
      .string()
      .regex(/^([0-9]{1,3}|ZZZ)$/)
      .describe(
        'BT-81, UNTDID 4461: 58 SEPA credit transfer, 30 credit transfer, 59 SEPA direct debit, 48/54/55 card, 10 cash, ZZZ mutually defined',
      ),
    iban: z
      .string()
      .max(34)
      .exactOptional()
      .describe('BT-84, the payee account; required for transfers (BR-DE-23-a)'),
    reference: z
      .string()
      .max(140)
      .exactOptional()
      .describe('BT-83, what the payer should quote'),
    meansText: z
      .string()
      .max(200)
      .exactOptional()
      .describe('BT-82, the payment means in words'),
    accountName: z
      .string()
      .max(200)
      .exactOptional()
      .describe('BT-85, the payee account holder'),
    bic: z
      .string()
      .regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/)
      .exactOptional()
      .describe('BT-86, the payee bank'),
    card: card.exactOptional(),
    directDebit: directDebit.exactOptional(),
  })
  .describe(
    'BG-16 and the group its code calls for: BG-17 transfer, BG-18 card, BG-19 direct debit',
  )

const adjustment = {
  amount: decimal('Two decimals. Give amount or percent, exactly one.').exactOptional(),
  percent: decimal('Give amount or percent, exactly one.').exactOptional(),
  baseAmount: decimal(
    'What the percentage is taken of. Only with percent (PEPPOL-EN16931-R042).',
  ).exactOptional(),
  reason: z.string().max(500).exactOptional().describe('This or reasonCode is required'),
  reasonCode: z
    .string()
    .regex(/^[0-9A-Z]{1,3}$/)
    .exactOptional()
    .describe(
      'UNTDID 5189 for an allowance (95 discount), UNTDID 7161 for a charge (FC freight)',
    ),
}

const allowanceCharge = z
  .object({
    ...adjustment,
    vatCategory,
    vatRate: decimal('Percent').exactOptional(),
    vatExemptionReason: z
      .string()
      .max(500)
      .exactOptional()
      .describe('BT-120, as on a line'),
  })
  .describe('A document-level allowance (BG-20) or charge (BG-21)')

const lineAllowanceCharge = z
  .object(adjustment)
  .describe(
    'A line allowance (BG-27) or charge (BG-28); it changes the line net, in the line VAT category',
  )

const line = z.object({
  id: z.string().max(50).exactOptional().describe('BT-126; assigned 1..n when absent'),
  name: z.string().min(1).max(200).describe('BT-153'),
  description: z.string().max(1000).exactOptional().describe('BT-154'),
  quantity: decimal('BT-129, up to six decimals'),
  unit: z
    .string()
    .regex(/^[0-9A-Z]{1,8}$/)
    .describe('BT-130, UN/ECE Rec 20: C62 piece, HUR hour, DAY day, KGM kilogram …'),
  unitPrice: decimal('BT-146, net, up to four decimals'),
  vatCategory,
  vatRate: decimal('BT-152, percent; required for category S').exactOptional(),
  vatExemptionReason: z
    .string()
    .max(500)
    .exactOptional()
    .describe('BT-120; the rule set wants it for the exempt-family categories'),
  allowances: z.array(lineAllowanceCharge).max(20).exactOptional(),
  charges: z.array(lineAllowanceCharge).max(20).exactOptional(),
  period: period.exactOptional().describe('BG-26, the period this line covers'),
  orderLineReference: z
    .string()
    .max(50)
    .exactOptional()
    .describe("BT-132, the line of the buyer's purchase order this one bills"),
})

export const invoiceSchema = z.object({
  invoiceNumber: z.string().min(1).max(100).describe('BT-1'),
  issueDate: date.describe('BT-2, YYYY-MM-DD'),
  typeCode: z
    .string()
    .regex(/^[0-9]{3}$/)
    .exactOptional()
    .describe(
      'BT-3, UNTDID 1001; 380 when absent. 381 credit note, 384 corrected invoice, 326 partial, 389 self-billed, 875/876/877 construction invoices.',
    ),
  precedingInvoices: z
    .array(
      z.object({
        number: z.string().min(1).max(100).describe('BT-25'),
        issueDate: date.exactOptional().describe('BT-26'),
      }),
    )
    .max(50)
    .exactOptional()
    .describe(
      'BG-3, the invoices this one corrects, credits or settles. CII and ZUGFeRD carry one.',
    ),
  dueDate: date
    .exactOptional()
    .describe('BT-9. XRechnung wants this or paymentTerms on a payable invoice.'),
  deliveryDate: date
    .exactOptional()
    .describe('BT-72. Omitting it and invoicePeriod draws an advisory.'),
  deliverTo: deliverTo.exactOptional(),
  invoicePeriod: period
    .exactOptional()
    .describe(
      'BG-14, the period a monthly or yearly invoice covers, instead of deliveryDate or beside it',
    ),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe('BT-5, ISO 4217, e.g. EUR'),
  buyerReference: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'BT-10, mandatory in XRechnung (BR-DE-15): the Leitweg-ID for public-sector buyers, else the buyer reference',
    ),
  orderReference: z
    .string()
    .max(100)
    .exactOptional()
    .describe("BT-13, the buyer's purchase order number"),
  contractReference: z.string().max(100).exactOptional().describe('BT-12'),
  projectReference: z.string().max(100).exactOptional().describe('BT-11'),
  despatchAdviceReference: z
    .string()
    .max(100)
    .exactOptional()
    .describe('BT-16, the delivery note (Lieferschein) number'),
  note: z.string().max(1000).exactOptional().describe('BT-22'),
  seller: party.describe(
    'BG-4. Needs a VAT id or tax number (BR-DE-16) and a contact (BR-DE-2).',
  ),
  buyer: party.describe('BG-7'),
  payment,
  paymentTerms: z.string().max(1000).exactOptional().describe('BT-20'),
  allowances: z.array(allowanceCharge).max(100).exactOptional().describe('BG-20'),
  charges: z
    .array(allowanceCharge)
    .max(100)
    .exactOptional()
    .describe('BG-21: freight, packaging …'),
  prepaidAmount: decimal(
    'BT-113, already paid; the amount due is the total less this',
  ).exactOptional(),
  lines: z
    .array(line)
    .min(1)
    .max(500)
    .describe('BG-25. Totals are computed server-side in decimal arithmetic.'),
})

export type InvoiceData = z.infer<typeof invoiceSchema>
