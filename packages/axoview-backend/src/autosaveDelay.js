/**
 * How long after the last edit a diagram is saved: one setting for the whole
 * system (owner decision 2026-11-15).
 *
 *   AUTOSAVE_DELAY_MS   default 1500 (1.5 s), accepted 250..30000
 *
 * The backend reads it once at startup and uses it twice:
 *   - published in GET /api/config as `autosaveDelayMs`; the app's autosave
 *     (hooks/useAutoSave.ts) waits this long after the last edit to save;
 *   - a live (Yjs) session's server snapshot is assembled this long after the
 *     last edit (src/collaboration.js). A busy session is still snapshotted at
 *     least every 15 s however often edits come.
 *
 * Deployments set it from a GitHub variable (infra: DEV_AUTOSAVE_DELAY_MS /
 * PROD_AUTOSAVE_DELAY_MS -> the runtime ConfigMap). An unset, malformed or
 * out-of-range value falls back to the default, with a warning: a typo must
 * never stop saving or save on every keystroke.
 */
export const DEFAULT_AUTOSAVE_DELAY_MS = 1500;
export const MIN_AUTOSAVE_DELAY_MS = 250;
export const MAX_AUTOSAVE_DELAY_MS = 30_000;

export function autosaveDelayFrom(value, warn = console.warn) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_AUTOSAVE_DELAY_MS;
  const text = String(value).trim();
  const ms = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(ms) || ms < MIN_AUTOSAVE_DELAY_MS || ms > MAX_AUTOSAVE_DELAY_MS) {
    warn(`[config] AUTOSAVE_DELAY_MS must be a whole number of milliseconds from ${MIN_AUTOSAVE_DELAY_MS} to ${MAX_AUTOSAVE_DELAY_MS}; using ${DEFAULT_AUTOSAVE_DELAY_MS}`);
    return DEFAULT_AUTOSAVE_DELAY_MS;
  }
  return ms;
}
