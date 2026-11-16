import { registerBeforeSignOut, runBeforeSignOut } from '../beforeSignOut';

it('runs every registered hook and waits for them', async () => {
  const done: string[] = [];
  const offA = registerBeforeSignOut(async () => { await new Promise((r) => setTimeout(r, 20)); done.push('save'); });
  const offB = registerBeforeSignOut(async () => { done.push('other'); });
  await runBeforeSignOut();
  expect(done.sort()).toEqual(['other', 'save']);
  offA(); offB();
});

it('a failing hook does not stop the sign-out', async () => {
  const off = registerBeforeSignOut(async () => { throw new Error('offline'); });
  await expect(runBeforeSignOut()).resolves.toBeUndefined();
  off();
});

it('a hook that hangs is given up on after the timeout', async () => {
  const off = registerBeforeSignOut(() => new Promise(() => {}));
  const started = Date.now();
  await runBeforeSignOut(50);
  expect(Date.now() - started).toBeLessThan(1000);
  off();
});

it('unregistered hooks are not run', async () => {
  let ran = false;
  const off = registerBeforeSignOut(async () => { ran = true; });
  off();
  await runBeforeSignOut();
  expect(ran).toBe(false);
});
