/**
 * sync-and-reload.spec.ts — the server-backed editor features a user (and, next,
 * the AI agent) relies on, through nginx with storage ON:
 *
 *   1. a reload keeps the open diagram and page (/app/d/<id>?page=<view>, ADR 0009);
 *   2. a link to a diagram that cannot be opened says so and returns to /app;
 *   3. a change saved by someone else (here the API, the way an agent writes)
 *      shows in the open tab without a reload: content, rename, delete;
 *   4. two tabs of one browser, and two browsers ("devices"), follow each
 *      other's edits, and deleting the diagram in one closes it in the other.
 *
 * Live updates arrive over /api/sync/events (Server-Sent Events). nginx must
 * pass that stream through unbuffered, so this tier, not the dev server, is
 * where it is proven end to end.
 *
 * DOM only, like the rest of tests-docker (the bridge is absent on the image):
 * diagrams are seeded through the `api` fixture with named pages, and the page
 * tabs (`view-tab`, aria-selected, data-view-id), explorer rows, the URL and
 * the notification stack are the signals.
 */
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { FileExplorerPOM } from '../pom/FileExplorerPOM';
import { byAxoviewId } from '../helpers/selectors';
import { test, expect, seedOnboardingFlags, waitForApi, waitForAppReady } from './fixtures';

const OVERVIEW = 'e2e-page-overview';
const DETAILS = 'e2e-page-details';

type Page_ = { id: string; name: string; nodes: string[] };

/** A diagram document as the app saves it (see a stored diagram's keys). */
function diagramBody(name: string, pages: Page_[]) {
  const items = pages.flatMap((p) =>
    p.nodes.map((n) => ({ id: `${p.id}-${n}`, name: n, label: n, icon: 'block' }))
  );
  return {
    name,
    title: name,
    fitToScreen: true,
    requiredPacks: [],
    icons: [],
    colors: [{ id: 'blue', value: '#0066cc' }],
    items,
    views: pages.map((p) => ({
      id: p.id,
      name: p.name,
      items: p.nodes.map((n, i) => ({ id: `${p.id}-${n}`, tile: { x: i * 2, y: 0 } })),
      connectors: [],
      rectangles: [],
      textBoxes: []
    }))
  };
}

const TWO_PAGES: Page_[] = [
  { id: OVERVIEW, name: 'Overview', nodes: ['Alpha'] },
  { id: DETAILS, name: 'Details', nodes: ['Beta', 'Gamma'] }
];

