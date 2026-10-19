import { Indexer, ZgFile } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { LocalStorage } from './memoryStorage';
import { shortKey, safeErr } from '../../utils/redact';

const INDEX_FILE = path.join(process.cwd(), 'storage-index.json');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[0G Storage] Missing required env var: ${name}`);
  }
  return value;
}

/**
 * The saved key → root-hash index. A missing file is a first run (empty); anything else wrong with it
 * throws and the file is left alone: "starting fresh" would orphan every record already uploaded.
 */
export function loadIndexFile(file: string): Map<string, string> {
  const fail = (reason: string) =>
    new Error(`[0G Storage] Can't read ${file} (${reason}). Refusing to start so no data is overwritten. Fix or restore the file, or move it away to start with an empty index.`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return new Map();
    throw fail(err?.message ?? String(err));
  }
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch (err: any) {
    throw fail(raw.trim() === '' ? 'the file is empty' : `not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(entries) || !entries.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')) {
    throw fail('not a list of [key, root hash] pairs');
  }
  return new Map(entries as [string, string][]);
}

class ZeroGStorage {
  private indexer: Indexer;
  private signer: ethers.Wallet;
  private evmRpc: string;
  private index: Map<string, string>;

  constructor() {
    const privateKey = requireEnv('ZERO_G_PRIVATE_KEY');
    this.evmRpc = requireEnv('ZERO_G_RPC_URL');
    const indexerUrl = requireEnv('ZERO_G_INDEXER_URL');

    const provider = new ethers.JsonRpcProvider(this.evmRpc);
    this.signer = new ethers.Wallet(privateKey, provider);
    this.indexer = new Indexer(indexerUrl);
    this.index = this.loadIndex();
  }

  async write(key: string, data: unknown): Promise<void> {
    console.log(`[0G Storage] WRITE ${shortKey(key)}`);
    const json = JSON.stringify(data);
    const tmpFile = path.join(os.tmpdir(), `0g-write-${key.replace(/\//g, '_')}-${Date.now()}.json`);

    try {
      fs.writeFileSync(tmpFile, json, 'utf-8');
      const file = await ZgFile.fromFilePath(tmpFile);

      try {
        const [tx, err] = await this.indexer.upload(file, this.evmRpc, this.signer);
        if (err) {
          throw new Error(`Upload failed: ${err}`);
        }
        const rootHash = 'rootHash' in tx ? tx.rootHash : tx.rootHashes[0];
        this.index.set(key, rootHash);
        this.saveIndex();
        console.log(`[0G Storage] WRITE ${shortKey(key)} -> ${rootHash}`);
      } finally {
        await file.close();
      }
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }

  /**
   * The stored value, or null only when the key was never written. A failed download or unreadable
   * data throws: "missing" and "couldn't read" must not look alike, or a caller would fall back to
   * defaults (a lowered limit becomes $100) and save over real data.
   */
  async read(key: string): Promise<unknown | null> {
    console.log(`[0G Storage] READ ${shortKey(key)}`);
    const rootHash = this.index.get(key);
    if (!rootHash) {
      console.log(`[0G Storage] READ ${shortKey(key)} -> not found in index`);
      return null;
    }

    const tmpFile = path.join(os.tmpdir(), `0g-read-${key.replace(/\//g, '_')}-${Date.now()}.json`);

    try {
      const err = await this.indexer.download(rootHash, tmpFile, false);
      if (err) {
        console.warn(`[0G Storage] READ ${shortKey(key)} download failed:`, err);
        throw new Error(`0G download failed for ${shortKey(key)}`);
      }
      const raw = fs.readFileSync(tmpFile, 'utf-8');
      return JSON.parse(raw);
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }

  async readMany(collection: string, filter?: Record<string, unknown>): Promise<unknown[]> {
    console.log(`[0G Storage] READ_MANY ${collection}`);
    const prefix = `${collection}/`;
    const matchingKeys = Array.from(this.index.keys()).filter((k) => k.startsWith(prefix));

    const results: unknown[] = [];
    for (const key of matchingKeys) {
      const item = await this.read(key); // a row that can't be read throws: dropping it would understate what's there
      if (item === null) continue;

      if (filter) {
        const record = item as Record<string, unknown>;
        const matches = Object.entries(filter).every(([k, v]) => record[k] === v);
        if (!matches) continue;
      }

      results.push(item);
    }

    return results;
  }

  async append(collection: string, data: unknown): Promise<void> {
    const id = crypto.randomBytes(4).toString('hex');
    const key = `${collection}/${Date.now()}-${id}`;
    await this.write(key, data);
  }

  async delete(key: string): Promise<void> {
    console.log(`[0G Storage] DELETE ${shortKey(key)}`);
    this.index.delete(key);
    this.saveIndex();
  }

  async clear(): Promise<void> {
    console.log(`[0G Storage] CLEAR`);
    this.index.clear();
    this.saveIndex();
  }

  private loadIndex(): Map<string, string> {
    return loadIndexFile(INDEX_FILE);
  }

  private saveIndex(): void {
    const entries = Array.from(this.index.entries());
    fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
  }
}

// Backend selection (STORAGE_BACKEND):
//   file   (default) local store persisted to STORAGE_FILE (default .orchestra/storage.json)
//   memory           memory only — tests and the eval, so they never touch real data
//   0g               0G decentralized storage; opt-in only, and it needs the ZERO_G_* keys
// 0G is never picked implicitly: a stray ZERO_G_* value in .env can't change where data goes.
let storageBackend: {
  write: (key: string, data: unknown) => Promise<void>;
  read: (key: string) => Promise<unknown | null>;
  readMany: (collection: string, filter?: Record<string, unknown>) => Promise<unknown[]>;
  append: (collection: string, data: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
};

const STORAGE_MODE = (process.env.STORAGE_BACKEND || 'file').trim().toLowerCase();

if (STORAGE_MODE === '0g') {
  if (!(process.env.ZERO_G_PRIVATE_KEY && process.env.ZERO_G_RPC_URL && process.env.ZERO_G_INDEXER_URL)) {
    throw new Error('[Storage] STORAGE_BACKEND=0g needs ZERO_G_PRIVATE_KEY, ZERO_G_RPC_URL and ZERO_G_INDEXER_URL');
  }
  console.log('[Storage] Using 0G decentralized storage');
  const s = new ZeroGStorage();
  storageBackend = {
    write: s.write.bind(s),
    read: s.read.bind(s),
    readMany: s.readMany.bind(s),
    append: s.append.bind(s),
    delete: s.delete.bind(s),
    clear: s.clear.bind(s),
  };
} else {
  if (STORAGE_MODE !== 'file' && STORAGE_MODE !== 'memory') {
    throw new Error(`[Storage] unknown STORAGE_BACKEND "${STORAGE_MODE}" (use file, memory or 0g)`);
  }
  const file = STORAGE_MODE === 'file'
    ? path.resolve(process.env.STORAGE_FILE || path.join(process.cwd(), '.orchestra', 'storage.json'))
    : null;
  console.log(file ? `[Storage] Using local storage: ${file}` : '[Storage] Using in-memory storage (nothing survives a restart)');
  const local = new LocalStorage(file);
  storageBackend = {
    write: local.write.bind(local),
    read: local.read.bind(local),
    readMany: local.readMany.bind(local),
    append: local.append.bind(local),
    delete: local.delete.bind(local),
    clear: local.clear.bind(local),
  };
}

export const write = storageBackend.write;
export const read = storageBackend.read;
export const readMany = storageBackend.readMany;
export const append = storageBackend.append;
export const deleteKey = storageBackend.delete;
export const clear = storageBackend.clear;

export default storageBackend;
