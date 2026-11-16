/**
 * Every change to a diagram goes live (owner decision 2026-11-13, ADR 0054
 * addendum): it is uploaded a second or two after the edit, not held in the
 * browser for a 30 s batch, and another device showing the diagram updates
 * on its own. That holds when the device making it is alone, too.
 *
 * Built app, real backend and sync stream (agents/stack.mjs); two browser
 * contexts are two devices (they share no tab channel).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test.setTimeout(120_000);
const TOKEN = 'test-user:alice-1';
const byId = (page: Page, name: string) => page.locator(`[data-axoview-id="${name}"]`);

async function device(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
    localStorage.setItem('axoview-show-drag-hint', 'false');
  });
  await context.route('**/api/auth/refresh', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accessToken: TOKEN, expiresIn: 3600, user: { sub: 'alice-1', username: 'alice', email: 'alice@example.com' } })
  }));
  return context.newPage();
}

test('every change uploads within seconds and shows on another device by itself', async ({ browser, baseURL }) => {
  const base = baseURL!;
  const api = async (method: string, path: string, body?: unknown) => (await (await fetch(base + path, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  })).json()) as any;
  const { id } = await api('POST', '/api/diagrams', {
    title: 'Live', name: 'Live', icons: [], colors: [{ id: 'c1', value: '#0066cc' }], items: [{ id: 'web', name: 'Web' }],
    views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }], connectors: [] }]
  });
  const pagesStored = async () => (await api('GET', `/api/diagrams/${id}`)).views.length as number;

  // Alone: nobody else has the workspace open, and the edit still goes up at once.
  const laptopContext = await browser.newContext();
  const laptop = await device(laptopContext);
  await laptop.goto(`${base}/app/d/${id}`);
  await expect(byId(laptop, 'toolbar-share')).toBeEnabled({ timeout: 30_000 });
  await byId(laptop, 'view-tabs-add').click();
  await expect.poll(pagesStored, { timeout: 8_000, message: 'uploaded within seconds, not after a 30 s batch' }).toBe(2);
  await expect(byId(laptop, 'status-saved-in-browser')).toBeHidden({ timeout: 8_000 });

  // A second device on the same diagram: each change there shows here by itself, and back.
  const phoneContext = await browser.newContext();
  const phone = await device(phoneContext);
  await phone.goto(`${base}/app/d/${id}`);
  await expect(byId(phone, 'toolbar-share')).toBeEnabled({ timeout: 30_000 });
  await expect(phone.getByText('Page 2', { exact: true }).first()).toBeVisible();

  await byId(laptop, 'view-tabs-add').click();
  await expect(phone.getByText('Page 3', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await byId(phone, 'view-tabs-add').click();
  await expect(laptop.getByText('Page 4', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  expect(await pagesStored()).toBe(4);

  await laptopContext.close();
  await phoneContext.close();
});