async function seedDiagram(api: APIRequestContext, name: string): Promise<string> {
  const res = await api.post('/api/diagrams', { data: diagramBody(name, TWO_PAGES) });
  expect(res.status(), 'POST /api/diagrams (seed)').toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const tabs = (page: Page) => byAxoviewId(page, 'view-tab');
const tab = (page: Page, viewId: string) =>
  page.locator(`[data-axoview-id="view-tab"][data-view-id="${viewId}"]`);
const notice = (page: Page, text: RegExp) =>
  byAxoviewId(page, 'notification').filter({ hasText: text });

/**
 * Open a diagram by its link and wait until it is on screen and this tab's
 * live-update stream is open (a change made before that would be missed by
 * design: the stream starts at the current sequence).
 */
async function openByLink(page: Page, id: string, viewId?: string): Promise<void> {
  const loaded = waitForApi(page, 'GET', `/api/diagrams/${id}`);
  const stream = waitForApi(page, 'GET', '/api/sync/events', 20_000);
  await page.goto(`/app/d/${id}${viewId ? `?page=${viewId}` : ''}`);
  expect((await loaded).status(), `GET /api/diagrams/${id}`).toBe(200);
  expect((await stream).status(), 'GET /api/sync/events through nginx').toBe(200);
  await expect(tab(page, viewId ?? OVERVIEW)).toHaveAttribute('aria-selected', 'true', {
    timeout: 15_000
  });
}

/** Marks the document; `expectNoReload` fails if the tab has navigated since. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument = true;
  });
}
async function expectNoReload(page: Page): Promise<void> {
  const same = await page.evaluate(
    () => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument === true
  );
  expect(same, 'the update arrived without a reload').toBe(true);
}

async function expectClosedToApp(page: Page): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toMatch(/^\/app\/?$/);
  await expect(byAxoviewId(page, 'screen-empty-create')).toBeVisible({ timeout: 10_000 });
}

async function deleteFromExplorer(page: Page, name: string, id: string): Promise<void> {
  const explorer = new FileExplorerPOM(page);
  await explorer.open();
  await explorer.getRowByName(name).click({ button: 'right' });
  await byAxoviewId(page, 'file-explorer-context-menu-delete').click();
  await byAxoviewId(page, 'file-explorer-delete-confirm-dialog').waitFor({
    state: 'visible',
    timeout: 3_000
  });
  const deleted = waitForApi(page, 'DELETE', `/api/diagrams/${id}`);
  await byAxoviewId(page, 'file-explorer-delete-confirm').click();
  expect((await deleted).status(), `DELETE /api/diagrams/${id}`).toBe(200);
}

test.describe('server-backed editor: reload, links and live updates', () => {
  test('a reload keeps the open diagram and the page', async ({ page, api }) => {
    const id = await seedDiagram(api, 'E2E reload');

    await openByLink(page, id, DETAILS);
    await expect(tabs(page)).toHaveCount(2);
    await expect(tab(page, OVERVIEW)).toHaveAttribute('aria-selected', 'false');

    // Switching page rewrites the URL in place (replace, not a new entry).
    await tab(page, OVERVIEW).click();
    await expect(tab(page, OVERVIEW)).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('page'))
      .toBe(OVERVIEW);
    expect(new URL(page.url()).pathname).toBe(`/app/d/${id}`);

    const reloaded = waitForApi(page, 'GET', `/api/diagrams/${id}`);
    await page.reload();
    expect((await reloaded).status()).toBe(200);
    await expect(tab(page, OVERVIEW)).toHaveAttribute('aria-selected', 'true', {
      timeout: 15_000
    });
    await expect(tab(page, DETAILS)).toHaveAttribute('aria-selected', 'false');
    expect(new URL(page.url()).pathname).toBe(`/app/d/${id}`);
    expect(new URL(page.url()).searchParams.get('page')).toBe(OVERVIEW);

    const explorer = new FileExplorerPOM(page);
    await explorer.open();
    await expect(explorer.getRowByName('E2E reload')).toHaveAttribute('aria-current', 'true');
  });

  // Regression (2026-11-09, "page id keeps changing and blinks"): a diagram
  // stored without pages (created blank, never edited) got a new random page
  // id on every load, so the URL's ?page= changed on each open and reload.
  test('a blank diagram keeps its page id across reloads, and the URL holds still', async ({
    page,
    api
  }) => {
    const res = await api.post('/api/diagrams', {
      data: { ...diagramBody('E2E blank', []), views: [] }
    });
    expect(res.status(), 'POST /api/diagrams (blank)').toBe(201);
    const id = ((await res.json()) as { id: string }).id;

    // The page in the URL once the diagram is on screen (its one tab shows it).
    const pageIdAfterLoad = async () => {
      await expect
        .poll(() => new URL(page.url()).searchParams.get('page'), { timeout: 15_000 })
        .toBeTruthy();
      const viewId = new URL(page.url()).searchParams.get('page');
      await expect(tabs(page)).toHaveCount(1);
      await expect(tabs(page).first()).toHaveAttribute('data-view-id', viewId as string);
      return viewId;
    };

    const loaded = waitForApi(page, 'GET', `/api/diagrams/${id}`);
    await page.goto(`/app/d/${id}`);
    expect((await loaded).status()).toBe(200);
    const first = await pageIdAfterLoad();
    expect(first).toBeTruthy();

    const reloaded = waitForApi(page, 'GET', `/api/diagrams/${id}`);
    await page.reload();
    expect((await reloaded).status()).toBe(200);
    expect(await pageIdAfterLoad()).toBe(first);

    // Left open with no one touching it, the URL does not move.
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      seen.add(page.url());
      await page.waitForTimeout(300);
    }
    expect([...seen]).toEqual([page.url()]);
  });

  test('a link to a diagram that cannot be opened returns to /app with a notice', async ({
    page,
    apiLog
  }) => {
    const missing = 'diagram_e2e_missing';
    apiLog.allow((e) => e.method === 'GET' && e.path === `/api/diagrams/${missing}` && e.status === 404);

    const lookedUp = waitForApi(page, 'GET', `/api/diagrams/${missing}`);
    await page.goto(`/app/d/${missing}?page=whatever`);
    expect((await lookedUp).status()).toBe(404);
    await expect(notice(page, /can't be opened/i)).toBeVisible({ timeout: 10_000 });
    await expect(notice(page, /can't be opened/i)).toHaveAttribute('data-severity', 'warning');
    await expectClosedToApp(page);
  });

  test('a change saved elsewhere shows without a reload: content, rename, delete', async ({
    page,
    api,
    apiLog
  }) => {
    test.setTimeout(90_000);
    const id = await seedDiagram(api, 'E2E live');
    // The tab may re-read the diagram while it is being deleted.
    apiLog.allow((e) => e.path === `/api/diagrams/${id}` && e.status === 404);

    await openByLink(page, id);
    await markDocument(page);
    const explorer = new FileExplorerPOM(page);
    await explorer.open();
    await expect(explorer.getRowByName('E2E live')).toBeVisible();

    // Content: a whole-document save from outside the browser (no Origin, no
    // device id), as an agent's write would arrive.
    const pages = [...TWO_PAGES, { id: 'e2e-page-agent', name: 'Added elsewhere', nodes: ['Delta'] }];
    const put = await api.put(`/api/diagrams/${id}`, { data: diagramBody('E2E live', pages) });
    expect(put.status(), 'PUT /api/diagrams/:id (elsewhere)').toBe(200);
    await expect(tabs(page)).toHaveCount(3, { timeout: 15_000 });
    await expect(tab(page, 'e2e-page-agent')).toHaveText(/Added elsewhere/);
    // The page on screen stays the one the user was on.
    await expect(tab(page, OVERVIEW)).toHaveAttribute('aria-selected', 'true');

    // Rename.
    const patch = await api.patch(`/api/diagrams/${id}`, {
      data: { name: 'E2E live renamed', title: 'E2E live renamed' }
    });
    expect(patch.status(), 'PATCH /api/diagrams/:id (elsewhere)').toBe(200);
    await expect(explorer.getRowByName('E2E live renamed')).toBeVisible({ timeout: 15_000 });
    await expectNoReload(page);

    // Delete: the open diagram closes and the user is told why.
    const del = await api.delete(`/api/diagrams/${id}`);
    expect(del.status(), 'DELETE /api/diagrams/:id (elsewhere)').toBe(200);
    await expect(notice(page, /deleted/i)).toBeVisible({ timeout: 15_000 });
    await expectClosedToApp(page);
    await expectNoReload(page);
  });

  test('two tabs follow each other; deleting in one closes the other', async ({
    page,
    context,
    api,
    apiLog
  }) => {
    test.setTimeout(120_000);
    const id = await seedDiagram(api, 'E2E two tabs');
    apiLog.allow((e) => e.path === `/api/diagrams/${id}` && e.status === 404);

    const other = await context.newPage();
    await openByLink(page, id);
    await openByLink(other, id);
    await markDocument(other);

    // A page added in the first tab autosaves and appears in the second.
    await byAxoviewId(page, 'view-tabs-add').click();
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(other)).toHaveCount(3, { timeout: 20_000 });

    // A rename in the first tab's explorer reaches the second's explorer.
    const explorer = new FileExplorerPOM(page);
    await explorer.open();
    await explorer.renameDiagram('E2E two tabs', 'E2E two tabs renamed');
    const otherExplorer = new FileExplorerPOM(other);
    await otherExplorer.open();
    await expect(otherExplorer.getRowByName('E2E two tabs renamed')).toBeVisible({
      timeout: 15_000
    });

    await deleteFromExplorer(page, 'E2E two tabs renamed', id);
    await expectClosedToApp(page);
    await expect(notice(other, /deleted/i)).toBeVisible({ timeout: 15_000 });
    await expectClosedToApp(other);
    await expectNoReload(other);
  });

  test('two devices follow each other; deleting on one closes it on the other', async ({
    page,
    browser,
    api,
    apiLog
  }) => {
    test.setTimeout(120_000);
    const id = await seedDiagram(api, 'E2E two devices');
    apiLog.allow((e) => e.path === `/api/diagrams/${id}` && e.status === 404);

    const device: BrowserContext = await browser.newContext();
    try {
      apiLog.watchContext(device);
      await seedOnboardingFlags(device);
      const other = await device.newPage();
      await other.goto('/app');
      await waitForAppReady(other);

      await openByLink(page, id);
      await openByLink(other, id, DETAILS);
      await markDocument(other);

      await byAxoviewId(page, 'view-tabs-add').click();
      await expect(tabs(page)).toHaveCount(3);
      await expect(tabs(other)).toHaveCount(3, { timeout: 20_000 });
      // The other device stays on the page it was looking at.
      await expect(tab(other, DETAILS)).toHaveAttribute('aria-selected', 'true');

      await deleteFromExplorer(page, 'E2E two devices', id);
      await expectClosedToApp(page);
      await expect(notice(other, /deleted/i)).toBeVisible({ timeout: 15_000 });
      await expectClosedToApp(other);
      await expectNoReload(other);
    } finally {
      await device.close();
    }
  });
});
