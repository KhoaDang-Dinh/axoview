/**
 * batched-upload.spec.ts — every change uploads at once, and the browser keeps
 * a copy (stores/draftStore.ts, hooks/useAutoSave.ts). Uploads were held for
 * up to 30 s while one browser had the workspace open (ADR 0054); the owner
 * reverted that on 2026-11-13 so every change goes live (ADR 0054 addendum):
 *
 *   - each pause uploads, alone or not; closing the tab right after an edit
 *     still uploads it (keepalive);
 *   - a second tab of the same browser shows the edit at once, with no
 *     download of the diagram;
 *   - edits whose upload never got out (the network down) come back on the
 *     next open: restored when the server still has the version they were
 *     made from, offered when it has moved on.
 *
 * DOM only, through nginx with storage ON, like the rest of tests-docker.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { byAxoviewId } from '../helpers/selectors';
import { placeFirstIcon, test, expect, waitForApi } from './fixtures';

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
 * The network goes down for uploads: every PUT the page sends from now on
 * fails, the keepalive flush on `pagehide` included. Installed BEFORE the edit,
 * since an edit now uploads within seconds. (Page or context routing cannot
 * stand in: a keepalive request outlives the page, and Chromium sends it once
 * the context is back online. A renderer crash takes this headless browser
 * down whole.)
 */
async function failUploads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET').toUpperCase() === 'PUT'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : original(input, init);
  });
}

/** The edit is kept in the browser and its upload failed ("Save failed"); then the tab closes. */
async function closeWithEditsUnsent(page: Page): Promise<void> {
  await expect(page.getByText('Save failed')).toBeVisible({ timeout: 8_000 });
  await page.close({ runBeforeUnload: true });
}

async function itemsOnServer(api: APIRequestContext, id: string): Promise<number> {
  const res = await api.get(`/api/diagrams/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: unknown[] }).items.length;
}

test.describe('every change uploads at once; the browser keeps a copy', () => {
  test('alone in the workspace, each edit is on the server within seconds', async ({ page, api }) => {
    let id = '';
    const puts = countPuts(page, () => id);
    id = await createDiagram(page);

    // Three edits, each followed by its upload: no 30 s batch any more.
    for (const [n, x] of [340, 430, 520].entries()) {
      await placeFirstIcon(page, x, 280);
      await expect.poll(() => itemsOnServer(api, id), { timeout: 6_000, intervals: [250] }).toBe(n + 1);
      await expect(savedInBrowser(page)).toBeHidden({ timeout: 6_000 });
    }
    expect(puts.count()).toBeGreaterThanOrEqual(3);
  });

  test('closing the tab right after an edit uploads it (keepalive)', async ({ page, context, api }) => {
    const id = await createDiagram(page);
    // A second page keeps the context (and its network) alive after the first closes.
    const keeper = await context.newPage();
    await placeFirstIcon(page);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => itemsOnServer(api, id), { timeout: 10_000 }).toBe(1);
    await keeper.close();
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
    // The checkpoint reaches the second tab over the tab channel; the upload's
    // sync event that follows carries content it already shows.
    await expect(second.getByText('Page 2', { exact: true }).first()).toBeVisible({ timeout: 6_000 });
    expect(downloads).toBe(0);
  });

  test('a tab closed before its upload got out: the edits come back on the next open', async ({ page, context, api }) => {
    const id = await createDiagram(page);
    await failUploads(page);
    await placeFirstIcon(page);
    await placeFirstIcon(page, 460, 300);
    await closeWithEditsUnsent(page);
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
    await failUploads(page);
    await placeFirstIcon(page);
    await closeWithEditsUnsent(page);

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

  // Regression (2026-11-09, "the page keeps creating a new id for an unsaved
  // page"): while edits wait in the browser, the server copy lacks them. A
  // new diagram is stored without pages there, and a new page is missing, so
  // each reload used to land on a freshly minted page id. Uploads now go at
  // once, so the edits are held back here by failing them.
  test.describe('a page that has not reached the server keeps its id', () => {
    const pageId = (page: Page) => new URL(page.url()).searchParams.get('page');
    const selectedTab = (page: Page) =>
      page.locator('[data-axoview-id="view-tab"][aria-selected="true"]');

    /** Reload, then the URL and the selected tab both name `expected`. */
    async function expectPageAfterReload(page: Page, id: string, expected: string): Promise<void> {
      const loaded = waitForApi(page, 'GET', `/api/diagrams/${id}`);
      await page.reload();
      expect((await loaded).status()).toBe(200);
      await expect(selectedTab(page)).toHaveAttribute('data-view-id', expected, { timeout: 15_000 });
      expect(pageId(page)).toBe(expected);
    }

    test('a new diagram, not uploaded yet: the same page id on every reload', async ({ page, api }) => {
      await failUploads(page);
      const id = await createDiagram(page);
      await expect.poll(() => pageId(page), { timeout: 10_000 }).toBeTruthy();
      const first = pageId(page) as string;
      const stored = (await (await api.get(`/api/diagrams/${id}`)).json()) as { views: unknown[] };
      expect(stored.views, 'the server copy has no page yet').toEqual([]);

      for (let i = 0; i < 3; i += 1) await expectPageAfterReload(page, id, first);
    });

    test('a new page, not uploaded yet: a reload stays on it', async ({ page }) => {
      const id = await createDiagram(page);
      await expect.poll(() => pageId(page), { timeout: 10_000 }).toBeTruthy();
      const first = pageId(page);
      await failUploads(page);
      await byAxoviewId(page, 'view-tabs-add').click();
      await expect.poll(() => pageId(page)).not.toBe(first);
      const added = pageId(page) as string;
      await expect(page.getByText('Save failed')).toBeVisible({ timeout: 8_000 });

      await expectPageAfterReload(page, id, added);
      await expect(byAxoviewId(page, 'view-tab')).toHaveCount(2);
    });

    test('a new page whose tab closed before its upload: reopened on that page', async ({ page, context, api }) => {
      const id = await createDiagram(page);
      await expect.poll(() => pageId(page), { timeout: 10_000 }).toBeTruthy();
      const first = pageId(page);
      await failUploads(page);
      await byAxoviewId(page, 'view-tabs-add').click();
      await expect.poll(() => pageId(page)).not.toBe(first);
      const added = pageId(page) as string;
      const link = page.url();
      await closeWithEditsUnsent(page);
      const stored = (await (await api.get(`/api/diagrams/${id}`)).json()) as { views: { id: string }[] };
      expect(stored.views.map((v) => v.id), 'the server never got the new page').not.toContain(added);

      const reopened = await context.newPage();
      await reopened.goto(link);
      await expect(notice(reopened, /Restored edits from this browser/)).toBeVisible({ timeout: 15_000 });
      await expect(selectedTab(reopened)).toHaveAttribute('data-view-id', added);
      expect(pageId(reopened)).toBe(added);
      await expect(byAxoviewId(reopened, 'view-tab')).toHaveCount(2);

      // Left alone afterwards, the URL holds still.
      const seen = new Set<string>();
      for (let i = 0; i < 10; i += 1) {
        seen.add(reopened.url());
        await reopened.waitForTimeout(300);
      }
      expect([...seen]).toEqual([reopened.url()]);
    });
  });
});
