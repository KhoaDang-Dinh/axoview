/**
 * Work to finish before this tab signs out: the editor saves pending edits
 * (autosave's debounce window) while the session still works. Used by the
 * tab that signs out and by every tab told so by another (tabChannel).
 * Never blocks a sign-out for long: after `timeoutMs` it goes ahead.
 */
const hooks = new Set<() => Promise<unknown>>();

export function registerBeforeSignOut(hook: () => Promise<unknown>): () => void {
  hooks.add(hook);
  return () => { hooks.delete(hook); };
}

export async function runBeforeSignOut(timeoutMs = 3000): Promise<void> {
  if (hooks.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(Array.from(hooks, (hook) => hook())),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
  ]);
  if (timer) clearTimeout(timer);
}
