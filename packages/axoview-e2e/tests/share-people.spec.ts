/**
 * Sharing a diagram by email from the Share dropdown (ADR 0057 §5, owner
 * decisions 2026-11-09/10): the email field under the link, a green pop-up
 * on success (field cleared, person listed), a red one on every failure
 * (email kept), removing a person, and the note shown on a diagram someone
 * else shared with you.
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
const BOB = { sub: 'bob-2', email: 'bob@example.com', role: 'editor', addedAt: '2026-11-10T00:00:00.000Z' };

async function boot(page: Page, context: BrowserContext, baseURL: string, shared: 'by-you' | 'with-you' | null) {
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
        ...(shared === 'with-you' ? { shared: { role: 'editor', ownerEmail: 'alice@example.com' } } : {})
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
        'access-control-expose-headers': 'ETag, X-Axoview-Shared',
        ETag: '"1"',
        ...(shared ? { 'X-Axoview-Shared': shared } : {})
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
    const { email } = request.postDataJSON() as { email: string };
    if (email === 'bob@example.com') return { status: 201, json: { member: BOB } };
    return { status: 404, json: { error: 'No Axoview account uses that email', reason: 'no-account' } } as MockReply;
  });
  mock.set('DELETE /api/diagrams/d1/members/bob-2', { status: 200, json: { removed: 'bob-2' } });
}

test('add by email: red keeps the email, green clears it and lists the person; remove works', async ({ page, context, baseURL }) => {
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
  await expect(toast(page, 'success')).toContainText('Shared with bob@example.com');
  await expect(field).toHaveValue('');
  await expect(page.locator('[data-axoview-id="share-person"][data-email="bob@example.com"]')).toBeVisible();
  expect(mock.callsTo('POST /api/diagrams/d1/members').map((c) => (c.body as { email: string }).email))
    .toEqual(['nobody@example.com', 'bob@example.com']);

  await page.getByLabel('Remove bob@example.com').click();
  await expect(toast(page, 'success')).toContainText('No longer shared with bob@example.com');
  await expect(page.locator('[data-axoview-id="share-person"]')).toHaveCount(0);
});

test('a diagram shared with you: the dropdown says so, with no link and no email field', async ({ page, context, baseURL }) => {
  const mock = await boot(page, context, baseURL!, 'with-you');
  await byAxoviewId(page, 'toolbar-share').click();
  await expect(byAxoviewId(page, 'share-shared-with-you')).toBeVisible();
  await expect(byAxoviewId(page, 'share-email-input')).toHaveCount(0);
  expect(mock.callsTo('POST /api/diagrams/d1/share')).toHaveLength(0);
});
