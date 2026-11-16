/**
 * jsdom test environment with a URL hook.
 *
 * Jest 30 ships a jsdom whose `window.location` is non-configurable (per the
 * HTML spec's [LegacyUnforgeable]), so tests can no longer swap it out with
 * `Object.defineProperty`. jsdom's own `reconfigure({ url })` is the supported
 * way to move the page to another origin; this environment exposes it to tests
 * as `globalThis.__axoReconfigureJsdom`. Use it through
 * `src/testUtils/jsdomUrl.ts`, not directly.
 */
const { TestEnvironment } = require('jest-environment-jsdom');

class AxoviewJsdomEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.global.__axoReconfigureJsdom = (options) => this.dom.reconfigure(options);
  }
}

module.exports = AxoviewJsdomEnvironment;
