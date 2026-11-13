/**
 * An outside agent, end to end (ADR 0059 and its addendum of 2026-11-12):
 *
 *   OAuth      the official MCP SDK client meets a 401, discovers the server,
 *              registers itself and sends the person to the consent page
 *   propose    with its token it reads the diagram and proposes changes
 *   approve    the person approves them in the app
 *   persisted  the diagram on the server holds them, and only then is the
 *              agent told "approved"
 *
 * Everything is the shipped code (built app, real backend, real MCP client,
 * real browser) except Cognito: `test-user:alice-1` stands for Alice's
 * session (agents/stack.mjs).
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

const ALICE = { sub: 'alice-1', username: 'alice', email: 'alice@example.com' };
const TOKEN = `test-user:${ALICE.sub}`;

type Diagram = {
  title: string;
  lastModified: string;
  items: Array<{ id: string; name: string }>;
  views: Array<{ items: Array<{ id: string }>; connectors?: Array<{ anchors: Array<{ ref: { item?: string } }> }> }>;
};
type Structured = Record<string, any>;

const byId = (page: Page, name: string) => page.locator(`[data-axoview-id="${name}"]`);

/** The edges of the first page as "From > To", sorted. */
function edges(diagram: Diagram): string[] {
  const name = (id?: string) => diagram.items.find((item) => item.id === id)?.name ?? '?';
  return (diagram.views[0].connectors ?? [])
    .map((c) => `${name(c.anchors[0].ref.item)} > ${name(c.anchors[c.anchors.length - 1].ref.item)}`)
    .sort();
}

