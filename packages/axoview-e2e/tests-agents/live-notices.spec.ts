/**
 * Live notices of AI agents' work (ADR 0059 addendum 2026-11-13), over the
 * real sync stream:
 *   - an outside agent proposes: wherever the person is in Axoview, a notice
 *     names the agent, how much and where, and Review opens it;
 *   - an agent's approved change is saved: the person's other devices (and
 *     the people the diagram is shared with) are told whose change it was:
 *     an outside agent's, or Nova's from the chat.
 */
import crypto from 'crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test.setTimeout(180_000);
const TOKEN = 'test-user:alice-1';
const REDIRECT = 'http://127.0.0.1:9/callback';
const byId = (page: Page, name: string) => page.locator(`[data-axoview-id="${name}"]`);
const notice = (page: Page, text: string | RegExp) => byId(page, 'notification').filter({ hasText: text });

async function signedIn(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
    localStorage.setItem('axoview-show-drag-hint', 'false');
  });
  await context.route('**/api/auth/refresh', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accessToken: TOKEN, expiresIn: 3600, user: { sub: 'alice-1', username: 'alice', email: 'alice@example.com' } })
  }));
  await context.route('**/api/config', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, ai: { ...(real.ai || {}), chatEnabled: true, liveChat: true, diagramContextEnabled: true, agentWriteEnabled: true } } });
  });
  await context.route('**/api/ai/messages', (route) => route.fulfill({
    json: { reply: 'Add a queue.', conversationId: 'c1', sources: [], suggestions: [{ op: 'add_node', name: 'Queue' }] }
  }));
}

test('agents\' proposals and approved changes are announced live, naming the agent', async ({ page, browser, baseURL }) => {
  const base = baseURL!;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    return (await response.json().catch(() => null)) as any;
  };
  const diagram = (title: string) => api('POST', '/api/diagrams', {
    title, name: title, icons: [], colors: [{ id: 'c1', value: '#0066cc' }], items: [{ id: 'web', name: 'Web' }],
    views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }], connectors: [] }]
  });
  const here = (await diagram('Here')).id as string;
  const elsewhere = (await diagram('Elsewhere')).id as string;
  await api('PUT', '/api/agent', { level: 'proposer' });

  // An outside agent, signed in through OAuth (DCR, PKCE, consent in the app).
  await signedIn(page.context());
  const client = await (await fetch(`${base}/api/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] })
  })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const authorize = new URL(`${base}/api/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${base}/api/mcp/workspace`
  })) authorize.searchParams.set(key, value);
  let code = '';
  await page.route('http://127.0.0.1:9/**', (route) => {
    code = new URL(route.request().url()).searchParams.get('code') ?? '';
    return route.fulfill({ body: 'ok' });
  });
  await page.goto(authorize.toString());
  await byId(page, 'agent-consent-allow').click();
  await expect.poll(() => code).not.toBe('');
  const tokens = await (await fetch(`${base}/api/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT,
      code_verifier: verifier, resource: `${base}/api/mcp/workspace`
    })
  })).json();
  let rpc = 0;
  const propose = (id: string, operations: unknown[]) => fetch(`${base}/api/mcp/workspace`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name: 'propose_changes', arguments: { id, operations } } })
  });

  // This device works on "Here"; a second device has "Elsewhere" open.
  await page.goto(`${base}/app/d/${here}`);
  await expect(byId(page, 'toolbar-share')).toBeEnabled({ timeout: 30_000 });
  const other = await browser.newContext();
  await signedIn(other);
  const otherPage = await other.newPage();
  await otherPage.goto(`${base}/app/d/${elsewhere}`);
  await expect(byId(otherPage, 'toolbar-share')).toBeEnabled({ timeout: 30_000 });

  // --- The agent proposes on "Elsewhere": this device, showing "Here", is told.
  expect((await propose(elsewhere, [{ op: 'add_node', name: 'Cache' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }])).status).toBe(200);
  const proposed = notice(page, 'Claude Code proposes 2 changes to “Elsewhere”');
  await expect(proposed).toBeVisible({ timeout: 15_000 });
  // The device that has "Elsewhere" open hears it once, by name (no second, nameless pop-up).
  await expect(notice(otherPage, 'Claude Code proposes 2 changes to “Elsewhere”')).toBeVisible({ timeout: 15_000 });
  await expect(notice(otherPage, 'waiting for your approval')).toHaveCount(0);

  // Review: "Elsewhere" opens here with the proposal on screen.
  await proposed.getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/d/${elsewhere}`));
  await expect(byId(page, 'proposal')).toBeVisible({ timeout: 15_000 });

  // --- Approved here: the other device, showing "Elsewhere", gets it and is told whose it was.
  await byId(page, 'proposal-approve').click();
  await expect(notice(page, '2 changes approved and made')).toBeVisible();
  await expect(notice(otherPage, 'Claude Code’s approved changes were added to this diagram')).toBeVisible({ timeout: 15_000 });
  // No such notice where the approval was made.
  await expect(notice(page, 'approved changes were added')).toHaveCount(0);

  // --- Nova, approved in the chat here: the other device hears it was Nova's.
  await byId(page, 'ai-bubble').click();
  await byId(page, 'ai-include-page').getByRole('checkbox').check();
  await byId(page, 'ai-message-input').fill('What is missing?');
  await byId(page, 'ai-send').click();
  await page.locator('[data-axoview-id="ai-suggestions"]').last().locator('[data-axoview-id="ai-suggestion-approve-0"]').click();
  await expect(notice(page, 'Change approved and made')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+s');
  await expect(notice(otherPage, 'Nova’s approved changes were added to this diagram')).toBeVisible({ timeout: 15_000 });
  expect((await api('GET', `/api/diagrams/${elsewhere}`)).items.map((i: { name: string }) => i.name)).toEqual(['Web', 'Cache', 'Queue']);

  // --- The other device switches to "Here"; an approved change to "Elsewhere" offers to open it.
  await otherPage.goto(`${base}/app/d/${here}`);
  await expect(byId(otherPage, 'toolbar-share')).toBeEnabled({ timeout: 30_000 });
  expect((await propose(elsewhere, [{ op: 'add_node', name: 'Worker' }])).status).toBe(200);
  await expect(notice(page, 'Claude Code proposes 1 change to “Elsewhere”')).toBeVisible({ timeout: 15_000 });
  await byId(page, 'proposals-chip').click();
  await byId(page, 'proposal-approve').click();
  const added = notice(otherPage, 'Claude Code’s approved changes were added to “Elsewhere”');
  await expect(added).toBeVisible({ timeout: 15_000 });
  await added.getByRole('button', { name: 'Open' }).click();
  await expect(otherPage).toHaveURL(new RegExp(`/app/d/${elsewhere}`));
  await other.close();
});
