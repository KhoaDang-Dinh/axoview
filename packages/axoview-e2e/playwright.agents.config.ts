import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the agent end-to-end test (tests-agents/): a real MCP
 * client signs in through OAuth, proposes a change, the person approves it in
 * a real browser, and the diagram is stored. ADR 0059 addendum 2026-11-12.
 *
 * Unlike playwright.config.ts (dev server, the API mocked in the page) this
 * runs the BUILT app against the REAL backend: agents/stack.mjs puts both
 * behind one origin, with only Cognito faked. So `npm run build` must come
 * first. Run it with `npm run test:e2e:agents`; CI does on every pull request
 * (.github/workflows/e2e-agents.yml).
 */
const port = Number(process.env.AGENTS_PORT || 8089);

export default defineConfig({
  testDir: './tests-agents',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'agents', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node agents/stack.mjs',
    url: `http://127.0.0.1:${port}/api/config`,
    // Always a fresh stack: its storage starts empty.
    reuseExistingServer: false,
    timeout: 60_000
  },
  outputDir: './test-results/agents'
});
