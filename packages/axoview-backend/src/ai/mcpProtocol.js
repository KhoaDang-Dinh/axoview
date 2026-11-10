/**
 * MCP over Streamable HTTP, stateless JSON responses, shared by Axoview's two
 * MCP servers: the public manual (mcp.js) and the workspace server
 * (workspaceMcp.js, behind OAuth).
 *
 * Dual-era (MCP 2026-07-28 "Versioning and Compatibility"):
 * - modern requests carry their version in params._meta and the
 *   MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, are served
 *   statelessly, and must match header to body;
 * - legacy clients (2025-11-25 and earlier) open with `initialize`; they get
 *   the same tools, and no session id is minted (sessions are optional there).
 */
export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BODY_BYTES = 32_000;
const META = 'io.modelcontextprotocol/';

export class RpcError extends Error {
  constructor(httpStatus, code, message, data) {
    super(message);
    Object.assign(this, { httpStatus, code, data });
  }
}

/**
 * An HTTP-level refusal before any JSON-RPC (401 or 403 with a
 * WWW-Authenticate challenge, MCP authorization).
 */
export class AuthChallenge extends Error {
  constructor(status, challenge, message) {
    super(message);
    Object.assign(this, { status, challenge });
  }
}

/** Mcp-Name and Mcp-Param-* values may be `=?base64?...?=` encoded. */
export function decodeHeaderValue(value) {
  if (typeof value !== 'string') return value;
  const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : value;
}

/**
 * An Express handler for one MCP endpoint.
 * @param {object} o
 * @param {object} o.serverInfo
 * @param {string} o.instructions
 * @param {object[]} o.tools
 * @param {(params: object, auth: object|null) => Promise<object>} o.callTool
 * @param {'public'|'private'} o.cacheScope  how clients may cache discovery and tools/list
 * @param {(req) => Promise<object|null>} [o.authenticate]  throws AuthChallenge to refuse
 * @param {(fields: object) => void} o.telemetry
 */
