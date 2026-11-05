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

// --- The client's contract, piece by piece ------------------------------------------

/**
 * A scripted server: each connection gets the next script, a list of chunks
 * or a status. After its chunks a stream either ends (`end: true`) or stays
 * open until aborted. Records every request.
 */
function scriptedFetch(scripts: Array<{ chunks?: string[]; status?: number; end?: boolean; throws?: boolean }>) {
  const encoder = new TextEncoder();
  const requests: Array<{ headers: Headers; init: RequestInit; at: number }> = [];
  let aborts = 0;
  const impl = async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    const script = scripts[Math.min(requests.length, scripts.length - 1)];
    requests.push({ headers: new Headers(init.headers), init, at: Date.now() });
    init.signal?.addEventListener('abort', () => { aborts += 1; });
    if (script.throws) throw new TypeError('network down');
    const status = script.status ?? 200;
    if (status !== 200) return { ok: false, status, body: null } as unknown as Response;
    const chunks = script.chunks ?? [];
    let index = 0;
    const reader = {
      read: () =>
        index < chunks.length
          ? Promise.resolve({ done: false, value: encoder.encode(chunks[index++]) })
          : script.end
            ? Promise.resolve({ done: true })
            : new Promise<{ done: boolean }>((resolve) =>
                init.signal?.addEventListener('abort', () => resolve({ done: true }))
              )
    };
    return { ok: true, status, body: { getReader: () => reader } } as unknown as Response;
  };
  return { impl, requests, aborts: () => aborts };
}

const change = (seq: number, extra = '"kind":"diagram","action":"save","id":"d1","origin":"other-1234"') =>
  `id: ${seq}\nevent: change\ndata: {"seq":${seq},${extra}}\n\n`;

describe('connectRealtimeSync', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks for an event stream, uncached, and only sends Last-Event-ID once it has one', async () => {
    const { impl, requests } = scriptedFetch([{ chunks: ['id: 7\nevent: ready\ndata: {"seq":7}\n\n'], end: true }, {}]);
    const connected = jest.fn();
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, onConnected: connected, fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(300);
    connection.close();
    expect(requests[0].headers.get('Accept')).toBe('text/event-stream');
    expect(requests[0].init.cache).toBe('no-store');
    expect(requests[0].headers.has('Last-Event-ID')).toBe(false);
    expect(requests[1].headers.get('Last-Event-ID')).toBe('7');
    expect(connected.mock.calls).toEqual([[false], [true]]);
  });

  it('heartbeats, ready and retry frames are not changes; a bad frame is skipped, not fatal', async () => {
    const { impl } = scriptedFetch([{
      chunks: [
        'retry: 3000\n\n',
        'id: 1\nevent: ready\ndata: {"seq":1}\n\n',
        ': ping\n\n',
        'id: 2\nevent: change\ndata: {not json\n\n',
        'event: something-new\ndata: {"seq":99}\n\n',
        change(3),
        // A bad frame must not take the good one in the same chunk with it.
        'id: 4\nevent: change\ndata: {"seq":\n\n' + change(5)
      ]
    }]);
    const changes: SyncChange[] = [];
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: (c) => changes.push(c), fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(10);
    connection.close();
    expect(changes.map((c) => c.seq)).toEqual([3, 5]);
  });

  it('a change split across network chunks is delivered once, when complete', async () => {
    const frame = change(5);
    const { impl } = scriptedFetch([{ chunks: [frame.slice(0, 9), frame.slice(9, 30), frame.slice(30), change(6)] }]);
    const changes: SyncChange[] = [];
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: (c) => changes.push(c), fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(10);
    connection.close();
    expect(changes.map((c) => c.seq)).toEqual([5, 6]);
  });

  it('a change without an origin (the server, a script, an agent) is delivered', async () => {
    const { impl } = scriptedFetch([{ chunks: [change(8, '"kind":"diagram","action":"save","id":"d1"')] }]);
    const changes: SyncChange[] = [];
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: (c) => changes.push(c), fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(10);
    connection.close();
    expect(changes).toEqual([expect.objectContaining({ seq: 8, action: 'save' })]);
  });

  it('errors back off 1s, 2s, 4s ... up to 30s, and a good connection resets the backoff', async () => {
    const { impl, requests } = scriptedFetch([
      { status: 500 }, { throws: true }, { status: 503 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
      { chunks: ['id: 1\nevent: ready\ndata: {"seq":1}\n\n'], end: true },
      { status: 500 }
    ]);
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(120_000);
    connection.close();
    const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
    // 1, 2, 4, 8, 16, 30 (capped), 30; then the good stream ends (250 ms), and
    // the next failure starts again at 1 s.
    expect(gaps.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(gaps[7]).toBe(250);
    expect(gaps[8]).toBe(1000);
  });

  it('45 s without a byte (a buffering proxy, a dead connection) aborts and reconnects', async () => {
    const { impl, requests, aborts } = scriptedFetch([{ chunks: ['id: 4\nevent: ready\ndata: {"seq":4}\n\n'] }]);
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(44_000);
    expect(requests).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(aborts()).toBe(1);
    await jest.advanceTimersByTimeAsync(300);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1].headers.get('Last-Event-ID')).toBe('4');
    connection.close();
  });

  it('heartbeats keep a quiet stream open', async () => {
    const encoder = new TextEncoder();
    let push: ((chunk: string) => void) | null = null;
    let calls = 0;
    const impl = async () => {
      calls += 1;
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      push = (chunk) => { queue.push(chunk); wake?.(); };
      const reader = {
        read: async () => {
          while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
          return { done: false, value: encoder.encode(queue.shift()!) };
        }
      };
      return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
    };
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) {
      await jest.advanceTimersByTimeAsync(15_000);
      push!(': ping\n\n');
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(calls).toBe(1);
    connection.close();
  });

  it('close() stops everything: the open stream and any pending retry', async () => {
    const { impl, requests, aborts } = scriptedFetch([{ status: 500 }, {}]);
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    connection.close();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(1);

    const open = scriptedFetch([{ chunks: ['id: 1\nevent: ready\ndata: {"seq":1}\n\n'] }]);
    const second = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, fetchImpl: open.impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(10);
    second.close();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(open.aborts()).toBe(1);
    expect(open.requests).toHaveLength(1);
  });

  it('501 (no stream on this backend) is treated like 404: retried after minutes, quietly', async () => {
    const { impl, requests } = scriptedFetch([{ status: 501 }, {}]);
    const unavailable = jest.fn();
    const connection = connectRealtimeSync({
      baseUrl: 'http://api', onChange: () => undefined, onUnavailable: unavailable, fetchImpl: impl as never, deviceId: 'me-12345678'
    });
    await jest.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS - 1);
    expect(requests).toHaveLength(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    connection.close();
  });
});
