/**
 * The WebRTC path of live collaboration (docs/architecture/yjs-collaboration.md):
 * two devices on one diagram open a peer data channel, signalled over the
 * authenticated HTTP + SSE routes, and Yjs updates travel on it. The STUN
 * servers the app is configured with are Google's and Cloudflare's.
 *
 * collaboration.spec.ts covers the other half: with WebRTC unavailable, the
 * same edits converge over HTTP + SSE alone.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test.setTimeout(120_000);
const TOKEN = 'test-user:alice-1';

type Probe = { ice: string[]; open: number; received: number };

async function device(context: BrowserContext): Promise<Page> {
  await context.addInitScript(() => {
    localStorage.setItem('axoview-lazy-loading-welcome-dismissed', 'true');
    localStorage.setItem('axoview-show-drag-hint', 'false');
    // Watch the peer connections the app opens, without changing them.
    const probe = { ice: [] as string[], open: 0, received: 0 };
    (window as unknown as { __rtc: typeof probe }).__rtc = probe;
    const Native = window.RTCPeerConnection;
    const watch = (channel: RTCDataChannel) => {
      channel.addEventListener('open', () => { probe.open += 1; });
      channel.addEventListener('message', () => { probe.received += 1; });
    };
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        for (const server of config?.iceServers ?? []) probe.ice.push(...([] as string[]).concat(server.urls));
        this.addEventListener('datachannel', (event) => watch(event.channel));
      }
      createDataChannel(label: string, init?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, init);
        watch(channel);
        return channel;
      }
    };
  });
  await context.route('**/api/auth/refresh', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ accessToken: TOKEN, expiresIn: 3600, user: { sub: 'alice-1', username: 'alice', email: 'alice@example.com' } })
  }));
  return context.newPage();
}
const probeOf = (page: Page) => page.evaluate(() => (window as unknown as { __rtc: Probe }).__rtc);

test('two devices open a WebRTC data channel and edits travel on it', async ({ browser, baseURL }) => {
  const created = await fetch(`${baseURL}/api/diagrams`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Peers', icons: [], colors: [{ id: 'c', value: '#0066cc' }], items: [{ id: 'web', name: 'Web' }],
      views: [{ id: 'p1', name: 'Page 1', items: [{ id: 'web', tile: { x: 0, y: 0 } }], connectors: [] }]
    })
  });
  const { id } = await created.json();

  const leftContext = await browser.newContext();
  const rightContext = await browser.newContext();
  const left = await device(leftContext);
  const right = await device(rightContext);
  await left.goto(`${baseURL}/app/d/${id}`);
  await expect(left.locator('[data-axoview-id="toolbar-share"]')).toBeEnabled({ timeout: 30_000 });
  await right.goto(`${baseURL}/app/d/${id}`);
  await expect(right.locator('[data-axoview-id="toolbar-share"]')).toBeEnabled({ timeout: 30_000 });

  // The second device announces itself; the first offers; a channel opens on both.
  await expect.poll(async () => (await probeOf(left)).open, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await probeOf(right)).open, { timeout: 30_000 }).toBeGreaterThan(0);
  expect([...new Set((await probeOf(left)).ice)].sort()).toEqual(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']);

  // An edit on one device arrives on the other over that channel, and shows.
  const before = (await probeOf(right)).received;
  await left.locator('[data-axoview-id="view-tabs-add"]').click();
  await expect.poll(async () => (await probeOf(right)).received, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(right.getByText('Page 2', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  await leftContext.close();
  await rightContext.close();
});
