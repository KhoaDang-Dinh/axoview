/**
 * batched-upload.spec.ts — fewer writes while one browser has the workspace
 * open (stores/draftStore.ts, hooks/useAutoSave.ts, services/sync/presence.ts):
 *
 *   - alone, each 2 s pause is a checkpoint saved in the browser ("Saved in
 *     this browser"); the upload follows once per batch window with the latest;
 *   - hiding the tab, or another browser opening the workspace, uploads at once;
 *   - a second tab of the same browser shows the edit at once, with no
 *     download of the diagram;
 *   - edits whose upload never got out (the tab closed with the network down)
 *     come back on the next open: restored when the server still has the
 *     version they were made from, offered when it has moved on.
 *
 * DOM only, through nginx with storage ON, like the rest of tests-docker.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { byAxoviewId } from '../helpers/selectors';
import { placeFirstIcon, seedOnboardingFlags, test, expect, waitForApi, waitForAppReady } from './fixtures';

const BATCH_MS = 30_000;

/** PUT /api/diagrams/<id> requests from `page`, as they are sent. */
function countPuts(page: Page, id: () => string): { count: () => number } {
  let n = 0;
  page.on('request', (req) => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname === `/api/diagrams/${id()}`) n += 1;
  });
  return { count: () => n };
}

/** Create a diagram from the empty state (the fixture already booted /app, sync stream included). */
async function createDiagram(page: Page): Promise<string> {
  const created = waitForApi(page, 'POST', '/api/diagrams');
  await byAxoviewId(page, 'screen-empty-create').click();
  const res = await created;
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const savedInBrowser = (page: Page) => byAxoviewId(page, 'status-saved-in-browser');
// MUI's Alert carries role="alert" (NotificationStack.tsx).
const notice = (page: Page, text: RegExp) => page.getByRole('alert').filter({ hasText: text });

/**
 * The tab closes with the network down for uploads: every PUT the page sends
 * fails, the keepalive flush on `pagehide` included. (Page or context routing
 * cannot stand in: a keepalive request outlives the page, and Chromium sends
 * it once the context is back online. A renderer crash takes this headless
 * browser down whole.)
 */
async function closeWithUploadsFailing(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET').toUpperCase() === 'PUT'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : original(input, init);
  });
  await page.close({ runBeforeUnload: true });
}

