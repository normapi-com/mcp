import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parsedInvoiceSchema } from '../src/api'
import { invoiceSchema } from '../src/invoice-schema'

/**
 * The parse response's invoice against the invoice generate_invoice takes.
 * They are one shape — /v1/parse answers in the request of /v1/invoices — read
 * two ways: every field nullable and present on the one side, optional on the
 * other. invoice-schema.test.ts holds the generation schema to the backend's
 * record; this holds the parse schema to it, so a field the backend gains has
 * to reach both, or an agent is shown a field it can read and not send back.
 */

/** Every object in the schema, by path, with its field names. */
function objects(schema: z.core.$ZodType, path = ''): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const visit = (node: z.core.$ZodType, at: string): void => {
    if (
      node instanceof z.ZodOptional ||
      node instanceof z.ZodExactOptional ||
      node instanceof z.ZodNullable
    ) {
      visit(node.unwrap(), at)
    } else if (node instanceof z.ZodDefault) {
      visit(node.unwrap(), at)
    } else if (node instanceof z.ZodArray) {
      visit(node.element, `${at}[]`)
    } else if (node instanceof z.ZodObject) {
      const shape: Record<string, z.core.$ZodType> = node.shape
      found.set(at, Object.keys(shape).sort())
      for (const [name, child] of Object.entries(shape)) {
        visit(child, `${at}.${name}`)
      }
    }
  }
  visit(schema, path)
  return found
}

describe('the parsed invoice against the invoice generate_invoice takes', () => {
  it('reads nested objects at all', () => {
    expect(objects(invoiceSchema).get('.seller.address')).toContain('postcode')
  })

  it('has the same objects with the same fields', () => {
    expect(Object.fromEntries(objects(parsedInvoiceSchema))).toEqual(
      Object.fromEntries(objects(invoiceSchema)),
    )
  })
})
