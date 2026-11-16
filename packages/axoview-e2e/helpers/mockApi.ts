/**
 * A scripted `/api/*` for dev-server specs that need a backend the dev config
 * does not start (it runs the app only).
 *
 * On the dev server apiBaseUrl() is http://localhost:3001, so every API call
 * is cross-origin and credentialed (`credentials: 'include'` on the auth
 * calls): the browser still applies CORS to a fulfilled response, so each
 * answer carries the app's origin and Allow-Credentials, and preflights are
 * answered here too. On a production bundle the calls are same-origin and the
 * headers are harmless.
 *
 * Routes are keyed `METHOD /api/path`. Anything not scripted answers 404 and is
 * recorded in `unhandled`, so a spec can see what else the app asked for.
 */
import type { BrowserContext, Request } from '@playwright/test';

export type MockReply =
  | { status: number; json: unknown }
  | { status: number; text: string; contentType?: string };

export type MockHandler = (request: Request) => MockReply | Promise<MockReply>;

export interface ApiCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ApiMock {
  /** Every scripted call, in order. */
  calls: ApiCall[];
  /** `METHOD /path` of each call nothing was scripted for. */
  unhandled: string[];
  /** Replace or add a route while the test runs. */
  set(key: string, handler: MockHandler | MockReply): void;
  callsTo(key: string): ApiCall[];
}

export async function installApiMock(
  context: BrowserContext,
  appOrigin: string,
  routes: Record<string, MockHandler | MockReply>
): Promise<ApiMock> {
  const table = new Map(Object.entries(routes));
  const mock: ApiMock = {
    calls: [],
    unhandled: [],
    set: (key, handler) => table.set(key, handler),
    callsTo: (key) => mock.calls.filter((c) => `${c.method} ${c.path}` === key)
  };
  const cors = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin'
  };

  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-allow-headers':
              (await request.headerValue('access-control-request-headers')) ?? 'content-type',
            'access-control-max-age': '600'
          }
        });
        return;
      }
      const key = `${request.method()} ${path}`;
      const entry = table.get(key);
      if (!entry) {
        mock.unhandled.push(key);
        await route.fulfill({
          status: 404,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not mocked' })
        });
        return;
      }
      let body: unknown = request.postData();
      try {
        body = request.postDataJSON();
      } catch {
        /* not JSON: keep the raw text */
      }
      mock.calls.push({ method: request.method(), path, headers: await request.allHeaders(), body });
      const reply = typeof entry === 'function' ? await entry(request) : entry;
      if ('json' in reply) {
        await route.fulfill({
          status: reply.status,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify(reply.json)
        });
      } else {
        await route.fulfill({
          status: reply.status,
          headers: cors,
          contentType: reply.contentType ?? 'text/plain',
          body: reply.text
        });
      }
    }
  );
  return mock;
}