async function itemsOnServer(api: APIRequestContext, id: string): Promise<number> {
  const res = await api.get(`/api/diagrams/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: unknown[] }).items.length;
}

test.describe('batched uploads while one browser has the workspace open', () => {
  test('edits are saved in the browser and uploaded once per batch window', async ({ page, api }) => {
    test.setTimeout(90_000);
    let id = '';
    const puts = countPuts(page, () => id);
    id = await createDiagram(page);

    // Three edits, each followed by a pause long enough for an autosave.
    for (const x of [340, 430, 520]) {
      await placeFirstIcon(page, x, 280);
      await expect(savedInBrowser(page)).toBeVisible({ timeout: 6_000 });
      await page.waitForTimeout(2_500);
    }
    expect(puts.count(), 'nothing uploaded yet: three checkpoints in the browser').toBe(0);
    expect(await itemsOnServer(api, id)).toBe(0);

    // One upload, with the latest checkpoint, by the end of the window.
    await expect.poll(() => puts.count(), { timeout: BATCH_MS + 5_000, intervals: [500] }).toBe(1);
    await expect(savedInBrowser(page)).toBeHidden();
    expect(await itemsOnServer(api, id)).toBe(3);
  });

  test('hiding the tab uploads at once', async ({ page, api }) => {
    let id = '';
    const puts = countPuts(page, () => id);
    id = await createDiagram(page);
    await placeFirstIcon(page);
    await expect(savedInBrowser(page)).toBeVisible({ timeout: 6_000 });
    expect(puts.count()).toBe(0);

    const uploaded = waitForApi(page, 'PUT', `/api/diagrams/${id}`, 5_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await uploaded).status()).toBe(200);
    expect(await itemsOnServer(api, id)).toBe(1);
  });

  test('closing the tab uploads what is queued (keepalive)', async ({ page, context, api }) => {
    const id = await createDiagram(page);
    // A second page keeps the context (and its network) alive after the first closes.
    const keeper = await context.newPage();
    await placeFirstIcon(page);
    await expect(savedInBrowser(page)).toBeVisible({ timeout: 6_000 });
    expect(await itemsOnServer(api, id)).toBe(0);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => itemsOnServer(api, id), { timeout: 10_000 }).toBe(1);
    await keeper.close();
  });

  test('another browser opening the workspace: edits upload at once again', async ({ page, browser, api, apiLog }) => {
    let id = '';
    const puts = countPuts(page, () => id);
    id = await createDiagram(page);

    const other = await browser.newContext();
    try {
      apiLog.watchContext(other);
      await seedOnboardingFlags(other);
      const phone = await other.newPage();
      const joined = waitForApi(phone, 'GET', '/api/sync/events', 20_000);
      await phone.goto('/app');
      await waitForAppReady(phone);
      await joined;
      // The phone's join reaches this tab over the stream; give it a moment.
      await page.waitForTimeout(1_500);

      const uploaded = waitForApi(page, 'PUT', `/api/diagrams/${id}`, 8_000);
      await placeFirstIcon(page);
      expect((await uploaded).status()).toBe(200);
      await expect(savedInBrowser(page)).toBeHidden();
      expect(puts.count()).toBe(1);
      expect(await itemsOnServer(api, id)).toBe(1);
    } finally {
      await other.close();
    }
  });

  test('a second tab of the same browser shows the edit at once, without downloading it', async ({ page, context }) => {
    const id = await createDiagram(page);
    const second = await context.newPage();
    const opened = waitForApi(second, 'GET', `/api/diagrams/${id}`);
    const stream = waitForApi(second, 'GET', '/api/sync/events', 20_000);
    await second.goto(`/app/d/${id}`);
    await opened;
    await stream;
    let downloads = 0;
    second.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === `/api/diagrams/${id}`) downloads += 1;
    });

    await expect(second.getByText('Page 2', { exact: true })).toHaveCount(0);
    await byAxoviewId(page, 'view-tabs-add').click();
    // The checkpoint reaches the second tab over the tab channel within the
    // autosave pause, long before any batched upload.
    await expect(second.getByText('Page 2', { exact: true }).first()).toBeVisible({ timeout: 6_000 });
    expect(downloads).toBe(0);
  });

  test('a tab closed before its upload got out: the edits come back on the next open', async ({ page, context, api }) => {
    const id = await createDiagram(page);
    await placeFirstIcon(page);
    await placeFirstIcon(page, 460, 300);
    await expect(savedInBrowser(page)).toBeVisible({ timeout: 6_000 });
    await closeWithUploadsFailing(page);
    expect(await itemsOnServer(api, id)).toBe(0);

    const reopened = await context.newPage();
    const uploaded = waitForApi(reopened, 'PUT', `/api/diagrams/${id}`, 15_000);
    await reopened.goto(`/app/d/${id}`);
    await expect(notice(reopened, /Restored edits from this browser/)).toBeVisible({ timeout: 15_000 });
    expect((await uploaded).status()).toBe(200);
    expect(await itemsOnServer(api, id)).toBe(2);
  });

  test('the diagram changed elsewhere meanwhile: the edits are offered, not forced', async ({ page, context, api }) => {
    const id = await createDiagram(page);
    await placeFirstIcon(page);
    await expect(savedInBrowser(page)).toBeVisible({ timeout: 6_000 });
    await closeWithUploadsFailing(page);

    // Another device saves a different change (a new version).
    const current = await api.get(`/api/diagrams/${id}`);
    const etag = current.headers()['etag'];
    const doc = await current.json();
    const elsewhere = await api.put(`/api/diagrams/${id}`, {
      data: { ...doc, title: 'Changed elsewhere' },
      headers: etag ? { 'If-Match': etag } : {}
    });
    expect(elsewhere.status()).toBe(200);

    const reopened = await context.newPage();
    await reopened.goto(`/app/d/${id}`);
    const offer = notice(reopened, /never reached the server/);
    await expect(offer).toBeVisible({ timeout: 15_000 });
    expect(await itemsOnServer(api, id)).toBe(0);

    const uploaded = waitForApi(reopened, 'PUT', `/api/diagrams/${id}`, 10_000);
    await offer.getByRole('button', { name: 'Restore my edits' }).click();
    expect((await uploaded).status()).toBe(200);
    expect(await itemsOnServer(api, id)).toBe(1);
  });
});
