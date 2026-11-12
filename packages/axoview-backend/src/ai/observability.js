/**
 * Safe structured telemetry. No prompts, response text, retrieval contents,
 * user IDs, workspace IDs, token values, or client IPs in operational logs.
 */
const KNOWN_STAGES = new Set(['input', 'retrieval', 'model', 'output', 'quota', 'storage', 'completed']);
const KNOWN_RESULTS = new Set(['ok', 'blocked', 'rejected', 'error']);
// Model routing (modelRouting.js): which model answered, and why.
const KNOWN_MODELS = new Set(['fast', 'strong']);
const KNOWN_ROUTES = new Set(['page', 'tools', 'long', 'plain', 'fallback']);

export function emitAiTelemetry({
  requestId, stage, result,
  latencyMs = 0, inputTokens = 0, outputTokens = 0,
  retrievedDocuments = 0, model, route
}, write = (message) => console.log(message)) {
  const record = {
    event: 'ai.request',
    requestId: /^[a-f0-9-]{36}$/i.test(requestId || '') ? requestId : 'unknown',
    stage: KNOWN_STAGES.has(stage) ? stage : 'unknown',
    result: KNOWN_RESULTS.has(result) ? result : 'error',
    latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
    inputTokens: Math.max(0, Math.round(Number(inputTokens) || 0)),
    outputTokens: Math.max(0, Math.round(Number(outputTokens) || 0)),
    retrievedDocuments: Math.min(10, Math.max(0, Math.round(Number(retrievedDocuments) || 0))),
    // Only when model routing is on: the tier that answered and the rule that chose it.
    ...(KNOWN_MODELS.has(model) && KNOWN_ROUTES.has(route) ? { model, route } : {}),
    ts: new Date().toISOString()
  };
  write(JSON.stringify(record));
  return record;
}

const AGENT_OUTCOMES = new Set(['suggested', 'none', 'malformed']);

/**
 * One line per agent turn: a chat message sent with a diagram page, where the
 * model may propose edits (suggestions.js). Counts only: never the page, the
 * suggested edits or the reply. Each suggestion is one diagram operation. CloudWatch counts the outcomes (infra:
 * modules/observability/logging.tf), e.g.
 *   {"event":"ai.agent","outcome":"suggested","suggestions":2,"dropped":0,...}
 * outcome: suggested (at least one valid suggestion), malformed (the model
 * proposed some, all failed validation), none (an answer without edits).
 */
export function emitAgentTelemetry({
  requestId, suggestions = 0, dropped = 0, sources = 0, latencyMs = 0, toolCalls = 0
}, write = (message) => console.log(message)) {
  const count = (value, max) => Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  const made = count(suggestions, 8);
  const failed = count(dropped, 32);
  const outcome = made > 0 ? 'suggested' : failed > 0 ? 'malformed' : 'none';
  const record = {
    event: 'ai.agent',
    requestId: /^[a-f0-9-]{36}$/i.test(requestId || '') ? requestId : 'unknown',
    outcome: AGENT_OUTCOMES.has(outcome) ? outcome : 'none',
    suggestions: made,
    dropped: failed,
    sources: count(sources, 10),
    // Tool calls the agent loop made (novaAgent.js); 0 for a single model call.
    toolCalls: count(toolCalls, 20),
    latencyMs: count(latencyMs, 600000),
    ts: new Date().toISOString()
  };
  write(JSON.stringify(record));
  return record;
}

const MCP_METHODS = new Set(['server/discover', 'initialize', 'ping', 'tools/list', 'tools/call']);
const MCP_RESULTS = new Set(['ok', 'rejected', 'error']);
const MCP_OUTCOMES = new Set(['hit', 'empty', 'invalid']);

/**
 * One line per MCP request (mcp.js), errors included. Never the query text or
 * the client: method (unknown names collapse to "other", so a caller cannot
 * write into the log), tool, result and timing.
 *   result:  ok, rejected (4xx: a client mistake), error (5xx)
 *   outcome: tools/call only: hit, empty (no results), invalid (a tool error
 *            the model can recover from). Not "error": CloudWatch filters
 *            match words, and "error" must mean a failed request (5xx) only.
 */
export function emitMcpTelemetry({
  method, tool, result, outcome, code, results, mode, era, latencyMs = 0, server
}, write = (message) => console.log(message)) {
  const record = {
    event: 'mcp.request',
    // Which MCP server: the public manual (no field) or the signed-in workspace one.
    ...(server === 'workspace' ? { server: 'workspace' } : {}),
    method: MCP_METHODS.has(method) ? method : 'other',
    result: MCP_RESULTS.has(result) ? result : 'error',
    ...(method === 'tools/call' && result === 'ok' ? {
      tool: /^[a-z_]{1,40}$/.test(tool || '') ? tool : 'other',
      outcome: MCP_OUTCOMES.has(outcome) ? outcome : 'invalid',
      results: Math.min(50, Math.max(-1, Math.round(Number(results) || 0))),
      mode: mode === 'hybrid' || mode === 'keyword' ? mode : 'none'
    } : {}),
    ...(Number.isInteger(code) ? { code } : {}),
    era: era === 'modern' ? 'modern' : 'legacy',
    latencyMs: Math.min(600000, Math.max(0, Math.round(Number(latencyMs) || 0))),
    ts: new Date().toISOString()
  };
  write(JSON.stringify(record));
  return record;
}
