import { getDeviceId, resetDeviceIdForTests } from '../deviceId';

beforeEach(() => {
  sessionStorage.clear();
  resetDeviceIdForTests();
});

it('is stable within a page load and well-formed for the server', () => {
  const id = getDeviceId();
  expect(getDeviceId()).toBe(id);
  expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});

it('a duplicated tab (same sessionStorage) still gets its own id', () => {
  const first = getDeviceId();
  // What a duplicated tab inherits: a copy of this tab's sessionStorage, with
  // the key the old implementation used.
  sessionStorage.setItem('axoview-device-id', first);
  resetDeviceIdForTests(); // the duplicate's own page load
  expect(getDeviceId()).not.toBe(first);
});
