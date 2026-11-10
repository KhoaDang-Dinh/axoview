/**
 * Signing in or out in one tab moves the browser's other app tabs
 * (owner decision, 2026-11-10), over the real BroadcastChannel:
 *   - signed in: every tab on the sign-in screen takes the session and goes
 *     to /app, whatever link it was on;
 *   - signed out: every app tab goes to the landing page at /.
 * (The session expiring does the same as signing out; the store's unit tests
 * cover it: cognitoSessionStore.sessionEnd.test.ts.)
 *
 * The API is scripted (helpers/mockApi.ts); Cognito's hosted page is never
 * reached: the signing-in tab arrives at /app/auth/callback as if Cognito had
 * sent it back, with the PKCE state it would have stored.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { installApiMock, type ApiMock, type MockReply } from '../helpers/mockApi';
import { byAxoviewId } from '../helpers/selectors';

const SIGNED_IN: MockReply = {
  status: 200,
  json: { accessToken: 'e2e-access-token', expiresIn: 3600, user: { sub: 'e2e-user' } }
};
const SIGNED_OUT: MockReply = { status: 401, json: { error: 'Session expired' } };

async function script(context: BrowserContext, baseURL: string, session: 'signed-in' | 'signed-out'): Promise<ApiMock> {
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
        serverStorage: false
      }
    },
    'POST /api/auth/refresh': session === 'signed-in' ? SIGNED_IN : SIGNED_OUT,
    'POST /api/auth/logout': { status: 204, text: '' },
    'POST /api/auth/callback': SIGNED_IN
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

const editor = (page: Page) => byAxoviewId(page, 'screen-empty-create');
const signInScreen = (page: Page) => byAxoviewId(page, 'cognito-sign-in-google');
const onLanding = (page: Page) =>
  expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe('/');

test('signing out in one tab sends every app tab to the landing page', async ({ context, baseURL }) => {
  await script(context, baseURL!, 'signed-in');
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto('/app');
  await b.goto('/app');
  await expect(editor(a)).toBeVisible({ timeout: 20_000 });
  await expect(editor(b)).toBeVisible({ timeout: 20_000 });

  await byAxoviewId(a, 'cognito-account').click();
  await a.getByRole('menuitem', { name: 'Sign out' }).click();

  await onLanding(a);
  await onLanding(b);
  await expect(b.locator('h1')).toContainText('isometric');
});

test('signing in in one tab sends the tabs on the sign-in screen to /app', async ({ context, baseURL }) => {
  const mock = await script(context, baseURL!, 'signed-out');
  const waiting = await context.newPage();
  const onLink = await context.newPage();
  await waiting.goto('/app');
  await onLink.goto('/app/display/missing-diagram');
  await expect(signInScreen(waiting)).toBeVisible({ timeout: 20_000 });
  await expect(signInScreen(onLink)).toBeVisible({ timeout: 20_000 });

  const signer = await context.newPage();
  await signer.goto('/app');
  await expect(signInScreen(signer)).toBeVisible({ timeout: 20_000 });
  // From here the session exists (the refresh cookie Cognito's callback sets).
  mock.set('POST /api/auth/refresh', SIGNED_IN);
  await signer.evaluate(() => {
    sessionStorage.setItem('axoview.cognito.state', 'e2e-state');
    sessionStorage.setItem('axoview.cognito.verifier', 'e2e-verifier');
  });
  await signer.goto('/app/auth/callback?code=e2e-code&state=e2e-state');
  await expect(editor(signer)).toBeVisible({ timeout: 20_000 });
  expect(mock.callsTo('POST /api/auth/callback')).toHaveLength(1);

  for (const tab of [waiting, onLink]) {
    await expect.poll(() => new URL(tab.url()).pathname, { timeout: 15_000 }).toBe('/app');
    await expect(editor(tab)).toBeVisible({ timeout: 20_000 });
  }
});
