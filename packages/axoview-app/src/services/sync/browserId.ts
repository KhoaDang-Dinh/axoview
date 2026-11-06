/**
 * This browser's id for presence (services/sync/presence.ts): the same in
 * every tab of one browser profile, so tabs of one browser count as one
 * participant and a second browser or device counts as company. Random,
 * kept in localStorage; it says nothing about who the user is.
 *
 * Unlike the device id (one per page load, deviceId.ts) it must be shared by
 * the tabs, which is exactly what localStorage is. Where storage is blocked it
 * falls back to one id per page load: that tab then counts as a browser of its
 * own, which only means it uploads at once (the safe direction).
 */
const KEY = 'axoview-browser-id';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
let cached: string | null = null;

function mint(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

export function getBrowserId(): string {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && ID_RE.test(stored)) {
      cached = stored;
      return cached;
    }
    cached = mint();
    localStorage.setItem(KEY, cached);
  } catch {
    cached = cached ?? mint();
  }
  return cached;
}

/** Test seam. */
export function resetBrowserIdForTests(): void {
  cached = null;
}
