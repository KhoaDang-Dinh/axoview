import { apiFetch } from '../apiFetch';
import { getDeviceId } from './deviceId';

/**
 * One change to the signed-in user's workspace, as streamed by the backend's
 * `GET /api/sync/events` (packages/axoview-backend/src/syncCursor.js).
 * `kind: 'resync'` means changes were missed: re-read what is shown.
 */
export interface SyncChange {
  seq: number;
  kind: 'diagram' | 'folder' | 'tree' | 'resync';
  action?: 'create' | 'save' | 'update' | 'move' | 'delete';
  id?: string;
  version?: number;
  name?: string;
  deleted?: boolean;
  /** Device (tab) that made the change; absent for writes without the header. */
  origin?: string;
  at?: string;
}

export interface RealtimeSyncOptions {
  baseUrl: string;
  /** A change made by another device (own echoes are dropped here). */
  onChange: (change: SyncChange) => void;
  /** The stream (re)connected; `resumed` when it continued from an earlier event. */
  onConnected?: (resumed: boolean) => void;
  /**
   * The backend answered 404/501: no sync stream there (the Worker deployment),
   * or an older API pod during a rolling deploy. The client tries again after
   * UNAVAILABLE_RETRY_MS rather than giving up for the tab's lifetime.
   */
  onUnavailable?: () => void;
  fetchImpl?: typeof apiFetch;
  deviceId?: string;
}

export interface RealtimeSyncConnection {
  close: () => void;
}

/** The server pings every 15s; this much silence means a dead or buffered stream. */
const SILENCE_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;
/** After a 404/501: long enough to cost nothing, short enough to outlast a rollout. */
export const UNAVAILABLE_RETRY_MS = 5 * 60_000;

interface Frame {
  event: string;
  id?: string;
  data: string;
}

/** Split complete SSE frames off `buffer`; returns the frames and what is left. */
export function parseSseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || id !== undefined) frames.push({ event, id, data: data.join('\n') });
  }
  return { frames, rest };
}

/**
 * Keep one sync stream open until `close()`: reconnects after the server ends
 * a stream (every few minutes), after errors (backoff up to 30s) and after
 * 45s of silence, resuming from the last event id so nothing is missed.
 * fetch rather than EventSource: the API needs the Cognito bearer token.
 */
export function connectRealtimeSync(options: RealtimeSyncOptions): RealtimeSyncConnection {
  const fetchImpl = options.fetchImpl ?? apiFetch;
  const deviceId = options.deviceId ?? getDeviceId();
  let closed = false;
  let lastEventId: string | null = null;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;

  const schedule = (ms: number) => {
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void run();
    }, ms);
  };

  const run = async () => {
    if (closed) return;
    controller = new AbortController();
    const active = controller;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => active.abort(), SILENCE_MS);
    };
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (lastEventId !== null) headers['Last-Event-ID'] = lastEventId;
      const response = await fetchImpl(`${options.baseUrl}/api/sync/events`, {
        headers,
        signal: active.signal,
        cache: 'no-store'
      });
      if (response.status === 404 || response.status === 501) {
        options.onUnavailable?.();
        schedule(UNAVAILABLE_RETRY_MS);
        return;
      }
      if (!response.ok || !response.body) throw new Error(`sync stream: HTTP ${response.status}`);

      const resumed = lastEventId !== null;
      options.onConnected?.(resumed);
      backoff = 1000;
      armSilence();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        armSilence();
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.id !== undefined) lastEventId = frame.id;
          if (frame.event !== 'change') continue;
          let change: SyncChange;
          try {
            change = JSON.parse(frame.data) as SyncChange;
          } catch {
            continue;
          }
          if (change.origin && change.origin === deviceId) continue;
          options.onChange(change);
        }
      }
      // The server ends streams on purpose every few minutes: reconnect at once.
      schedule(250);
    } catch {
      if (closed) return;
      schedule(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    } finally {
      if (silenceTimer) clearTimeout(silenceTimer);
    }
  };

  void run();
  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    }
  };
}
