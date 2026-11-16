/**
 * ai-assistant.spec.ts — the AI assistant's UI against a scripted API
 * (helpers/mockApi.ts), before any model is wired in:
 *
 *   - who sees it: guests only where the deployment allows them (preview with
 *     canned replies, nothing sent), signed-in users get live chat;
 *   - live chat: the reply, the manual sources, the conversation carried on;
 *   - "Include this page": the page goes to the server only when ticked, and
 *     the suggested changes come back as a checklist checked against the live
 *     page (ready / not applicable / malformed ones hidden), re-checkable after
 *     the user edits;
 *   - failures: the server's own message, and a generic one when a proxy
 *     answers with an HTML error page.
 *
 * The dev config starts the app only, so /api/config, the Cognito refresh and
 * /api/ai/messages are all scripted. No bridge use: the DOM is the contract.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { installApiMock, type ApiMock, type MockReply } from '../helpers/mockApi';
import { placeIconViaMouse } from '../helpers/place';
import { byAxoviewId } from '../helpers/selectors';

const ONBOARDING_DISMISS_FLAGS: Array<[string, string]> = [
  ['axoview-lazy-loading-welcome-dismissed', 'true'],
  ['axoview-show-drag-hint', 'false']
];

type Ai = Partial<{
  chatEnabled: boolean;
  liveChat: boolean;
  guestEnabled: boolean;
  diagramContextEnabled: boolean;
}>;

function config(appOrigin: string, ai: Ai, cognito: boolean) {
  return {
    authMode: cognito ? 'cognito' : 'none',
    cognito: cognito
      ? {
          domain: 'https://auth.example.test',
          clientId: 'e2e-client',
          redirectUri: `${appOrigin}/app/auth/callback`,
          logoutUri: `${appOrigin}/app`,
          providers: ['Google']
        }
      : null,
    serverStorage: false,
    ai: { chatEnabled: true, ...ai }
  };
}

const SIGNED_IN: MockReply = {
  status: 200,
  json: { accessToken: 'e2e-access-token', expiresIn: 3600, user: { sub: 'e2e-user' } }
};
const SIGNED_OUT: MockReply = { status: 401, json: { error: 'No session' } };

/** Script the API, then load /app. Resolves once the editor or the sign-in screen shows. */
async function boot(
  page: Page,
  context: BrowserContext,
  baseURL: string,
  opts: { ai: Ai; cognito?: 'signed-in' | 'signed-out'; messages?: MockReply }
): Promise<ApiMock> {
  const origin = new URL(baseURL).origin;
  const mock = await installApiMock(context, origin, {
    'GET /api/config': { status: 200, json: config(origin, opts.ai, !!opts.cognito) },
    'POST /api/auth/refresh': opts.cognito === 'signed-in' ? SIGNED_IN : SIGNED_OUT,
    ...(opts.messages ? { 'POST /api/ai/messages': opts.messages } : {})
  });
  await context.addInitScript((flags: Array<[string, string]>) => {
    try {
      for (const [k, v] of flags) localStorage.setItem(k, v);
    } catch {
      /* not available yet */
    }
  }, ONBOARDING_DISMISS_FLAGS);
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto('/app');
  await Promise.race([
    byAxoviewId(page, 'screen-empty-create').waitFor({ state: 'visible', timeout: 20_000 }),
    byAxoviewId(page, 'cognito-sign-in-google').waitFor({ state: 'visible', timeout: 20_000 })
  ]);
  return mock;
}

const pageErrors: string[] = [];
test.beforeEach(() => {
  pageErrors.length = 0;
});
test.afterEach(() => {
  expect(pageErrors, 'uncaught page errors').toEqual([]);
});

const chat = (page: Page) => byAxoviewId(page, 'ai-chat-window');
const messages = (page: Page, role: 'user' | 'assistant') =>
  chat(page).locator(
    `[data-axoview-id="ai-message"][data-role="${role}"] [data-axoview-id="ai-message-text"]`
  );

async function openAssistant(page: Page): Promise<void> {
  await byAxoviewId(page, 'ai-bubble').click();
  await expect(chat(page)).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await byAxoviewId(page, 'ai-message-input').fill(text);
  await byAxoviewId(page, 'ai-send').click();
}

