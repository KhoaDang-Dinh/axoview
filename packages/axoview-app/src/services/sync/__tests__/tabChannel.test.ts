/**
 * Messages between tabs. Two "tabs" in one jsdom: two separately loaded copies
 * of the module, over a shared BroadcastChannel bus (or the storage fallback).
 */
type Listener = (event: { data: unknown }) => void;
const bus = new Map<string, Set<FakeChannel>>();
class FakeChannel {
  private listeners = new Set<Listener>();
  constructor(private name: string) {
    if (!bus.has(name)) bus.set(name, new Set());
    bus.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    // Like the real thing: everyone on the channel but the sender, async.
    const others = Array.from(bus.get(this.name)!).filter((other) => other !== this);
    for (const other of others) {
      setTimeout(() => other.listeners.forEach((l) => l({ data: structuredCloneish(data) })), 0);
    }
  }
  addEventListener(_type: string, l: Listener) { this.listeners.add(l); }
  removeEventListener(_type: string, l: Listener) { this.listeners.delete(l); }
  close() { bus.get(this.name)!.delete(this); }
  // (Array.from, not for..of: the app compiles to a target where for..of over
  // a Set runs zero times.)
}
const structuredCloneish = (v: unknown) => JSON.parse(JSON.stringify(v));

function loadTab(): typeof import('../tabChannel') {
  let mod: typeof import('../tabChannel') | undefined;
  jest.isolateModules(() => { mod = require('../tabChannel'); });
  return mod!;
}
const flush = () => new Promise((r) => setTimeout(r, 5));

describe('over BroadcastChannel', () => {
  beforeEach(() => { bus.clear(); (global as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel; });
  afterEach(() => { delete (global as { BroadcastChannel?: unknown }).BroadcastChannel; });

  it('another tab receives the message; the sender does not', async () => {
    const a = loadTab();
    const b = loadTab();
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.onTabMessage((m) => gotA.push(m));
    b.onTabMessage((m) => gotB.push(m));
    a.postToTabs({ type: 'account-signed-out' });
    a.postToTabs({ type: 'diagram-deleted', id: 'diagram_abc' });
    await flush();
    expect(gotB).toEqual([{ type: 'account-signed-out' }, { type: 'diagram-deleted', id: 'diagram_abc' }]);
    expect(gotA).toEqual([]);
  });

  it('unknown or malformed messages are ignored', async () => {
    const a = loadTab();
    const b = loadTab();
    const got: unknown[] = [];
    b.onTabMessage((m) => got.push(m));
    // Straight onto the channel, as another script on the origin could.
    const raw = new FakeChannel('axoview-tabs');
    for (const junk of [null, 'x', { type: 'delete-everything' }, { type: 'diagram-deleted' }, { type: 'diagram-deleted', id: '../x' }]) {
      raw.postMessage(junk);
    }
    await flush();
    expect(got).toEqual([]);
    a.postToTabs({ type: 'drive-signed-out' });
    await flush();
    expect(got).toEqual([{ type: 'drive-signed-out' }]);
  });

  it('unsubscribing stops delivery', async () => {
    const a = loadTab();
    const b = loadTab();
    const got: unknown[] = [];
    const stop = b.onTabMessage((m) => got.push(m));
    stop();
    a.postToTabs({ type: 'account-signed-in' });
    await flush();
    expect(got).toEqual([]);
  });
});

describe('without BroadcastChannel: the storage-event fallback', () => {
  it('posts through localStorage and reads storage events', () => {
    const tab = loadTab();
    const got: unknown[] = [];
    tab.onTabMessage((m) => got.push(m));
    const writes: Array<[string, string | null]> = [];
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) { writes.push([k, v]); });
    tab.postToTabs({ type: 'diagram-deleted', id: 'd1' });
    setItem.mockRestore();
    expect(writes).toHaveLength(1);
    // Another tab's write arrives as a storage event.
    window.dispatchEvent(new StorageEvent('storage', { key: 'axoview-tabs-message', newValue: writes[0][1] }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '{}' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'axoview-tabs-message', newValue: 'not json' }));
    expect(got).toEqual([{ type: 'diagram-deleted', id: 'd1' }]);
  });
});
