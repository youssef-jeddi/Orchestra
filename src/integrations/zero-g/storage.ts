import { Indexer, ZgFile } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const INDEX_FILE = path.join(process.cwd(), 'storage-index.json');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[0G Storage] Missing required env var: ${name}`);
  }
  return value;
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
    console.log(`[0G Storage] WRITE ${key}`);
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
        console.log(`[0G Storage] WRITE ${key} -> ${rootHash}`);
      } finally {
        await file.close();
      }
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }

  async read(key: string): Promise<unknown | null> {
    console.log(`[0G Storage] READ ${key}`);
    const rootHash = this.index.get(key);
    if (!rootHash) {
      console.log(`[0G Storage] READ ${key} -> not found in index`);
      return null;
    }

    const tmpFile = path.join(os.tmpdir(), `0g-read-${key.replace(/\//g, '_')}-${Date.now()}.json`);

    try {
      const err = await this.indexer.download(rootHash, tmpFile, false);
      if (err) {
        console.warn(`[0G Storage] READ ${key} download failed:`, err);
        return null;
      }
      const raw = fs.readFileSync(tmpFile, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      console.warn(`[0G Storage] READ ${key} error:`, error);
      return null;
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
      const item = await this.read(key);
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
    console.log(`[0G Storage] DELETE ${key}`);
    this.index.delete(key);
    this.saveIndex();
  }

  async clear(): Promise<void> {
    console.log(`[0G Storage] CLEAR`);
    this.index.clear();
    this.saveIndex();
  }

  private loadIndex(): Map<string, string> {
    try {
      if (fs.existsSync(INDEX_FILE)) {
        const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
        const entries: [string, string][] = JSON.parse(raw);
        return new Map(entries);
      }
    } catch (err) {
      console.warn('[0G Storage] Failed to load index, starting fresh:', err);
    }
    return new Map();
  }

  private saveIndex(): void {
    const entries = Array.from(this.index.entries());
    fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
  }
}

// Auto-select backend: use 0G if env vars are set, otherwise in-memory
let storageBackend: {
  write: (key: string, data: unknown) => Promise<void>;
  read: (key: string) => Promise<unknown | null>;
  readMany: (collection: string, filter?: Record<string, unknown>) => Promise<unknown[]>;
  append: (collection: string, data: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
};

if (process.env.ZERO_G_PRIVATE_KEY && process.env.ZERO_G_RPC_URL && process.env.ZERO_G_INDEXER_URL) {
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
  console.log('[Storage] Using in-memory storage (set ZERO_G_* env vars for decentralized storage)');
  // Lazy import to avoid circular deps
  const mem = require('./memoryStorage');
  storageBackend = {
    write: mem.write,
    read: mem.read,
    readMany: mem.readMany,
    append: mem.append,
    delete: mem.deleteKey,
    clear: mem.clear,
  };
}

export const write = storageBackend.write;
export const read = storageBackend.read;
export const readMany = storageBackend.readMany;
export const append = storageBackend.append;
export const deleteKey = storageBackend.delete;
export const clear = storageBackend.clear;

export default storageBackend;