async function createBlankDiagram(page: Page): Promise<void> {
  await byAxoviewId(page, 'screen-empty-create').click();
  await page.locator('[data-testid="axoview-canvas"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
}

test.describe('AI assistant (scripted API)', () => {
  test('a guest gets the preview: canned replies, nothing sent', async ({ page, context, baseURL }) => {
    const mock = await boot(page, context, baseURL!, { ai: { guestEnabled: true, liveChat: true } });

    await openAssistant(page);
    await expect(chat(page)).toContainText('Guest preview only');
    await send(page, 'How do I connect two items?');
    await expect(messages(page, 'user')).toHaveText(['How do I connect two items?']);
    await expect(messages(page, 'assistant')).toContainText(['Phase 1 preview']);
    await expect(byAxoviewId(page, 'ai-message-input')).toHaveValue('');
    expect(mock.callsTo('POST /api/ai/messages'), 'a guest preview sends nothing').toHaveLength(0);
    // Live chat needs a signed-in user even when the deployment has it on.
    await expect(byAxoviewId(page, 'ai-include-page')).toHaveCount(0);

    await byAxoviewId(page, 'ai-minimize').click();
    await expect(chat(page)).toBeHidden();
    await expect(byAxoviewId(page, 'ai-bubble')).toBeVisible();
  });

  test('signed out with guests not allowed: no assistant on the sign-in screen', async ({
    page,
    context,
    baseURL
  }) => {
    await boot(page, context, baseURL!, { ai: { liveChat: true }, cognito: 'signed-out' });
    await expect(byAxoviewId(page, 'cognito-sign-in-google')).toBeVisible();
    // The widget is lazy: give a wrongly-shown one time to load before saying no.
    await page.waitForTimeout(1_000);
    await expect(byAxoviewId(page, 'ai-bubble')).toHaveCount(0);
  });

  test('signed out with guests allowed: the preview shows over the sign-in screen', async ({
    page,
    context,
    baseURL
  }) => {
    await boot(page, context, baseURL!, {
      ai: { liveChat: true, guestEnabled: true },
      cognito: 'signed-out'
    });
    await expect(byAxoviewId(page, 'cognito-sign-in-google')).toBeVisible();
    await openAssistant(page);
    await expect(chat(page)).toContainText('Guest preview only');
  });

  test('signed in: live replies with manual sources, one conversation', async ({
    page,
    context,
    baseURL
  }) => {
    let turn = 0;
    const mock = await boot(page, context, baseURL!, {
      ai: { liveChat: true },
      cognito: 'signed-in',
      messages: { status: 200, json: {} }
    });
    mock.set('POST /api/ai/messages', () => {
      turn += 1;
      return {
        status: 200,
        json: {
          reply: turn === 1 ? 'Press C, then click both items.' : 'Double-click the connector to name it.',
          conversationId: 'conv-e2e',
          sources: [
            { id: 'connectors-connecting-two-items', title: 'Connecting two items' },
            { id: 42, title: 'malformed source is dropped' }
          ]
        }
      };
    });

    await openAssistant(page);
    await expect(chat(page)).toContainText('No diagram access');
    // No diagram context in this deployment: no page option.
    await expect(byAxoviewId(page, 'ai-include-page')).toHaveCount(0);

    await send(page, 'How do I connect two items?');
    await expect(messages(page, 'assistant')).toHaveText(['Press C, then click both items.']);
    await expect(byAxoviewId(page, 'ai-sources')).toHaveText(
      'From the manual: Connecting two items'
    );
    await send(page, 'And name the connection?');
    await expect(messages(page, 'assistant')).toHaveCount(2);
    await expect(messages(page, 'user')).toHaveText([
      'How do I connect two items?',
      'And name the connection?'
    ]);

    const calls = mock.callsTo('POST /api/ai/messages');
    expect(calls).toHaveLength(2);
    expect(calls[0].headers['authorization']).toBe('Bearer e2e-access-token');
    expect(calls[0].body).toEqual({ message: 'How do I connect two items?' });
    expect(calls[1].body).toEqual({ message: 'And name the connection?', conversationId: 'conv-e2e' });
  });

  test('"Include this page": the page is sent only when ticked; suggestions are checked against it', async ({
    page,
    context,
    baseURL
  }) => {
    const mock = await boot(page, context, baseURL!, {
      ai: { liveChat: true, diagramContextEnabled: true },
      cognito: 'signed-in',
      messages: {
        status: 200,
        json: {
          reply: 'Here is what I would change.',
          conversationId: 'conv-page',
          sources: [],
          suggestions: [
            { op: 'add_node', name: 'Web server', reason: 'Requests need an entry point.' },
            { op: 'rename_node', node: { name: 'Untitled' }, name: 'Database' },
            { op: 'explode', target: 'everything' }
          ]
        }
      }
    });
    await createBlankDiagram(page);
    await openAssistant(page);
    await expect(chat(page)).toContainText('Sees your page only when');
    const include = byAxoviewId(page, 'ai-include-page').getByRole('checkbox');
    await expect(include).not.toBeChecked();

    // Unticked: the message goes alone, and no checklist is built.
    await send(page, 'What is missing?');
    await expect(messages(page, 'assistant')).toHaveCount(1);
    expect(mock.callsTo('POST /api/ai/messages')[0].body).toEqual({ message: 'What is missing?' });
    await expect(byAxoviewId(page, 'ai-suggestions')).toHaveCount(0);

    // Ticked: the page description goes with it.
    await include.check();
    await send(page, 'What is missing now?');
    await expect(messages(page, 'assistant')).toHaveCount(2);
    const sent = mock.callsTo('POST /api/ai/messages')[1].body as {
      conversationId?: string;
      diagram?: { page: { id: string }; pages: unknown[]; nodes: unknown[] };
    };
    expect(sent.conversationId).toBe('conv-page');
    expect(sent.diagram?.page.id, 'the page being described').toBeTruthy();
    expect(sent.diagram?.pages).toHaveLength(1);
    expect(sent.diagram?.nodes).toEqual([]);

    const suggestion = (i: number) => byAxoviewId(page, `ai-suggestion-${i}`);
    await expect(byAxoviewId(page, 'ai-suggestions')).toBeVisible();
    await expect(suggestion(0)).toHaveAttribute('data-status', 'ready');
    await expect(suggestion(0)).toContainText('Requests need an entry point.');
    // Nothing on the page is called "Untitled" yet.
    await expect(suggestion(1)).toHaveAttribute('data-status', 'not_applicable');
    await expect(suggestion(1)).toContainText('Not applicable');
    await expect(suggestion(1).getByRole('checkbox')).toBeDisabled();
    // A malformed suggestion is dropped, not shown.
    await expect(suggestion(2)).toHaveCount(0);

    // Ticking a step is the user's own memory aid.
    await suggestion(0).getByRole('checkbox').check();
    await expect(suggestion(0).getByRole('checkbox')).toBeChecked();

    // The user adds an item (a new item is named "Untitled"): checking again
    // against the page makes the rename applicable.
    await byAxoviewId(page, 'ai-minimize').click();
    await placeIconViaMouse(page, { x: 320, y: 260 });
    await openAssistant(page);
    await byAxoviewId(page, 'ai-suggestions-recheck').click();
    await expect(suggestion(1)).toHaveAttribute('data-status', 'ready');
    // Nothing was changed by the assistant: the checklist only advises.
    expect(mock.unhandled.filter((k) => !k.startsWith('GET '))).toEqual([]);
  });

  test('failures: the server message, and a generic one for a non-JSON error page', async ({
    page,
    context,
    baseURL
  }) => {
    const mock = await boot(page, context, baseURL!, {
      ai: { liveChat: true },
      cognito: 'signed-in',
      messages: { status: 429, json: { error: 'Daily AI limit reached. Try again tomorrow.' } }
    });
    await openAssistant(page);

    await send(page, 'Hello?');
    await expect(byAxoviewId(page, 'ai-send-error')).toHaveText(
      'Daily AI limit reached. Try again tomorrow.'
    );
    // The draft is kept so the user can resend it.
    await expect(byAxoviewId(page, 'ai-message-input')).toHaveValue('Hello?');
    await expect(messages(page, 'user')).toHaveCount(0);

    mock.set('POST /api/ai/messages', {
      status: 502,
      text: '<html><body>Bad gateway</body></html>',
      contentType: 'text/html'
    });
    await byAxoviewId(page, 'ai-send').click();
    await expect(byAxoviewId(page, 'ai-send-error')).toHaveText('AI chat is unavailable');

    // A reply without the required fields is a failure too, not a blank bubble.
    mock.set('POST /api/ai/messages', { status: 200, json: { reply: 'no conversation id' } });
    await byAxoviewId(page, 'ai-send').click();
    await expect(byAxoviewId(page, 'ai-send-error')).toHaveText('AI chat is unavailable');
    await expect(messages(page, 'assistant')).toHaveCount(0);

    mock.set('POST /api/ai/messages', {
      status: 200,
      json: { reply: 'Back again.', conversationId: 'conv-retry', sources: [] }
    });
    await byAxoviewId(page, 'ai-send').click();
    await expect(messages(page, 'assistant')).toHaveText(['Back again.']);
    await expect(byAxoviewId(page, 'ai-send-error')).toHaveCount(0);
  });
});
