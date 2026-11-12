/**
 * The stack the agent end-to-end test runs against (tests-agents/, ADR 0059
 * addendum 2026-11-12): the BUILT app and the REAL backend behind one origin,
 * as nginx puts them in the image.
 *
 *   http://127.0.0.1:<AGENTS_PORT>/api/*   the backend (a child process), storing on disk
 *   http://127.0.0.1:<AGENTS_PORT>/app/*   the app shell (build/app.html)
 *   anything else                         a file from the app build
 *
 * One thing is not real: Cognito. The backend starts with its test hook
 * (src/__tests__/helpers/fakeCognito.register.mjs), which accepts
 * `test-user:<sub>` as a signed-in person's token. The OAuth server, the MCP
 * server, sharing, storage and the app are the shipped code.
 *
 * Started by playwright.agents.config.ts (`npm run test:e2e:agents`); needs
 * `npm run build` first. Storage is a fresh temp directory, removed on exit.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const build = path.join(repo, 'packages/axoview-app/build');
const backendDir = path.join(repo, 'packages/axoview-backend');
const port = Number(process.env.AGENTS_PORT || 8089);
const backendPort = Number(process.env.AGENTS_BACKEND_PORT || 3189);
const origin = `http://127.0.0.1:${port}`;

if (!fs.existsSync(path.join(build, 'app.html'))) {
  console.error(`No app build at ${build}: run "npm run build" first.`);
  process.exit(1);
}

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'axoview-agents-e2e-'));
const backend = spawn(process.execPath, ['--import', './src/__tests__/helpers/fakeCognito.register.mjs', 'server.js'], {
  cwd: backendDir,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    BACKEND_PORT: String(backendPort),
    STORAGE_PATH: store,
    ENABLE_SERVER_STORAGE: 'true',
    AUTH_MODE: 'cognito',
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_test',
    COGNITO_CLIENT_ID: 'test-client',
    COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_test',
    COGNITO_DOMAIN: 'https://auth.example.test',
    PUBLIC_BASE_URL: origin,
    ALLOWED_ORIGINS: origin,
    AI_MCP_ENABLED: 'true',
    FAKE_COGNITO_ACCOUNTS: JSON.stringify([{ sub: 'alice-1', email: 'alice@example.com', email_verified: true }])
  }
});

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.webp': 'image/webp', '.txt': 'text/plain'
};

function sendFile(res, file) {
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function toBackend(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":"backend unreachable"}');
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
  if (pathname.startsWith('/api/') || pathname.startsWith('/.well-known/')) return toBackend(req, res);
  // A file of the build, never one outside it.
  const file = path.join(build, path.normalize(pathname));
  if (file.startsWith(build + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
  if (pathname === '/app' || pathname.startsWith('/app/')) return sendFile(res, path.join(build, 'app.html'));
  if (pathname === '/') return sendFile(res, path.join(build, 'index.html'));
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});
server.listen(port, '127.0.0.1', () => console.log(`agents e2e stack on ${origin} (backend :${backendPort}, store ${store})`));

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  backend.kill('SIGTERM');
  fs.rmSync(store, { recursive: true, force: true });
  process.exit(code);
}
backend.on('exit', (code) => {
  if (!stopping) {
    console.error(`backend exited (${code})`);
    stop(1);
  }
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
