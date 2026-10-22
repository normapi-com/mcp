# @normapi/mcp

[![NormAPI MCP connector](https://glama.ai/mcp/connectors/com.normapi/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/com.normapi/mcp)

MCP server for German e-invoices. Validate and generate **XRechnung** (UBL, CII) and
**ZUGFeRD / Factur-X** against the official KoSIT rules from Claude, Cursor, VS Code or
any MCP client. Every business-rule finding carries a plain-language explanation: what
the rule requires, why it typically fires, and how to fix it.

The same server runs hosted at **https://normapi.com/mcp** (Streamable HTTP, OAuth or
API key). This package serves it over stdio, for clients that start servers as a local
process.

## Use

```json
{
  "mcpServers": {
    "normapi": {
      "command": "npx",
      "args": ["-y", "@normapi/mcp"],
      "env": { "NORMAPI_API_KEY": "nk_live_…" }
    }
  }
}
```

`NORMAPI_API_KEY` is needed only to generate invoices. Create a key for free at
<https://normapi.com/en/account/keys>; 50 generated invoices a month are included.

## Tools

| Tool | What it does | Key |
|---|---|---|
| `validate_invoice` | Checks XRechnung XML (text) or a ZUGFeRD PDF (base64): verdict, rule set version, every finding with its explanation | no |
| `generate_invoice` | Builds XRechnung UBL/CII or a ZUGFeRD PDF from invoice data, validated before it is returned; `profile: "en16931"` makes an EN 16931 invoice for a business, without Leitweg-ID, contact person and electronic addresses | yes |
| `explain_rule` | Explains a rule code such as BR-DE-15 | no |

Invoices are processed in memory and never stored. Technical validation, not tax or
legal advice. Documentation: <https://normapi.com/en/docs/mcp>.

## Source

<https://github.com/normapi-com/mcp> carries the source of each released version:
`src/server.ts` defines the three tools, `src/stdio.ts` serves them over stdio. The tools
are developed together with the hosted endpoint, so both always offer the same set.
Issues and pull requests are welcome there.

```sh
pnpm install
pnpm test    # builds dist/stdio.js, then runs the stdio and tool tests
```

## License

MIT
