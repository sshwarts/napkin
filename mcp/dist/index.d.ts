/**
 * @file Napkin MCP server entry point.
 *
 * Starts two services:
 *   1. WebSocket server for real-time browser canvas sync
 *   2. MCP server for agent tool access (stdio or HTTP transport)
 *
 * Transport selection via NAPKIN_TRANSPORT env var:
 *   - "http" → HTTP server on NAPKIN_MCP_PORT (default 3003)
 *   - default → stdio (stdin/stdout JSON-RPC)
 */
export {};
//# sourceMappingURL=index.d.ts.map