import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createFsObjectStorage } from '../../adapters/fs.js';
import { runObjectStorageContract } from './object-storage.contract.js';

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