export function createMcpEndpoint({ serverInfo, instructions, tools, callTool, cacheScope, authenticate, telemetry, log = console }) {
  async function dispatch(method, params, { modern, version }, auth) {
    const complete = (result) => (modern
      ? { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: serverInfo } }
      : result);
    switch (method) {
      case 'server/discover':
        if (!modern) break;
        return complete({
          supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          instructions,
          ttlMs: 3_600_000,
          cacheScope
        });
      case 'initialize': {
        if (modern) break;
        const requested = params?.protocolVersion;
        return {
          protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions
        };
      }
      case 'ping':
        return complete({});
      case 'tools/list':
        return complete({
          tools: tools.map((tool) => (modern || version !== '2025-03-26'
            ? tool
            : (({ outputSchema, ...rest }) => rest)(tool))),   // outputSchema arrived in 2025-06-18
          ...(modern ? { ttlMs: 3_600_000, cacheScope } : {})
        });
      case 'tools/call':
        return complete(await callTool(params, auth));
      default:
        break;
    }
    throw new RpcError(modern ? 404 : 200, -32601, `Method not found: ${String(method).slice(0, 64)}`);
  }

  // 2026-07-28 has no GET stream and no sessions (DELETE).
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Use POST' } });
    }
    const started = Date.now();
    let auth = null;
    if (authenticate) {
      try {
        auth = await authenticate(req);
      } catch (error) {
        if (!(error instanceof AuthChallenge)) {
          log.error?.('[mcp] authentication failed: %s', error?.name || 'unknown');
          return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } });
        }
        telemetry({ method: req.body?.method, result: 'rejected', code: error.status, era: 'unknown', latencyMs: Date.now() - started });
        res.setHeader('WWW-Authenticate', error.challenge);
        return res.status(error.status).json({ error: error.status === 401 ? 'invalid_token' : 'insufficient_scope', error_description: error.message });
      }
    }
    const message = req.body;
    const reply = (status, payload) => res.status(status).type('application/json').send(JSON.stringify({ jsonrpc: '2.0', ...payload }));
    let id = null;
    let method;
    let modern = false;
    try {
      if (!req.is('application/json')) throw new RpcError(415, -32700, 'Content-Type must be application/json');
      if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES || JSON.stringify(message ?? null).length > MAX_BODY_BYTES) {
        throw new RpcError(413, -32600, 'Request too large');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message) ||
          message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        throw new RpcError(400, -32600, 'Invalid JSON-RPC request');
      }
      if (message.id === undefined) return res.status(202).end();     // notifications (e.g. legacy initialized)
      if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new RpcError(400, -32600, 'Invalid id');
      id = message.id;

      const params = message.params ?? {};
      const meta = params && typeof params === 'object' ? params._meta : undefined;
      const metaVersion = meta && typeof meta === 'object' ? meta[`${META}protocolVersion`] : undefined;
      const headerVersion = req.get('MCP-Protocol-Version');
      method = message.method;
      modern = metaVersion !== undefined && message.method !== 'initialize';

      if (modern) {
        if (typeof headerVersion !== 'string' || headerVersion !== metaVersion) {
          throw new RpcError(400, -32020, 'Header mismatch: MCP-Protocol-Version must match _meta protocolVersion');
        }
        if (!MODERN_VERSIONS.includes(metaVersion)) {
          throw new RpcError(400, -32022, 'Unsupported protocol version',
            { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: String(metaVersion).slice(0, 32) });
        }
        if (req.get('Mcp-Method') !== message.method) {
          throw new RpcError(400, -32020, 'Header mismatch: Mcp-Method must match the request method');
        }
        if (message.method === 'tools/call' && decodeHeaderValue(req.get('Mcp-Name')) !== params?.name) {
          throw new RpcError(400, -32020, 'Header mismatch: Mcp-Name must match params.name');
        }
        const capabilities = meta[`${META}clientCapabilities`];
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
          throw new RpcError(400, -32602, 'Missing _meta io.modelcontextprotocol/clientCapabilities');
        }
      } else if (headerVersion !== undefined && !LEGACY_VERSIONS.includes(headerVersion)) {
        throw new RpcError(400, -32022, 'Unsupported protocol version',
          { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: String(headerVersion).slice(0, 32) });
      }

      const version = modern ? metaVersion : (headerVersion || params?.protocolVersion || LEGACY_VERSIONS[0]);
      const result = await dispatch(message.method, params, { modern, version }, auth);
      // Never the query text: method, tool, result count and timing only.
      const results = result?.structuredContent?.results?.length ?? (result?.isError ? -1 : 1);
      telemetry({
        method, result: 'ok', era: modern ? 'modern' : 'legacy', latencyMs: Date.now() - started,
        ...(method === 'tools/call' ? {
          tool: params?.name, results, mode: result?.structuredContent?.mode,
          outcome: result?.isError ? 'invalid' : results === 0 ? 'empty' : 'hit'
        } : {})
      });
      return reply(200, { id, result });
    } catch (error) {
      if (error instanceof AuthChallenge) {
        telemetry({ method, result: 'rejected', code: error.status, era: modern ? 'modern' : 'legacy', latencyMs: Date.now() - started });
        res.setHeader('WWW-Authenticate', error.challenge);
        return reply(error.status, { ...(id !== null ? { id } : {}), error: { code: -32001, message: error.message } });
      }
      const rpc = error instanceof RpcError;
      // Unknown methods answer 200 to legacy clients; still a client mistake.
      telemetry({
        method, result: rpc ? (error.httpStatus >= 500 ? 'error' : 'rejected') : 'error',
        code: rpc ? error.code : -32603, era: modern ? 'modern' : 'legacy', latencyMs: Date.now() - started
      });
      if (rpc) {
        return reply(error.httpStatus, { ...(id !== null ? { id } : {}), error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } });
      }
      log.error?.('[mcp] request failed: %s', error?.name || 'unknown');
      return reply(500, { ...(id !== null ? { id } : {}), error: { code: -32603, message: 'Internal error' } });
    }
  };
}
