/**
 * An AI agent on its person's account (ADR 0057 addendum 3, ADR 0052 addendum
 * 2026-11-10): the person sets once what Nova may do. Under "Changes need my
 * approval", a suggestion is made on the page only when they approve it in
 * the chat, as one change that one Undo takes back, and it is saved like any
 * edit. On a diagram shared with them as Read only, Nova is Read only too.
 *
 * The API is scripted (helpers/mockApi.ts): a signed-in, server-storage
 * deployment with chat, page context and agent writes on.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { installApiMock } from '../helpers/mockApi';
import { byAxoviewId } from '../helpers/selectors';
import { getModelConnectorCount, getModelItemCount } from '../helpers/store';
import { CanvasPOM } from '../pom/CanvasPOM';

const STAMP = '2026-11-10T00:00:00.000Z';
const DIAGRAM = {
  title: 'Network',
  items: [{ id: 'web', name: 'Web' }],
  icons: [],
  colors: [{ id: 'c1', value: '#0066cc' }],
  views: [{
    id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }],
    connectors: [], rectangles: [], textBoxes: []
  }],
  lastModified: STAMP
};
const SUGGESTIONS = [
  { op: 'add_node', name: 'Cache', reason: 'Hot reads.' },
  { op: 'connect', from: { name: 'Web' }, to: { name: 'Cache' } },
  { op: 'rename_node', node: { name: 'Nobody' }, name: 'X' }
];

let saved: Array<typeof DIAGRAM> = [];
const lastSaved = () => saved[saved.length - 1];
test.beforeEach(() => { saved = []; });

async function boot(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  opts: { level: 'viewer' | 'proposer'; role?: 'viewer'; sharedByYou?: boolean }
) {
  const origin = new URL(baseURL).origin;
  const mock = await installApiMock(context, origin, {
    'GET /api/config': {
      status: 200,
      json: {
        authMode: 'cognito',
        cognito: {
          domain: 'https://auth.example.test',
          clientId: 'e2e-client',
          redirectUri: `${origin}/app/auth/callback`,
          logoutUri: `${origin}/`,
          providers: ['Google']
        },
        serverStorage: true,
        sharing: true,
        ai: { chatEnabled: true, liveChat: true, diagramContextEnabled: true, agentWriteEnabled: true }
      }
    },
    'POST /api/auth/refresh': {
      status: 200,
      json: { accessToken: 'e2e-access-token', expiresIn: 3600, user: { sub: 'alice-1', username: 'alice' } }
    },
    'GET /api/diagrams': {
      status: 200,
      json: [{
        id: 'd1', name: 'Network', lastModified: STAMP, folderId: null,
        ...(opts.role ? { shared: { role: opts.role, ownerEmail: 'bob@example.com' } } : {})
      }]
    },
    'GET /api/folders': { status: 200, json: [] },
    'GET /api/tree-manifest': { status: 200, json: { folders: [] } },
    'GET /api/sync/events': { status: 204, text: '' },
    'GET /api/diagrams/d1/members': { status: 200, json: { members: [] } },
    'GET /api/agent': { status: 200, json: { level: opts.level } },
    'PUT /api/agent': { status: 200, json: { level: 'proposer' } },
    'POST /api/ai/messages': {
      status: 200,
      json: { reply: 'Add a cache.', conversationId: 'c1', sources: [], suggestions: SUGGESTIONS }
    }
  });
  // The load and saves carry X-Axoview-Shared, which helpers/mockApi cannot
  // set. Shared by you: each save uploads at once (no batching), so the test
  // sees every one.
  const shared = {
    ...(opts.role ? { 'X-Axoview-Shared': 'with-you', 'X-Axoview-Role': opts.role } : {}),
    ...(opts.sharedByYou ? { 'X-Axoview-Shared': 'by-you', 'X-Axoview-Role': 'owner' } : {})
  };
  let version = 1;
  await context.route((url) => url.pathname === '/api/diagrams/d1', async (route) => {
    const method = route.request().method();
    if (method !== 'GET' && method !== 'PUT') return route.fallback();
    if (method === 'PUT') saved.push(route.request().postDataJSON() as typeof DIAGRAM);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'ETag, X-Axoview-Shared, X-Axoview-Role',
        ETag: `"${method === 'PUT' ? ++version : version}"`,
        ...shared
      },
      body: JSON.stringify(method === 'PUT' ? { success: true } : DIAGRAM)
    });
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
      localStorage.setItem('axoview-show-drag-hint', 'false');
    } catch {
      /* not available yet */
    }
  });
  return mock;
}

