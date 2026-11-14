import * as Y from 'yjs';
import * as broadcast from 'lib0/broadcastchannel';
import { IndexeddbPersistence } from 'y-indexeddb';
import { patchModel, readModel } from '@axoview/collaboration';
import { apiFetch } from '../apiFetch';
import { apiBaseUrl } from '../../utils/apiBaseUrl';
import { getDeviceId } from './deviceId';
import type { SyncChange } from './realtimeSync';

const sessions = new Map<string, DiagramCollaboration>();
export const activeCollaboration = (id: string) => sessions.get(id);
const encode = (bytes: Uint8Array) => { let text = ''; bytes.forEach(b => { text += String.fromCharCode(b); }); return btoa(text); };
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const REMOTE = Symbol('remote');
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

export function receiveCollaboration(change: SyncChange): boolean {
  const session = change.id ? sessions.get(change.id) : undefined;
  session?.receive(change);
  return !!session;
}

/** One Y.Doc owns diagram data across HTTP/SSE, RTC and the provider's tab
 * channel. The application BroadcastChannel only carries account/lifecycle data. */
export class DiagramCollaboration {
  readonly doc = new Y.Doc();
  private persistence: IndexeddbPersistence | null = null;
  private undoManager = new Y.UndoManager(this.doc.getMap('fields'), { trackedOrigins: new Set(['local']), captureTimeout: 500 });
  readonly history = {
    undo: () => { this.undoManager.undo(); },
    redo: () => { this.undoManager.redo(); },
    canUndo: () => this.undoManager.canUndo(),
    canRedo: () => this.undoManager.canRedo()
  };
  private burstStart = 0;
  private burstEdits = 0;
  private nextAgent?: string;
  noteAgentChange(agent: string) { this.nextAgent = agent; }
  private pending: Uint8Array[] = [];
  private sending: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private poll: ReturnType<typeof setInterval>;
  private closed = false;
  private ready = false;
  private writable = false;
  private queued: Array<[unknown, unknown]> = [];
  private peers = new Map<string, RTCPeerConnection>();
  private channels = new Set<RTCDataChannel>();
  private readonly device = getDeviceId();
  private readonly url: string;
  private channel: string;
  private generation: string | null = null;
  serverVersion?: number;
  serverModified?: string;
  private subscribed = false;
  private readonly tabListener: (value: unknown) => void;
  private lastNotice = 0;
  private syncing: Promise<void> | null = null;

  constructor(readonly id: string, user: string,
    private onModel: (model: unknown) => void,
    private onNotice: (message: string) => void) {
    this.url = `${apiBaseUrl()}/api/diagrams/${encodeURIComponent(id)}/collaboration`;
    this.channel = `axoview:yjs:${user}:${id}`;

    this.doc.on('afterTransaction', () => this.undoManager.addToScope(Array.from(this.doc.share.values())));
    this.doc.on('update', this.onUpdate);
    this.tabListener = value => { if (value instanceof Uint8Array) Y.applyUpdate(this.doc, value, REMOTE); };

    sessions.set(id, this);
    this.poll = setInterval(() => { void this.sync().catch(() => {}); }, 15000);
    // Server auth is checked before showing persisted content or opening peers.
    void this.sync().catch(() => this.onNotice('Live sync is reconnecting; keep this tab open.'));
  }

