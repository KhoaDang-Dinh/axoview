/**
 * This tab's device id for realtime sync. Sent on every write
 * (`X-Axoview-Device`) and echoed back in the sync stream, so a tab can ignore
 * changes it made itself.
 *
 * One per page load, kept in memory only. It used to live in sessionStorage
 * "so a reload stays the same device", but browsers COPY sessionStorage into a
 * duplicated tab (and a tab opened from this one): the two tabs then shared an
 * id, and each dropped the other's changes as its own echo — a diagram
 * deleted in one never closed in its twin. Nothing needs the id to survive a
 * reload: a reloaded tab opens a fresh stream that starts after its earlier
 * writes, and an echo it does receive carries a version it already has.
 */
let cached: string | null = null;

function mint(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

export function getDeviceId(): string {
  if (!cached) cached = mint();
  return cached;
}

/** Test seam: a fresh page load. */
export function resetDeviceIdForTests(): void {
  cached = null;
}
