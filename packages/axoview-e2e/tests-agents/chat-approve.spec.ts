/**
 * Approving the in-app assistant's suggestions saves them, one after another,
 * before and after the diagram is opened again, through a CloudFront-like
 * proxy (agents/stack.mjs): API answers of 1,000 bytes or more come back
 * gzipped with a WEAK ETag (W/"7").
 *
 * Behind CloudFront the app used to read only strong ETags (fixed
 * 2026-11-13), so a tab that opened a diagram that was not tiny did not learn
 * its version from the load: approvals went out without If-Match and the
 * versioned store refused them (428), and re-reading the version came back
 * weak too. oauth-propose-approve.spec.ts covers approvals of an outside
 * agent's proposals; this covers the chat panel's, whose saves must not 428.
 *
 * Nova itself is the one stand-in: its answer is scripted in the page. The
 * app, the backend and its storage are real.
 */
import { expect, test, type Page } from '@playwright/test';

test.setTimeout(180_000);
const TOKEN = 'test-user:alice-1';
const byId = (page: Page, name: string) => page.locator(`[data-axoview-id="${name}"]`);

test('chat suggestions approved one after another are all saved, before and after a reload', async ({ page, context, baseURL }) => {
  const base = baseURL!;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, etag: response.headers.get('etag'), body: await response.json().catch(() => null) };
  };
  const storedNames = async (id: string) => (await api('GET', `/api/diagrams/${id}`)).body.items.map((i: { name: string }) => i.name);

  // Already big enough to be compressed on the way out (as most real diagrams are).
  const seed = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, name: `Existing service ${i + 1}` }));
  const { body: { id } } = await api('POST', '/api/diagrams', {
    title: 'Chat approvals', name: 'Chat approvals', icons: [], colors: [{ id: 'c1', value: '#0066cc' }],
    items: [{ id: 'web', name: 'Web' }, ...seed],
    views: [{
      id: 'p1', name: 'Page 1', connectors: [],
      items: [{ id: 'web', tile: { x: 0, y: 0 } }, ...seed.map((s, i) => ({ id: s.id, tile: { x: 4 + (i % 4) * 3, y: Math.floor(i / 4) * 3 } }))]
    }]
  });
  // Where diagrams have versions, the load's version arrives weakened.
  if (test.info().project.name === 'agents-aws') {
    expect((await api('GET', `/api/diagrams/${id}`)).etag).toMatch(/^W\/"\d+"$/);
  }
  expect((await api('PUT', '/api/agent', { level: 'proposer' })).status).toBe(200);

  await context.addInitScript(() => {
    localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
    localStorage.setItem('axoview-show-drag-hint', 'false');
  });
  await context.route('**/api/auth/refresh', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accessToken: TOKEN, expiresIn: 3600, user: { sub: 'alice-1', username: 'alice', email: 'alice@example.com' } })
  }));
  // The deployment has the assistant on; this stack has no Bedrock, so Nova's answers are scripted.
  await context.route('**/api/config', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, ai: { ...(real.ai || {}), chatEnabled: true, liveChat: true, diagramContextEnabled: true, agentWriteEnabled: true } } });
  });
  const answers = [
    [{ op: 'add_node', name: 'Cache', icon: 'database' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } }],
    [{ op: 'add_node', name: 'Queue' }, { op: 'connect', from: { name: 'Web' }, to: { name: 'Queue' } }],
    [{ op: 'add_node', name: 'Worker' }, { op: 'connect', from: { name: 'Queue' }, to: { name: 'Worker' } }],
    [{ op: 'rename_node', node: { name: 'Cache' }, name: 'Redis' }]
  ];
  let asked = 0;
  await context.route('**/api/ai/messages', (route) => route.fulfill({
    json: { reply: 'Here is an idea.', conversationId: `c${asked}`, sources: [], suggestions: answers[asked++] }
  }));
  const refused: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/diagrams/') && r.status() >= 400) refused.push(`${r.request().method()} ${r.status()}`);
  });

  async function openAndAsk() {
    await page.goto(`${base}/app/d/${id}`);
    await expect(byId(page, 'toolbar-share')).toBeEnabled({ timeout: 30_000 });
    await byId(page, 'ai-bubble').click();
    await byId(page, 'ai-include-page').getByRole('checkbox').check();
  }
  async function approveNext(expected: string[]) {
    await byId(page, 'ai-message-input').fill('What next?');
    await byId(page, 'ai-send').click();
    // One step has its own Approve; several have Approve all as well.
    const answer = page.locator('[data-axoview-id="ai-suggestions"]').last();
    const approve = asked > 0 && answers[asked - 1].length === 1
      ? answer.locator('[data-axoview-id="ai-suggestion-approve-0"]')
      : answer.locator('[data-axoview-id="ai-suggestions-approve-all"]');
    await expect(approve).toBeVisible({ timeout: 15_000 });
    await approve.click();
    await expect(page.locator('[data-axoview-id="notification"]').filter({ hasText: 'approved and made' }).first()).toBeVisible();
    // Ctrl+S: upload now rather than at the end of the batch window.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+s');
    await expect.poll(() => storedNames(id), { timeout: 15_000 }).toEqual(expected);
    await expect(page.getByText('Save failed')).toHaveCount(0);
    await expect(byId(page, 'dialog-save-error')).toHaveCount(0);
  }

  const before = ['Web', ...seed.map((s) => s.name)];
  await openAndAsk();
  await approveNext([...before, 'Cache']);
  await approveNext([...before, 'Cache', 'Queue']);
  // Opened again: the version comes from a compressed load this time.
  await openAndAsk();
  await approveNext([...before, 'Cache', 'Queue', 'Worker']);
  await approveNext([...before, 'Redis', 'Queue', 'Worker']);
  // A refused save the app then repaired is fine; one that stayed refused is not.
  expect(refused.filter((r) => r.endsWith('428'))).toEqual([]);
});