  private request = async (suffix = '', body?: unknown, agent?: string) => {
    const response = await apiFetch(this.url + suffix, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Axoview-Device': this.device, ...(agent ? { 'X-Axoview-Agent': agent } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) this.close();
      throw new Error(`Live sync: ${response.status}`);
    }
    return response.json();
  };

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.closed || !this.ready) return;
    if (origin !== REMOTE && origin !== this.persistence) {
      this.pending.push(update);
      broadcast.publish(this.channel, update);
      for (const channel of Array.from(this.channels)) if (channel.readyState === 'open' && channel.bufferedAmount < 256000 && update.length < 60000) {
        try { channel.send(update as Uint8Array<ArrayBuffer>); } catch { /* SSE remains connected */ }
      }
      if (origin === this.undoManager) this.onModel(readModel(this.doc));
      if (Date.now() - this.burstStart > 1000) { this.burstStart = Date.now(); this.burstEdits = 0; }
      this.burstEdits++;
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.upload().catch(() => {}); }, this.burstEdits > 5 ? 250 : 60);
    } else this.onModel(readModel(this.doc));
  };

  change(before: unknown, after: unknown) {
    if (this.ready && !this.writable) return;
    if (!this.ready) { this.queued.push([before, after]); return; }
    patchModel(this.doc, before, after);
  }

  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const vector = this.ready ? encode(Y.encodeStateVector(this.doc)) : '';
      const state = await this.request(vector && vector.length < 16000 ? `?vector=${encodeURIComponent(vector)}` : '');
      if (this.closed) return;
      if (this.generation && this.generation !== state.generation) {
        this.close(); this.onNotice('This diagram was replaced. Reopen it to continue.'); return;
      }
      if (!this.generation) {
        this.generation = state.generation;
        this.channel += `:${state.generation}`;
        if (typeof indexedDB !== 'undefined') {
          this.persistence = new IndexeddbPersistence(this.channel, this.doc);
          await this.persistence.whenSynced.catch(() => {});
        }
        if (this.closed) return;
        broadcast.subscribe(this.channel, this.tabListener); this.subscribed = true;
      }
      this.serverVersion = Number(/(?:W\/)?"([0-9]+)"/.exec(state.etag || '')?.[1]) || undefined;
      this.serverModified = state.lastModified;
      Y.applyUpdate(this.doc, decode(state.update), REMOTE);
      this.ready = true;
      this.writable = state.writable === true;
      if (!this.writable) {
        for (const pc of Array.from(this.peers.values())) pc.close();
        this.peers.clear(); this.queued = []; this.pending = [];
      }
      for (const [before, after] of this.queued.splice(0)) patchModel(this.doc, before, after);
      // Also resend locally persisted offline work. Yjs deduplicates retries.
      const missing = Y.encodeStateAsUpdate(this.doc, decode(state.vector));
      if (this.writable && missing.length > 2) this.pending.push(missing);
      this.onModel(readModel(this.doc));
      if (this.pending.length) await this.upload();
      if (this.writable) void this.signal({ type: 'hello' }).catch(() => {});
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private upload(): Promise<void> {
    if (this.sending) return this.sending.then(() => this.pending.length ? this.upload() : undefined);
    if (!this.pending.length || this.closed) return Promise.resolve();
    const batch = this.pending.splice(0);
    const update = Y.mergeUpdates(batch);
    const agent = this.nextAgent; this.nextAgent = undefined;
    this.sending = this.request('', { update: encode(update), generation: this.generation }, agent).then(() => {}).catch(err => {
      this.nextAgent ??= agent;
      this.pending.unshift(...batch);
      if (!this.closed && !this.retry) this.retry = setTimeout(() => {
        this.retry = undefined; void this.upload().catch(() => {});
      }, 2000);
      this.onNotice('Changes are stored on this device; reconnecting to save online.');
      throw err;
    }).finally(() => { this.sending = null; });
    return this.sending;
  }

  async flush() {
    if (!this.ready) await this.sync();
    if (this.closed) throw new Error('Live session is closed');
    do { await this.upload(); } while (this.pending.length);
    const saved = await this.request('/flush', {});
    this.serverVersion = Number(/(?:W\/)?"([0-9]+)"/.exec(saved.headers?.ETag || '')?.[1]) || undefined;
    this.serverModified = saved.body?.lastModified;
    return saved;
  }

  receive(change: SyncChange) {
    if (this.closed) return;
    if (change.kind === 'collaboration' && !change.update) void this.sync().catch(() => {});
    if (change.kind === 'collaboration' && change.update && change.generation === this.generation) {
      try { Y.applyUpdate(this.doc, decode(change.update), REMOTE); } catch { void this.sync().catch(() => {}); }
      if (change.origin !== this.device && Date.now() - this.lastNotice > 5000) {
        this.lastNotice = Date.now(); this.onNotice(change.agent ? `${change.agent} updated this diagram` : 'A collaborator updated this diagram');
      }
    }
    if (change.kind === 'signal' && change.origin !== this.device && (!change.to || change.to === this.device)) {
      void this.onSignal(change.origin!, change.signal).catch(() => {});
    }
  }

  private signal(signal: unknown, to?: string) { return this.request('/signal', { signal: { ...(signal as object), generation: this.generation }, to }); }
  private async onSignal(peer: string, signal: any) {
    if (!this.ready || !this.writable || typeof RTCPeerConnection === 'undefined' || !peer || !signal || signal.generation !== this.generation) return;
    if (signal.type === 'hello') {
      if (this.peers.has(peer) || this.peers.size >= 8) return;
      const pc = this.peer(peer);
      this.attach(pc.createDataChannel('yjs'));
      await pc.setLocalDescription(await pc.createOffer());
      await this.signal({ description: pc.localDescription }, peer); return;
    }
    if (signal.description) {
      let pc = this.peers.get(peer);
      // Deterministic glare resolution if both peers announced simultaneously.
      if (pc && signal.description.type === 'offer' && pc.signalingState !== 'stable') {
        if (this.device < peer) return;
        pc.close(); this.peers.delete(peer); pc = undefined;
      }
      pc ??= this.peer(peer);
      await pc.setRemoteDescription(signal.description);
      if (signal.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        await this.signal({ description: pc.localDescription }, peer);
      }
    } else if (signal.candidate) {
      const pc = this.peers.get(peer);
      if (pc?.remoteDescription) await pc.addIceCandidate(signal.candidate);
    }
  }
  private peer(id: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); this.peers.set(id, pc);
    pc.onicecandidate = event => { if (event.candidate) void this.signal({ candidate: event.candidate.toJSON() }, id).catch(() => {}); };
    pc.ondatachannel = event => this.attach(event.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) { pc.close(); this.peers.delete(id); }
    };
    return pc;
  }
  private attach(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer'; this.channels.add(channel);
    channel.onmessage = event => {
      if (event.data instanceof ArrayBuffer && event.data.byteLength <= 60000) {
        try { Y.applyUpdate(this.doc, new Uint8Array(event.data), REMOTE); } catch { /* HTTP/SSE repairs gaps */ }
      }
    };
    channel.onclose = () => this.channels.delete(channel);
  }
  close() {
    if (this.closed) return; this.closed = true;
    clearInterval(this.poll); clearTimeout(this.timer); clearTimeout(this.retry);
    for (const pc of Array.from(this.peers.values())) pc.close();
    if (this.subscribed) broadcast.unsubscribe(this.channel, this.tabListener);
    this.doc.off('update', this.onUpdate);
    void this.persistence?.destroy(); this.undoManager.destroy(); this.doc.destroy();
    if (sessions.get(this.id) === this) sessions.delete(this.id);
  }
}
