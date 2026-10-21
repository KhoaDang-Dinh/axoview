/**
 * This tab's device id for realtime sync. Sent on every write
 * (`X-Axoview-Device`) and echoed back in the sync stream, so a tab can ignore
 * changes it made itself. Per tab, not per browser: two tabs on one machine
 * are two devices. Kept in sessionStorage so a reload stays the same device.
 */
const KEY = 'axoview-device-id';
let cached: string | null = null;

function mint(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

export function getDeviceId(): string {
  if (cached) return cached;
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
      cached = stored;
      return stored;
    }
  } catch {
    /* storage blocked: an in-memory id is still unique for this tab */
  }
  cached = mint();
  try {
    sessionStorage.setItem(KEY, cached);
  } catch {
    /* see above */
  }
  return cached;
}
