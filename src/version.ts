/**
 * The server's version, as MCP clients and the registry's server.json show
 * it. One number for both transports: the hosted endpoint and the npm package
 * serve the same tools. packages/mcp/package.json must carry the same value;
 * a test there says so.
 */
export const MCP_SERVER_VERSION = '1.0.2'
