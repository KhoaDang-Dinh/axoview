import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createFsObjectStorage } from '../../adapters/fs.js';
import { createAwsWorkspaceAdapter } from '../../adapters/aws.js';
import { addWorkspaceScope } from '../../adapters/workspace.js';
import { makeAwsDoubles } from '../helpers/awsDoubles.js';
import { runObjectStorageContract } from './object-storage.contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let storagePath;

beforeEach(async () => {
  storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'axoview-object-store-'));
});

afterEach(async () => {
  await fs.rm(storagePath, { recursive: true, force: true });
});

runObjectStorageContract({
  name: 'filesystem',
  createStore: () => createFsObjectStorage(storagePath)
});

// The production adapter's generic objects (S3 behind in-memory doubles that
// honour If-None-Match), through one workspace.
runObjectStorageContract({
  name: 'AWS workspace adapter (generic objects)',
  createStore: () => createAwsWorkspaceAdapter({ workspaceId: 'contract', bucketName: 'data', tableName: 'app', ...makeAwsDoubles() })
});

// And through the workspace scope the fs deployment uses.
runObjectStorageContract({
  name: 'filesystem through a workspace scope',
  createStore: async () => {
    const scoped = addWorkspaceScope(createFsObjectStorage(storagePath)).forWorkspace('contract');
    // The scope lists with its own root in front; the contract compares bare keys.
    return { ...scoped, list: async (prefix) => (await scoped.list(prefix)).map((key) => key.replace(/^workspaces\/contract\//, '')) };
  }
});

test('putIfAbsent: of several PROCESSES racing for one key, exactly one wins', async () => {
  const script = `
    import { createFsObjectStorage } from ${JSON.stringify(pathToFileURL(path.resolve(HERE, '../../adapters/fs.js')).href)};
    const [dir, startAt, name] = process.argv.slice(1);
    await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
    const won = await createFsObjectStorage(dir).putIfAbsent('claims/one', new TextEncoder().encode(name));
    process.stdout.write(won ? 'won' : 'lost');
  `;
  const startAt = Date.now() + 1500;
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script, storagePath, String(startAt), `p${i}`],
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  })));
  expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
  const stored = Buffer.from(await createFsObjectStorage(storagePath).get('claims/one')).toString('utf8');
  expect(stored).toBe(`p${outcomes.indexOf('won')}`);
  // No temporary files are left behind.
  expect((await fs.readdir(path.join(storagePath, 'claims'))).sort()).toEqual(['one.json']);
}, 30000);
