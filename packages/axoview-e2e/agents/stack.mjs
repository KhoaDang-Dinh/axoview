/**
 * The stack the agent end-to-end test runs against (tests-agents/, ADR 0059
 * addendum 2026-11-12): the BUILT app and the REAL backend behind one origin,
 * as nginx puts them in the image.
 *
 *   http://127.0.0.1:<AGENTS_PORT>/api/*   the backend (a child process), storing on disk
 *   http://127.0.0.1:<AGENTS_PORT>/app/*   the app shell (build/app.html)
 *   anything else                         a file from the app build
 *
 * Like CloudFront in front of dev and prod (infra modules/edge, /api/* with
 * compression on), the proxy gzips API answers of 1,000 bytes to 10 MB when
 * the browser accepts gzip, and then turns a strong ETag into a weak one
 * (W/"7"), as CloudFront documents. The sync stream is passed through as is.
 *
 * One thing is not real: Cognito. The backend starts with its test hook
 * (src/__tests__/helpers/fakeCognito.register.mjs), which accepts
 * `test-user:<sub>` as a signed-in person's token. The OAuth server, the MCP
 * server, sharing, storage and the app are the shipped code.
 *
 * Storage: AGENTS_STORAGE=fs (files in a fresh temp directory, removed on
 * exit; no versions, the app goes by lastModified) or AGENTS_STORAGE=aws (the
 * real AWS adapter and sync cursor on in-memory S3 and DynamoDB,
 * src/__tests__/helpers/fakeAws.register.mjs: versions, If-Match, ETags, as on
 * dev and prod).
 *
 * Started by playwright.agents.config.ts (`npm run test:e2e:agents`); needs
 * `npm run build` first.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
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

const storage = process.env.AGENTS_STORAGE === 'aws' ? 'aws' : 'fs';
const store = fs.mkdtempSync(path.join(os.tmpdir(), 'axoview-agents-e2e-'));
const hooks = ['--import', './src/__tests__/helpers/fakeCognito.register.mjs'];
if (storage === 'aws') hooks.push('--import', './src/__tests__/helpers/fakeAws.register.mjs');
const backend = spawn(process.execPath, [...hooks, 'server.js'], {
  cwd: backendDir,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    BACKEND_PORT: String(backendPort),
    STORAGE_PATH: store,
    ENABLE_SERVER_STORAGE: 'true',
    ...(storage === 'aws'
      ? { STORAGE_ADAPTER: 'aws', DATA_BUCKET: 'agents-e2e', DYNAMODB_TABLE: 'agents-e2e', AWS_REGION: 'ap-southeast-1' }
      : {}),
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

const COMPRESSIBLE = /^(application\/json|text\/|application\/javascript|image\/svg\+xml)/;

/** What CloudFront does to an answer it compresses: gzip, and a weak ETag. */
function compressLikeCloudFront(req, answer, res) {
  const status = answer.statusCode || 502;
  const length = Number(answer.headers['content-length']);
  const compress = [200, 403, 404].includes(status) &&
    /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) &&
    !answer.headers['content-encoding'] &&
    COMPRESSIBLE.test(String(answer.headers['content-type'] || '')) &&
    Number.isFinite(length) && length >= 1000 && length <= 10_000_000;
  if (!compress) {
    res.writeHead(status, answer.headers);
    answer.pipe(res);
    return;
  }
  const headers = { ...answer.headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding' };
  delete headers['content-length'];
  if (typeof headers.etag === 'string' && headers.etag.startsWith('"')) headers.etag = `W/${headers.etag}`;
  res.writeHead(status, headers);
  answer.pipe(zlib.createGzip()).pipe(res);
}

function toBackend(req, res) {
  const stream = req.url.startsWith('/api/sync/');
  const upstream = http.request(
    { host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (answer) => {
      if (stream) {
        res.writeHead(answer.statusCode || 502, answer.headers);
        answer.pipe(res);
        return;
      }
      compressLikeCloudFront(req, answer, res);
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
server.listen(port, '127.0.0.1', () => console.log(`agents e2e stack on ${origin} (backend :${backendPort}, ${storage} storage)`));

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
