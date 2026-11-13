/**
 * First-party, voluntary product analytics. Browser session ID is random and
 * lives only in memory; neither Cognito sub nor diagram contents are sent.
 * All calls are best-effort and deliberately absent when consent is not given.
 */
import { apiFetch } from './apiFetch';

export type ProductEvent =
  | 'editor_session_started'
  | 'diagram_opened'
  | 'ai_message_sent'
  | 'agent_proposal_approved';

export const CONSENT_KEY = 'axoview-product-analytics-consent';
type Consent = 'accepted' | 'declined' | 'unset';

let enabled = false;
let sessionId: string | null = null;
let queue: Array<{ name: ProductEvent; eventId: string }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function uuid(): string | null {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : null;
}

export function readAnalyticsConsent(): Consent {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'accepted' || value === 'declined' ? value : 'unset';
  } catch {
    return 'unset';
  }
}

function allowed(): boolean {
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false;
  return enabled && readAnalyticsConsent() === 'accepted';
}

export function configureProductAnalytics(value: boolean): void {
  enabled = value;
  if (!allowed()) {
    queue = [];
    if (timer) clearTimeout(timer);
    timer = null;
  }
}

export function setAnalyticsConsent(choice: Exclude<Consent, 'unset'>): void {
  try { localStorage.setItem(CONSENT_KEY, choice); }
  catch { configureProductAnalytics(false); return; }
  if (choice !== 'accepted') configureProductAnalytics(false);
}

async function flush(): Promise<void> {
  if (flushing || !allowed() || queue.length === 0) return;
  flushing = true;
  const events = queue.splice(0, 20);
  try {
    const response = await apiFetch('/api/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, events })
    });
    if (!response.ok) throw new Error('analytics unavailable');
  } catch {
    // Best-effort, no local retention or retry tracking; editorial work wins.
  } finally {
    flushing = false;
    if (allowed() && queue.length) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 5000);
}

export function trackProductEvent(name: ProductEvent): void {
  if (!allowed()) return;
  sessionId ||= uuid();
  const eventId = uuid();
  if (!sessionId || !eventId) return;
  if (queue.length >= 20) return; // backpressure: never slow down the editor
  queue.push({ name, eventId });
  if (queue.length >= 10) {
    if (timer) clearTimeout(timer);
    timer = null;
    void flush();
  } else scheduleFlush();
}