async function askNova(page: Page) {
  await byAxoviewId(page, 'ai-bubble').click();
  await byAxoviewId(page, 'ai-include-page').getByRole('checkbox').check();
  await byAxoviewId(page, 'ai-message-input').fill('What is missing?');
  await byAxoviewId(page, 'ai-send').click();
  await expect(byAxoviewId(page, 'ai-suggestions')).toBeVisible();
}

const step = (page: Page, i: number) => byAxoviewId(page, `ai-suggestion-${i}`);

test('"Changes need my approval": approved steps are made as one change, saved, and one Undo takes them back', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, { level: 'proposer', sharedByYou: true });
  await page.goto('/app/d/d1');
  await expect(byAxoviewId(page, 'toolbar-share')).toBeEnabled({ timeout: 20_000 });
  await askNova(page);
  await expect(byAxoviewId(page, 'ai-agent-level-select')).toHaveValue('proposer');
  await expect(byAxoviewId(page, 'ai-suggestions')).toContainText('nothing changes until you approve');
  await expect(step(page, 2)).toHaveAttribute('data-status', 'not_applicable');

  await byAxoviewId(page, 'ai-suggestions-approve-all').click();
  await expect(page.locator('[data-axoview-id="notification"][data-severity="success"]').last())
    .toContainText('2 changes approved and made');
  await expect(step(page, 0)).toHaveAttribute('data-status', 'applied');
  await expect(step(page, 1)).toHaveAttribute('data-status', 'applied');

  expect(await getModelItemCount(page)).toBe(2);
  expect(await getModelConnectorCount(page)).toBe(1);

  // Saved like any edit: the new item and its connector reach the server.
  await expect.poll(() => lastSaved()?.items.map((i) => i.name), { timeout: 10_000 }).toEqual(['Web', 'Cache']);
  expect(lastSaved()?.views[0].connectors).toHaveLength(1);

  // One Undo takes the whole approval back.
  await byAxoviewId(page, 'ai-minimize').click();
  await new CanvasPOM(page).clickAt({ x: 700, y: 500 });
  await page.keyboard.press('Control+z');
  await expect.poll(() => getModelItemCount(page), { timeout: 5_000 }).toBe(1);
  expect(await getModelConnectorCount(page)).toBe(0);
  await expect.poll(() => lastSaved()?.items.map((i) => i.name), { timeout: 10_000 }).toEqual(['Web']);
});

test('Read only (the default): Nova only suggests; nothing on the page changes', async ({ page, context, baseURL }) => {
  const mock = await boot(page, context, baseURL!, { level: 'viewer' });
  await page.goto('/app/d/d1');
  await expect(byAxoviewId(page, 'toolbar-share')).toBeEnabled({ timeout: 20_000 });
  await askNova(page);
  await expect(byAxoviewId(page, 'ai-suggestions')).toContainText('make them yourself');
  await expect(byAxoviewId(page, 'ai-suggestions-approve-all')).toHaveCount(0);
  await expect(step(page, 0).getByRole('checkbox')).toBeVisible();

  // Switching to approval is saved for the account, and the buttons appear.
  await byAxoviewId(page, 'ai-agent-level').getByRole('combobox').click();
  await page.getByRole('option', { name: 'Changes need my approval' }).click();
  await expect.poll(() => mock.callsTo('PUT /api/agent').map((c) => c.body)).toEqual([{ level: 'proposer' }]);
  await expect(byAxoviewId(page, 'ai-suggestion-approve-0')).toBeVisible();
  expect(saved).toEqual([]);
});

test('on a diagram shared as Read only, Nova is Read only too', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, { level: 'proposer', role: 'viewer' });
  await page.goto('/app/d/d1');
  // The Read only person lands in the read-only viewer, where Nova has no page to change.
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe('/app/display/d1');
  await byAxoviewId(page, 'ai-bubble').click();
  await expect(byAxoviewId(page, 'ai-chat-window')).toBeVisible();
  await expect(byAxoviewId(page, 'ai-agent-level-select')).toHaveValue('proposer');
  await expect(byAxoviewId(page, 'ai-agent-level-capped')).toHaveText('· Read only here, like you');
  await expect(byAxoviewId(page, 'ai-suggestion-approve-0')).toHaveCount(0);
});