test('OAuth, propose, approve: the change is stored before the agent hears "approved"', async ({ page, baseURL }) => {
  const base = baseURL!;
  // Alice's own requests (what her signed-in app sends), for setting up and for reading what is stored.
  const alice = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    expect(response.ok, `${method} ${path} -> ${response.status}`).toBe(true);
    return (await response.json()) as T;
  };
  const stored = (id: string) => alice<Diagram>('GET', `/api/diagrams/${id}`);

  const { id } = await alice<{ id: string }>('POST', '/api/diagrams', {
    title: 'Agent demo',
    name: 'Agent demo',
    icons: [],
    colors: [{ id: 'c1', value: '#0066cc' }],
    items: [{ id: 'web', name: 'Web' }, { id: 'db', name: 'Database' }],
    views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }, { id: 'db', tile: { x: 6, y: 0 } }], connectors: [] }]
  });

  // --- The agent: an MCP client app with a loopback callback, as Claude Code has.
  let deliver: (url: URL) => void = () => {};
  const callback = new Promise<URL>((resolve) => { deliver = resolve; });
  const loopback = http.createServer((req, res) => {
    res.end('You can close this tab.');
    deliver(new URL(req.url ?? '/', 'http://127.0.0.1'));
  });
  await new Promise<void>((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${(loopback.address() as AddressInfo).port}/callback`;

  const kept: { client?: any; tokens?: any; verifier?: string; authorizeUrl?: string } = {};
  const provider: OAuthClientProvider = {
    get redirectUrl() { return redirect; },
    get clientMetadata() {
      return {
        client_name: 'Agent e2e (MCP SDK)',
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      };
    },
    clientInformation: () => kept.client,
    saveClientInformation: (client) => { kept.client = client; },
    tokens: () => kept.tokens,
    saveTokens: (tokens) => { kept.tokens = tokens; },
    redirectToAuthorization: (url) => { kept.authorizeUrl = url.toString(); },
    saveCodeVerifier: (verifier) => { kept.verifier = verifier; },
    codeVerifier: () => kept.verifier!
  };
  const mcpUrl = new URL(`${base}/api/mcp/workspace`);

  try {
    // --- OAuth. No token yet: the server answers 401, the SDK discovers the
    // authorization server, registers the client and asks for a browser.
    const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await expect(new Client({ name: 'agent-e2e', version: '1.0.0' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(kept.client?.client_id).toBeTruthy();
    expect(kept.authorizeUrl).toContain('/api/oauth/authorize');

    // Alice's browser, signed in (the one faked piece: her Cognito session).
    await page.addInitScript(() => {
      localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
      localStorage.setItem('axoview-show-drag-hint', 'false');
    });
    await page.route('**/api/auth/refresh', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'test-user:alice-1', expiresIn: 3600, user: { sub: 'alice-1', username: 'alice', email: 'alice@example.com' } })
    }));
    await page.goto(kept.authorizeUrl!);
    await expect(byId(page, 'agent-consent-title')).toBeVisible({ timeout: 30_000 });
    await byId(page, 'agent-consent-allow').click();
    const back = await callback;
    expect(back.searchParams.get('iss')).toBe(`${base}/api/oauth`);
    await first.finishAuth(back.searchParams.get('code')!);
    expect(kept.tokens?.access_token).toBeTruthy();
    expect(kept.tokens?.refresh_token).toBeTruthy();

    // A code works once: presenting it again gets no second pair of tokens.
    const replay = await fetch(`${base}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        client_id: kept.client.client_id,
        redirect_uri: redirect,
        code_verifier: kept.verifier!,
        resource: mcpUrl.toString()
      })
    });
    expect(replay.status).toBe(400);

    // --- The agent uses the tools.
    const agent = new Client({ name: 'agent-e2e', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    const call = async (name: string, args: Record<string, unknown>) =>
      (await agent.callTool({ name, arguments: args })).structuredContent as Structured;
    expect((await agent.listTools()).tools.map((tool) => tool.name).sort())
      .toEqual(['get_proposal', 'list_diagrams', 'propose_changes', 'read_diagram']);
    expect((await call('list_diagrams', {})).diagrams.map((d: Structured) => d.id)).toContain(id);
    expect((await call('read_diagram', { id })).description.nodes.map((n: Structured) => n.name).sort()).toEqual(['Database', 'Web']);

    // --- Propose.
    const proposed = await call('propose_changes', {
      id,
      note: 'Put a cache between the web tier and the database.',
      operations: [
        { op: 'add_node', name: 'Cache', reason: 'Hot reads' },
        { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } },
        { op: 'connect', from: { name: 'Cache' }, to: { name: 'Database' } },
        { op: 'remove_node', node: { name: 'Legacy FTP' } }
      ]
    });
    const pid: string = proposed.proposal.id;
    expect((await call('get_proposal', { id, proposal: pid })).status).toBe('pending');
    const before = await stored(id);
    expect(before.items.map((item) => item.name)).toEqual(['Web', 'Database']);

    // While Alice decides, the agent keeps asking. Every time it is told
    // "approved", the stored diagram must already hold the change.
    let watching = true;
    const sightings: Array<{ status: string; storedHasCache: boolean }> = [];
    const watcher = (async () => {
      while (watching) {
        const status: string = (await call('get_proposal', { id, proposal: pid })).status;
        const diagram = await stored(id);
        sightings.push({ status, storedHasCache: diagram.items.some((item) => item.name === 'Cache') });
        if (status !== 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    // --- Approve, in the app.
    await page.goto(`${base}/app/d/${id}`);
    await expect(byId(page, 'proposals-chip')).toHaveText('1 to approve', { timeout: 30_000 });
    await byId(page, 'proposals-chip').click();
    await expect(byId(page, 'proposal')).toBeVisible();
    await expect(page.locator('[data-axoview-id="proposal-step"]')).toHaveCount(4);
    await expect(page.locator('[data-axoview-id="proposal-step"][data-status="ready"]')).toHaveCount(3);
    await expect(byId(page, 'proposal-approve')).toHaveText('Approve the 3 that fit');
    await byId(page, 'proposal-approve').click();
    await expect(byId(page, 'notification').last()).toContainText('3 changes approved and made');
    await expect(byId(page, 'proposals-chip')).toHaveCount(0);

    // --- Persisted: at once, with no save shortcut and no waiting for autosave.
    const after = await stored(id);
    expect(after.items.map((item) => item.name)).toEqual(['Web', 'Database', 'Cache']);
    expect(edges(after)).toEqual(['Cache > Database', 'Web > Cache']);
    expect(after.title).toBe('Agent demo');

    await watcher;
    watching = false;
    expect(sightings.at(-1)).toEqual({ status: 'approved', storedHasCache: true });
    expect(sightings.filter((s) => s.status === 'approved' && !s.storedHasCache)).toEqual([]);
    expect(await call('get_proposal', { id, proposal: pid })).toMatchObject({ status: 'approved', steps: 4, applied: 3 });
    // The agent reads its own change back.
    expect((await call('read_diagram', { id })).description.nodes.map((n: Structured) => n.name).sort())
      .toEqual(['Cache', 'Database', 'Web']);

    // The editor shows what was stored, and saving it again changes nothing.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1500);
    const settled = await stored(id);
    expect(settled.items).toEqual(after.items);
    expect(edges(settled)).toEqual(edges(after));

    // --- A second proposal in the same window: built on the state the first
    // approval left, so it is accepted too (the window kept track of it).
    const second = await call('propose_changes', { id, operations: [{ op: 'add_node', name: 'Queue' }] });
    await expect(byId(page, 'proposals-chip')).toHaveText('1 to approve', { timeout: 15_000 });
    await byId(page, 'proposals-chip').click();
    await byId(page, 'proposal-approve').click();
    await expect(byId(page, 'notification').last()).toContainText('Change approved and made');
    expect((await stored(id)).items.map((item) => item.name)).toEqual(['Web', 'Database', 'Cache', 'Queue']);
    expect((await call('get_proposal', { id, proposal: second.proposal.id })).status).toBe('approved');

    // --- And again, and again: each approval in this window is stored, the
    // way a person works through an agent's suggestions one after another.
    const names = ['Web', 'Database', 'Cache', 'Queue'];
    for (const next of ['Worker', 'Search', 'CDN']) {
      const proposal = await call('propose_changes', {
        id, operations: [{ op: 'add_node', name: next }, { op: 'connect', from: { name: 'Web' }, to: { name: next } }]
      });
      await expect(byId(page, 'proposals-chip')).toHaveText('1 to approve', { timeout: 15_000 });
      await byId(page, 'proposals-chip').click();
      await byId(page, 'proposal-approve').click();
      await expect(byId(page, 'notification').last()).toContainText('2 changes approved and made');
      names.push(next);
      expect((await stored(id)).items.map((item) => item.name), `after approving ${next}`).toEqual(names);
      expect((await call('get_proposal', { id, proposal: proposal.proposal.id })).status).toBe('approved');
      // The autosave of the change on screen settles without conflict or duplicates.
      await page.waitForTimeout(2500);
      expect((await stored(id)).items.map((item) => item.name), `settled after ${next}`).toEqual(names);
    }
    expect(edges(await stored(id))).toEqual([
      'Cache > Database', 'Web > CDN', 'Web > Cache', 'Web > Search', 'Web > Worker'
    ]);

    // --- Several waiting at once, the later ones naming items the earlier
    // ones add, approved back to back with no pause.
    const batch = [];
    for (const [node, from] of [['Auth', 'Web'], ['Users', 'Auth'], ['Audit', 'Users']]) {
      batch.push((await call('propose_changes', {
        id, operations: [{ op: 'add_node', name: node }, { op: 'connect', from: { name: from }, to: { name: node } }]
      })).proposal.id as string);
    }
    await expect(byId(page, 'proposals-chip')).toHaveText('3 to approve', { timeout: 15_000 });
    await byId(page, 'proposals-chip').click();
    for (const [i, node] of ['Auth', 'Users', 'Audit'].entries()) {
      // Oldest last in the list: approve from the bottom up, in the order they were made.
      await page.locator('[data-axoview-id="proposal-approve"]').last().click();
      // Decided: it leaves the list (the toast reads the same for each one).
      await expect(page.locator('[data-axoview-id="proposal-approve"]')).toHaveCount(2 - i);
      names.push(node);
      expect((await stored(id)).items.map((item) => item.name), `batch ${i}`).toEqual(names);
    }
    for (const pid of batch) expect((await call('get_proposal', { id, proposal: pid })).status).toBe('approved');
    await page.waitForTimeout(2500);
    expect((await stored(id)).items.map((item) => item.name)).toEqual(names);

    // --- After a reload the window shows the stored diagram and nothing waits.
    await page.reload();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(byId(page, 'proposals-chip')).toHaveCount(0);
    expect((await stored(id)).items.map((item) => item.name)).toEqual(names);

    // --- Approving in the reopened window. The diagram is big enough now
    // that its load comes back compressed, with a weak ETag (W/"n"); the
    // window must still know its version, or every approval is refused (428).
    for (const next of ['Billing', 'Reports']) {
      const proposal = await call('propose_changes', { id, operations: [{ op: 'add_node', name: next }] });
      await expect(byId(page, 'proposals-chip')).toHaveText('1 to approve', { timeout: 15_000 });
      await byId(page, 'proposals-chip').click();
      await byId(page, 'proposal-approve').click();
      await expect(byId(page, 'proposals-chip')).toHaveCount(0);
      await expect(byId(page, 'notification').last()).toContainText('Change approved and made');
      names.push(next);
      expect((await stored(id)).items.map((item) => item.name), `approved ${next} after reopening`).toEqual(names);
      expect((await call('get_proposal', { id, proposal: proposal.proposal.id })).status).toBe('approved');
    }

    // --- The refresh token rotates: the old one stops working.
    const used = kept.tokens.refresh_token as string;
    const refresh = (token: string) => fetch(`${base}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: kept.client.client_id, resource: mcpUrl.toString() })
    });
    const attempts = await Promise.all([refresh(used), refresh(used), refresh(used)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect((await refresh(used)).status).toBe(400);
    await agent.close();
  } finally {
    loopback.close();
  }
});
