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
// Two stacks, one per kind of storage: files (no versions) and AWS (versions,
// If-Match), each on its own port. The same spec runs against both.
const STACKS = [
  { name: 'fs', port: 8089, backendPort: 3189 },
  { name: 'aws', port: 8090, backendPort: 3190 }
];

export default defineConfig({
  testDir: './tests-agents',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: STACKS.map((stack) => ({
    name: `agents-${stack.name}`,
    use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${stack.port}` }
  })),
  webServer: STACKS.map((stack) => ({
    command: `node agents/stack.mjs`,
    env: { AGENTS_STORAGE: stack.name, AGENTS_PORT: String(stack.port), AGENTS_BACKEND_PORT: String(stack.backendPort) },
    url: `http://127.0.0.1:${stack.port}/api/config`,
    // Always a fresh stack: its storage starts empty.
    reuseExistingServer: false,
    timeout: 60_000
  })),
  outputDir: './test-results/agents'
});
