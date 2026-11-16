/**
 * Move the jsdom page to another URL (origin included) for the rest of a test.
 *
 * Jest 30's jsdom makes `window.location` non-configurable, so stubbing it with
 * `Object.defineProperty` throws. This goes through jsdom's `reconfigure`,
 * exposed by `jest.environment.js`. Returns a function that restores the URL
 * the page had before the call.
 */
type Reconfigure = (options: { url: string }) => void;

export function setJsdomUrl(url: string): () => void {
  const reconfigure = (globalThis as { __axoReconfigureJsdom?: Reconfigure })
    .__axoReconfigureJsdom;
  if (!reconfigure) {
    throw new Error(
      'setJsdomUrl: __axoReconfigureJsdom missing — is jest.environment.js the testEnvironment?'
    );
  }
  const previous = window.location.href;
  reconfigure({ url });
  return () => reconfigure({ url: previous });
}
