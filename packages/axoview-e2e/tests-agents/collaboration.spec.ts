import { test, expect, type BrowserContext } from '@playwright/test';

const TOKEN = 'test-user:alice-1';
async function device(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
    // Force the entire session to use the durable HTTP + SSE transport.
    Object.defineProperty(window, 'RTCPeerConnection', { value: undefined });
  });
  await context.route('**/api/auth/refresh', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ accessToken: TOKEN, expiresIn: 3600, user: { sub: 'alice-1', username: 'alice', email: 'alice@example.com' } }) }));
  return context.newPage();
}

test('SSE-only concurrent edits converge and undo preserves the other author', async ({ browser, baseURL }) => {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(baseURL + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.ok).toBeTruthy(); return response.json();
  };
  const { id } = await api('POST', '/api/diagrams', { title: 'Concurrent', icons: [], colors: [{ id: 'c', value: '#0066cc' }],
    items: [{ id: 'web', name: 'Web' }], views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }], connectors: [] }] });
  const leftContext = await browser.newContext(), rightContext = await browser.newContext();
  const left = await device(leftContext), right = await device(rightContext);
  await Promise.all([left.goto(`${baseURL}/app/d/${id}`), right.goto(`${baseURL}/app/d/${id}`)]);
  for (const page of [left, right]) {
    await expect(page.locator('[data-axoview-id="toolbar-share"]')).toBeEnabled();
    await expect.poll(async () => page.evaluate(() => indexedDB.databases().then(dbs => dbs.some(db => db.name?.startsWith('axoview:yjs:'))))).toBe(true);
  }
  await Promise.all([left.locator('[data-axoview-id="view-tabs-add"]').click(), right.locator('[data-axoview-id="view-tabs-add"]').click()]);
  const stored = () => api('GET', `/api/diagrams/${id}`);
  await expect.poll(async () => (await stored()).views.length).toBe(3);
  await expect.poll(async () => (await left.locator('[data-axoview-id="view-tabs-add"]').count())).toBe(1);
  // Let both acknowledgements arrive, then selectively undo only the left edit.
  await expect(left.getByText('A collaborator updated this diagram', { exact: true }).first()).toBeVisible();
  await left.keyboard.press('Control+z');
  await expect.poll(async () => (await stored()).views.length).toBe(2);
  await right.reload();
  await expect(right.locator('[data-axoview-id="toolbar-share"]')).toBeEnabled();
  expect((await stored()).views.length).toBe(2);
  await leftContext.close(); await rightContext.close();
});

test('AI bubble has a 3px animated edge and an on-screen help tooltip after dragging', async ({ browser, baseURL }) => {
  const context = await browser.newContext(); const page = await device(context);
  await page.route('**/api/config', async route => {
    const response = await route.fetch(), config = await response.json();
    await route.fulfill({ response, json: { ...config, ai: { ...config.ai, chatEnabled: true, guestEnabled: true } } });
  });
  await page.goto(`${baseURL}/app`);
  const bubble = page.locator('[data-axoview-id="ai-bubble"]');
  await expect(bubble).toBeVisible(); await bubble.hover();
  await expect(page.getByRole('tooltip')).toHaveText('AI help');
  expect(await bubble.evaluate(el => getComputedStyle(el, '::before').padding)).toBe('3px');
  expect(await bubble.evaluate(el => getComputedStyle(el, '::before').animationName)).not.toBe('none');
  const box = (await bubble.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(45, 45, { steps: 8 }); await page.mouse.up();
  await bubble.hover(); await expect(page.getByRole('tooltip')).toBeVisible();
  const tooltip = (await page.getByRole('tooltip').boundingBox())!;
  expect(tooltip.x).toBeGreaterThanOrEqual(0); expect(tooltip.y).toBeGreaterThanOrEqual(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await bubble.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
  await page.screenshot({ path: test.info().outputPath('ai-help.png') });
  await context.close();
});
