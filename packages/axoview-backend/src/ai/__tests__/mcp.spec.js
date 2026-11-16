/**
 * The public manual MCP endpoint through a real Express app: the 2026-07-28
 * per-request metadata and header checks, the legacy initialize path, the two
 * tools, and the daily budget for paid searches.
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import http from 'node:http';
import express from 'express';
import { createMcpRouter, decodeHeaderValue } from '../mcp.js';

const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

async function serve(options = {}) {
  const logs = [];
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', createMcpRouter({
    enabled: true,
    publicBaseUrl: 'https://axoview.example',
    hybridSearch: options.hybridSearch || (async (query, { limit }) => ({
      mode: 'hybrid',
      items: [{ id: 'connectors-connecting-two-items', title: 'Connectors › Connecting two items', text: 'Press C…', source: 'docs/manual/connectors.md#connecting-two-items' }].slice(0, limit)
    })),
    log: { info: (line) => logs.push(line), error: () => {} },
    ...options
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  return { url, logs };
}

const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
async function modern(url, method, params = {}, headers = {}) {
  const body = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: modernMeta } };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
const legacy = async (url, method, params = {}, headers = {}) => {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: 'a' }), method, params })
  });
  return { status: response.status, body: response.status === 202 ? null : await response.json() };
};

describe('modern clients (2026-07-28)', () => {
  test('server/discover names versions, the tools capability and the server', async () => {
    const { url } = await serve();
    const { status, body } = await modern(url, 'server/discover');
    expect(status).toBe(200);
    expect(body.result).toMatchObject({
      resultType: 'complete', supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      capabilities: { tools: { listChanged: false } }, cacheScope: 'public'
    });
    expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('axoview-docs');
  });

  test('tools/list: two read-only tools', async () => {
    const { url } = await serve();
    const { body } = await modern(url, 'tools/list');
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['search_manual', 'get_manual_section']);
    expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint)).toBe(true);
  });

  test('search_manual returns sections with public links, as text and structured content', async () => {
    const { url, logs } = await serve();
    const { body } = await modern(url, 'tools/call', { name: 'search_manual', arguments: { query: 'how do I draw an arrow between servers', limit: 2 } });
    expect(body.result.resultType).toBe('complete');
    expect(body.result.structuredContent).toEqual({
      mode: 'hybrid',
      results: [{ id: 'connectors-connecting-two-items', title: 'Connectors › Connecting two items',
        url: 'https://axoview.example/docs/manual/connectors.md#connecting-two-items', text: 'Press C…' }]
    });
    expect(body.result.content[0].text).toContain('https://axoview.example/docs/manual/connectors.md');
    // The log line never carries the query.
    expect(logs.join('\n')).not.toContain('arrow');
    expect(JSON.parse(logs.at(-1))).toMatchObject({ event: 'mcp.request', method: 'tools/call', result: 'ok',
      tool: 'search_manual', outcome: 'hit', results: 1, mode: 'hybrid', era: 'modern' });
  });

  test('get_manual_section reads one section; an unknown id is a tool error the model can recover from', async () => {
    const { url, logs } = await serve();
    const ok = await modern(url, 'tools/call', { name: 'get_manual_section', arguments: { id: 'canvas-zooming' } });
    expect(ok.body.result.structuredContent).toMatchObject({ id: 'canvas-zooming', url: 'https://axoview.example/docs/manual/canvas.md#zooming' });
    const missing = await modern(url, 'tools/call', { name: 'get_manual_section', arguments: { id: 'no-such-section' } });
    expect(missing.body.result).toMatchObject({ isError: true });
    expect(JSON.parse(logs.at(-1))).toMatchObject({ result: 'ok', tool: 'get_manual_section', outcome: 'invalid' });
    const bad = await modern(url, 'tools/call', { name: 'search_manual', arguments: { query: 'x', limit: 99 } });
    expect(bad.body.result.isError).toBe(true);
  });

  test('headers must match the body', async () => {
    const { url } = await serve();
    const version = await modern(url, 'tools/list', {}, { 'mcp-protocol-version': '2025-11-25' });
    expect([version.status, version.body.error.code]).toEqual([400, -32020]);
    const method = await modern(url, 'tools/list', {}, { 'mcp-method': 'tools/call' });
    expect([method.status, method.body.error.code]).toEqual([400, -32020]);
    const name = await modern(url, 'tools/call', { name: 'search_manual', arguments: { query: 'zoom' } }, { 'mcp-name': 'get_manual_section' });
    expect([name.status, name.body.error.code]).toEqual([400, -32020]);
    const encoded = await modern(url, 'tools/call', { name: 'search_manual', arguments: { query: 'zoom' } },
      { 'mcp-name': `=?base64?${Buffer.from('search_manual').toString('base64')}?=` });
    expect(encoded.status).toBe(200);
  });

  test('an unsupported version and missing capabilities are rejected as the spec says', async () => {
    const { url } = await serve();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } })
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32022, message: 'Unsupported protocol version',
      data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'], requested: '2099-01-01' } } });

    const noCaps = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } })
    });
    expect([noCaps.status, (await noCaps.json()).error.code]).toEqual([400, -32602]);
  });

  test('unknown methods are 404 -32601; GET and DELETE are 405', async () => {
    const { url } = await serve();
    const unknown = await modern(url, 'resources/list');
    expect([unknown.status, unknown.body.error.code]).toEqual([404, -32601]);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('telemetry: one mcp.request line per request, errors included', () => {
  test('a client mistake is logged as rejected, with its code; a caller-chosen method name is not echoed', async () => {
    const { url, logs } = await serve();
    await modern(url, 'resources/list');
    await modern(url, 'tools/list', {}, { 'mcp-method': 'tools/call' });
    const lines = logs.map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ event: 'mcp.request', method: 'other', result: 'rejected', code: -32601 }),
      expect.objectContaining({ event: 'mcp.request', method: 'tools/list', result: 'rejected', code: -32020 })
    ]);
    expect(logs.join('\n')).not.toContain('resources/list');
  });

  test('a search with no results is an empty outcome; a failing search is an error', async () => {
    const empty = await serve({ hybridSearch: async () => ({ mode: 'hybrid', items: [] }) });
    await modern(empty.url, 'tools/call', { name: 'search_manual', arguments: { query: 'zzz' } });
    expect(JSON.parse(empty.logs.at(-1))).toMatchObject({ result: 'ok', outcome: 'empty', results: 0 });

    const failing = await serve({ hybridSearch: async () => { throw new Error('vectors down'); } });
    const response = await modern(failing.url, 'tools/call', { name: 'search_manual', arguments: { query: 'zoom' } });
    expect(response.status).toBe(500);
    expect(JSON.parse(failing.logs.at(-1))).toMatchObject({ method: 'tools/call', result: 'error', code: -32603 });
  });
});

describe('legacy clients (initialize handshake)', () => {
  test('initialize negotiates a legacy version, then the tools work without the new headers', async () => {
    const { url } = await serve();
    const init = await legacy(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'axoview-docs' } });
    expect((await legacy(url, 'notifications/initialized')).status).toBe(202);
    const call = await legacy(url, 'tools/call', { name: 'search_manual', arguments: { query: 'connect' } }, { 'mcp-protocol-version': '2025-06-18' });
    expect(call.body.result.structuredContent.results).toHaveLength(1);
    const unknownVersion = await legacy(url, 'initialize', { protocolVersion: '2024-11-05' });
    expect(unknownVersion.body.result.protocolVersion).toBe('2025-11-25');
  });
});

describe('cost and switches', () => {
  test('after the daily vector budget, searches are keyword-only', async () => {
    const hybridSearch = jest.fn(async () => ({ mode: 'hybrid', items: [] }));
    const { url } = await serve({ hybridSearch, dailyVectorLimit: 2 });
    const modes = [];
    for (let i = 0; i < 4; i++) {
      modes.push((await modern(url, 'tools/call', { name: 'search_manual', arguments: { query: 'export a png' } })).body.result.structuredContent.mode);
    }
    expect(modes).toEqual(['hybrid', 'hybrid', 'keyword', 'keyword']);
    expect(hybridSearch).toHaveBeenCalledTimes(2);
  });

  test('disabled, the endpoint is a 404', async () => {
    const { url } = await serve({ enabled: false });
    expect((await modern(url, 'server/discover')).status).toBe(404);
  });

  test('base64 header values decode; plain ones pass through', () => {
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
    expect(decodeHeaderValue('search_manual')).toBe('search_manual');
  });
});
