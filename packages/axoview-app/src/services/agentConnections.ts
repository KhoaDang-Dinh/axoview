/**
 * Outside agents connected to this account through MCP sign-in (ADR 0059):
 * the consent request an agent's sign-in brings the person to, and the
 * clients they connected, each with what it may do. All calls carry the
 * person's own session (apiFetch).
 */
import { apiFetch } from './apiFetch';
import { apiBaseUrl } from '../utils/apiBaseUrl';

export const SCOPE_PROPOSE = 'diagrams:propose';

/** What the consent page shows about the app asking. */
export interface ConsentRequest {
  clientName: string;
  /** The host its metadata document is on (a client_id URL), or null for a self-registered app. */
  clientHost: string | null;
  registration: 'metadata' | 'dynamic';
  /** Where the browser goes back to after the decision. */
  redirectHost: string;
  /** True when that is an app on this computer (a loopback address). */
  loopback: boolean;
  scopes: string[];
}

/** A connected app. */
export interface AgentGrant {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  redirectHost: string;
  createdAt: string;
  updatedAt: string;
}

const url = (path: string) => `${apiBaseUrl()}/api/oauth${path}`;

export async function readConsentRequest(id: string): Promise<ConsentRequest | null> {
  const response = await apiFetch(url(`/requests/${encodeURIComponent(id)}`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`consent request: ${response.status}`);
  return (await response.json()) as ConsentRequest;
}

/** Records the decision; resolves the URL to send the browser back to the app. */
export async function decideConsent(id: string, approve: boolean, scopes?: string[]): Promise<string | null> {
  const response = await apiFetch(url(`/requests/${encodeURIComponent(id)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve, ...(scopes ? { scopes } : {}) })
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`consent decision: ${response.status}`);
  const { redirect } = (await response.json()) as { redirect?: unknown };
  return typeof redirect === 'string' ? redirect : null;
}

export async function listAgentGrants(): Promise<AgentGrant[]> {
  const response = await apiFetch(url('/grants'));
  if (!response.ok) throw new Error(`connected apps: ${response.status}`);
  const { grants } = (await response.json()) as { grants?: AgentGrant[] };
  return Array.isArray(grants) ? grants : [];
}

export async function setAgentMayPropose(id: string, mayPropose: boolean): Promise<AgentGrant> {
  const response = await apiFetch(url(`/grants/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes: mayPropose ? [SCOPE_PROPOSE] : [] })
  });
  if (!response.ok) throw new Error(`connected app: ${response.status}`);
  return ((await response.json()) as { grant: AgentGrant }).grant;
}

export async function disconnectAgent(id: string): Promise<void> {
  const response = await apiFetch(url(`/grants/${encodeURIComponent(id)}`), { method: 'DELETE' });
  if (!response.ok) throw new Error(`disconnect: ${response.status}`);
}

/** The workspace MCP server's URL, the one a person gives their MCP client. */
export const workspaceMcpUrl = (origin: string = window.location.origin) =>
  `${(apiBaseUrl() || origin).replace(/\/+$/, '')}/api/mcp/workspace`;
