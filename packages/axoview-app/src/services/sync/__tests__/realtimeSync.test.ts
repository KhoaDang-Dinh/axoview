import { TextDecoder, TextEncoder } from 'util';
import { UNAVAILABLE_RETRY_MS, connectRealtimeSync, parseSseFrames, type SyncChange } from '../realtimeSync';

Object.assign(global, { TextDecoder, TextEncoder });

describe('parseSseFrames', () => {
  it('splits complete frames and keeps the partial rest', () => {
    const { frames, rest } = parseSseFrames(
      'retry: 3000\n\nid: 1\nevent: ready\ndata: {"seq":1}\n\n: ping\n\nid: 2\nevent: change\ndata: {"se'
    );
    expect(frames).toEqual([{ event: 'ready', id: '1', data: '{"seq":1}' }]);
    expect(rest).toBe('id: 2\nevent: change\ndata: {"se');
  });

  it('handles CRLF line endings and multi-line data', () => {
    const { frames } = parseSseFrames('event: change\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(frames).toEqual([{ event: 'change', id: undefined, data: 'a\nb' }]);
  });
});

/** A fetch whose body yields the given chunks, then stays open until aborted. */
function streamingFetch(chunks: string[], status = 200) {
  const requests: Array<{ url: string; lastEventId: string | null }> = [];
  const impl = async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    requests.push({ url: String(url), lastEventId: headers.get('Last-Event-ID') });
    const encoder = new TextEncoder();
    let index = 0;
    const reader = {
      read: () =>
        index < chunks.length
          ? Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) })
          : new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              init.signal?.addEventListener('abort', () => resolve({ done: true }));
            })
    };
    return { ok: status >= 200 && status < 300, status, body: { getReader: () => reader } } as unknown as Response;
  };
  return { impl, requests };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it('delivers changes from other devices and drops its own echoes', async () => {
  const { impl } = streamingFetch([
    'id: 4\nevent: ready\ndata: {"seq":4}\n\n',
    'id: 5\nevent: change\ndata: {"seq":5,"kind":"diagram","action":"save","id":"d1","origin":"me-12345678"}\n\n',
    'id: 6\nevent: change\ndata: {"seq":6,"kind":"diagram","action":"save","id":"d1","origin":"other-1234"}\n\n'
  ]);
  const changes: SyncChange[] = [];
  const connection = connectRealtimeSync({
    baseUrl: 'http://api',
    onChange: (c) => changes.push(c),
    fetchImpl: impl as never,
    deviceId: 'me-12345678'
  });
  await flush();
  await flush();
  connection.close();
  expect(changes.map((c) => c.seq)).toEqual([6]);
});

it('a backend without the stream (404) is retried later, not given up on', async () => {
  jest.useFakeTimers();
  try {
    let call = 0;
    const encoder = new TextEncoder();
    const impl = async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      if (call++ === 0) return { ok: false, status: 404, body: null } as unknown as Response;
      const chunks = ['id: 3\nevent: change\ndata: {"seq":3,"kind":"tree","action":"save","origin":"other-1234"}\n\n'];
      let index = 0;
      const reader = {
        read: () =>
          index < chunks.length
            ? Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) })
            : new Promise<{ done: boolean }>((resolve) =>
                init.signal?.addEventListener('abort', () => resolve({ done: true }))
              )
      };
      return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
    };
    const unavailable = jest.fn();
    const changes: SyncChange[] = [];
    const connection = connectRealtimeSync({
      baseUrl: 'http://api',
      onChange: (c) => changes.push(c),
      onUnavailable: unavailable,
      fetchImpl: impl as never,
      deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(10);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(call).toBe(1);
    await jest.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS);
    expect(call).toBe(2);
    expect(changes.map((c) => c.seq)).toEqual([3]);
    connection.close();
  } finally {
    jest.useRealTimers();
  }
});

it('reconnects after the server ends a stream, resuming from the last event id', async () => {
  jest.useFakeTimers();
  try {
    let call = 0;
    const lastIds: Array<string | null> = [];
    const encoder = new TextEncoder();
    const impl = async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      lastIds.push(new Headers(init.headers).get('Last-Event-ID'));
      const chunks = call++ === 0 ? ['id: 9\nevent: ready\ndata: {"seq":9}\n\n'] : [];
      let index = 0;
      const reader = {
        read: () =>
          Promise.resolve(
            index < chunks.length
              ? { done: false, value: encoder.encode(chunks[index++]) }
              : { done: true }
          )
      };
      return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
    };
    const connection = connectRealtimeSync({
      baseUrl: 'http://api',
      onChange: () => undefined,
      fetchImpl: impl as never,
      deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(300);
    connection.close();
    expect(lastIds.slice(0, 2)).toEqual([null, '9']);
  } finally {
    jest.useRealTimers();
  }
});
