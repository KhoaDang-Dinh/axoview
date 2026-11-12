/**
 * Sharing a diagram by email from the Share dropdown (ADR 0057 §5, owner
 * decisions 2026-11-09/10): the email field under the link with a permission
 * level (Read only by default, or Full admin), a green pop-up on success
 * (field cleared, person listed), a red one on every failure (email kept),
 * changing a level, removing a person, the note on a diagram shared with you
 * as Read only, and approving a change your own agent made through the API
 * under "Changes need my approval" (agents are not members: ADR 0057
 * addendum 3; the in-app assistant's approvals are agent-approval.spec.ts).
 *
 * The API is scripted (helpers/mockApi.ts) as a signed-in server-storage
 * deployment with sharing on. The two-person flow against the real backend
 * is covered by axoview-backend's server.sharing.spec.js.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { installApiMock, type ApiMock, type MockReply } from '../helpers/mockApi';
import { byAxoviewId } from '../helpers/selectors';

const DIAGRAM = {
  title: 'Network',
  items: [],
  icons: [],
  colors: [{ id: 'c1', value: '#0066cc' }],
  views: [{ id: 'p1', name: 'Page 1', items: [], connectors: [], rectangles: [], textBoxes: [] }],
  lastModified: '2026-11-10T00:00:00.000Z'
};
const BOB = { sub: 'bob-2', email: 'bob@example.com', role: 'viewer', addedAt: '2026-11-10T00:00:00.000Z' };

type Shared = { state: 'by-you' | 'with-you'; role: 'owner' | 'viewer' | 'admin' } | null;

async function boot(page: Page, context: BrowserContext, baseURL: string, shared: Shared) {
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
        sharing: true
      }
    },
    'POST /api/auth/refresh': {
      status: 200,
      json: { accessToken: 'e2e-access-token', expiresIn: 3600, user: { sub: 'alice-1', username: 'alice' } }
    },
    'GET /api/diagrams': {
      status: 200,
      json: [{
        id: 'd1',
        name: 'Network',
        lastModified: DIAGRAM.lastModified,
        folderId: null,
        ...(shared?.state === 'with-you' ? { shared: { role: shared.role, ownerEmail: 'alice@example.com' } } : {})
      }]
    },
    'GET /api/folders': { status: 200, json: [] },
    'GET /api/tree-manifest': { status: 200, json: { folders: [] } },
    'GET /api/sync/events': { status: 204, text: '' },
    'POST /api/diagrams/d1/share': {
      status: 200,
      json: { uuid: 'abcdefghijklmnopqrstu', url: `${origin}/app/display/p/abcdefghijklmnopqrstu`, sharedAt: DIAGRAM.lastModified }
    },
    'GET /api/diagrams/d1/members': { status: 200, json: { members: [] } }
  });
  // The load carries X-Axoview-Shared, which helpers/mockApi cannot set.
  await context.route((url) => url.pathname === '/api/diagrams/d1', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'ETag, X-Axoview-Shared, X-Axoview-Role',
        ETag: '"1"',
        ...(shared ? { 'X-Axoview-Shared': shared.state, 'X-Axoview-Role': shared.role } : {})
      },
      body: JSON.stringify(DIAGRAM)
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
  await page.goto('/app/d/d1');
  await expect(byAxoviewId(page, 'toolbar-share')).toBeEnabled({ timeout: 20_000 });
  return mock;
}

const toast = (page: Page, severity: 'success' | 'error') =>
  page.locator(`[data-axoview-id="notification"][data-severity="${severity}"]`).last();

function membersApi(mock: ApiMock) {
  mock.set('POST /api/diagrams/d1/members', async (request) => {
    const { email, role } = request.postDataJSON() as { email: string; role: string };
    if (email === 'bob@example.com') return { status: 201, json: { member: { ...BOB, role } } };
    return { status: 404, json: { error: 'No Axoview account uses that email', reason: 'no-account' } } as MockReply;
  });
  mock.set('DELETE /api/diagrams/d1/members/bob-2', { status: 200, json: { removed: 'bob-2' } });
  mock.set('PATCH /api/diagrams/d1/members/bob-2', async (request) => {
    const { role } = request.postDataJSON() as { role: string };
    return { status: 200, json: { member: { ...BOB, role } } };
  });
}

test('add by email: red keeps the email, green clears it and lists the person (Read only); level change; remove', async ({ page, context, baseURL }) => {
  const mock = await boot(page, context, baseURL!, null);
  membersApi(mock);
  await byAxoviewId(page, 'toolbar-share').click();
  const field = byAxoviewId(page, 'share-email-input');
  await expect(field).toBeVisible();

  await field.fill('nobody@example.com');
  await byAxoviewId(page, 'share-email-add').click();
  await expect(toast(page, 'error')).toContainText('No Axoview account uses that email');
  await expect(field).toHaveValue('nobody@example.com');

  await field.fill('bob@example.com');
  await field.press('Enter');
  await expect(toast(page, 'success')).toContainText('Shared with bob@example.com (Read only)');
  await expect(field).toHaveValue('');
  const bob = page.locator('[data-axoview-id="share-person"][data-email="bob@example.com"]');
  await expect(bob).toHaveAttribute('data-role', 'viewer');
  expect(mock.callsTo('POST /api/diagrams/d1/members').map((c) => c.body))
    .toEqual([{ email: 'nobody@example.com', role: 'viewer' }, { email: 'bob@example.com', role: 'viewer' }]);

  await page.getByLabel('Access for bob@example.com').click();
  await page.getByRole('option', { name: 'Full admin' }).click();
  await expect(toast(page, 'success')).toContainText('bob@example.com is now Full admin');
  await expect(bob).toHaveAttribute('data-role', 'admin');

  await page.getByLabel('Remove bob@example.com').click();
  await expect(toast(page, 'success')).toContainText('No longer shared with bob@example.com');
  await expect(page.locator('[data-axoview-id="share-person"]')).toHaveCount(0);
});

test('picking Full admin before adding sends it', async ({ page, context, baseURL }) => {
  const mock = await boot(page, context, baseURL!, null);
  membersApi(mock);
  await byAxoviewId(page, 'toolbar-share').click();
  await page.getByLabel('Permission level').click();
  await expect(page.getByRole('option')).toHaveText(['Read only', 'Full admin']);
  await page.getByRole('option', { name: 'Full admin' }).click();
  await byAxoviewId(page, 'share-email-input').fill('bob@example.com');
  await byAxoviewId(page, 'share-email-add').click();
  await expect(toast(page, 'success')).toContainText('Shared with bob@example.com (Full admin)');
  expect(mock.callsTo('POST /api/diagrams/d1/members')[0].body).toEqual({ email: 'bob@example.com', role: 'admin' });
});

test('a Full admin gets the whole dropdown, like the owner', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, { state: 'with-you', role: 'admin' });
  await byAxoviewId(page, 'toolbar-share').click();
  await expect(byAxoviewId(page, 'share-email-input')).toBeVisible();
  await expect(byAxoviewId(page, 'share-shared-with-you')).toHaveCount(0);
});

test('a change your agent proposed through MCP waits for you: the chip opens it, Approve makes it', async ({ page, context, baseURL }) => {
  const proposal = {
    id: 'p1',
    by: { sub: 'alice-1', agent: 'Claude Code' },
    viewId: 'p1',
    operations: [{ op: 'add_node', name: 'Cache' }, { op: 'remove_node', node: { name: 'Legacy FTP' } }],
    note: 'Add a cache',
    createdAt: '2026-11-10T07:00:00.000Z'
  };
  const mock = await boot(page, context, baseURL!, { state: 'by-you', role: 'owner' });
  mock.set('GET /api/diagrams/d1/proposals', { status: 200, json: { proposals: [proposal] } });
  mock.set('POST /api/diagrams/d1/proposals/p1/approve', { status: 200, json: { proposal: { ...proposal, status: 'approved' } } });
  await page.reload();
  const chip = byAxoviewId(page, 'proposals-chip');
  await expect(chip).toHaveText('1 to approve', { timeout: 20_000 });
  await chip.click();
  await expect(byAxoviewId(page, 'proposal')).toContainText('From Claude Code');
  await expect(byAxoviewId(page, 'proposal')).toContainText('Add a cache');
  // Checked against the page as it is: the item it would remove is not there.
  await expect(page.locator('[data-axoview-id="proposal-step"]')).toHaveCount(2);
  await expect(page.locator('[data-axoview-id="proposal-step"][data-status="not_applicable"]')).toContainText('Legacy FTP');
  await byAxoviewId(page, 'proposal-approve').click();
  await expect(toast(page, 'success')).toContainText('Change approved and made');
  await expect(chip).toHaveCount(0);
  // Approving is saving: the request carries the diagram with the step made.
  const sent = mock.callsTo('POST /api/diagrams/d1/proposals/p1/approve').map((c) => c.body as {
    applied: number; document: { items: Array<{ name: string }> };
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].applied).toBe(1);
  expect(sent[0].document.items.map((item) => item.name)).toContain('Cache');
});

test('approving when the diagram changed elsewhere: nothing is made and the change keeps waiting', async ({ page, context, baseURL }) => {
  const proposal = {
    id: 'p1',
    by: { sub: 'alice-1', agent: 'Claude Code' },
    viewId: 'p1',
    operations: [{ op: 'add_node', name: 'Cache' }],
    note: null,
    createdAt: '2026-11-10T07:00:00.000Z'
  };
  const mock = await boot(page, context, baseURL!, { state: 'by-you', role: 'owner' });
  mock.set('GET /api/diagrams/d1/proposals', { status: 200, json: { proposals: [proposal] } });
  mock.set('POST /api/diagrams/d1/proposals/p1/approve', {
    status: 409, json: { error: 'Diagram was changed since it was loaded', reason: 'conflict' }
  });
  await page.reload();
  const chip = byAxoviewId(page, 'proposals-chip');
  await expect(chip).toHaveText('1 to approve', { timeout: 20_000 });
  await chip.click();
  await byAxoviewId(page, 'proposal-approve').click();
  await expect(toast(page, 'error')).toContainText('changed somewhere else, so nothing was approved');
  await expect(chip).toHaveText('1 to approve');
  expect(mock.callsTo('POST /api/diagrams/d1/proposals/p1/approve')).toHaveLength(1);
  // The editor was not touched, so no save carries the step either.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(3000);
  const saved = mock.callsTo('PUT /api/diagrams/d1').map((c) => JSON.stringify(c.body));
  expect(saved.filter((body) => body.includes('Cache'))).toEqual([]);
});

test('shared with you as Read only: an editor link opens the read-only viewer', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await installApiMock(context, origin, {
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
        sharing: true
      }
    },
    'POST /api/auth/refresh': {
      status: 200,
      json: { accessToken: 'e2e-access-token', expiresIn: 3600, user: { sub: 'bob-2', username: 'bob' } }
    },
    'GET /api/diagrams': {
      status: 200,
      json: [{ id: 'd1', name: 'Network', lastModified: DIAGRAM.lastModified, folderId: null, shared: { role: 'viewer', ownerEmail: 'alice@example.com' } }]
    },
    'GET /api/folders': { status: 200, json: [] },
    'GET /api/tree-manifest': { status: 200, json: { folders: [] } },
    'GET /api/sync/events': { status: 204, text: '' }
  });
  await context.route((url) => url.pathname === '/api/diagrams/d1', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'ETag, X-Axoview-Shared, X-Axoview-Role',
      'X-Axoview-Shared': 'with-you',
      'X-Axoview-Role': 'viewer'
    },
    body: JSON.stringify(DIAGRAM)
  }));
  await page.goto('/app/d/d1');
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe('/app/display/d1');
  await expect(byAxoviewId(page, 'toolbar-share')).toHaveCount(0);
});
