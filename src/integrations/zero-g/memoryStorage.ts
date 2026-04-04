// ─── In-Memory Storage ───
// Drop-in replacement for 0G storage. Same API, no network calls.
// Used when ZERO_G_PRIVATE_KEY is not set.

import * as crypto from 'crypto';

class MemoryStorage {
  private store = new Map<string, unknown>();

  async write(key: string, data: unknown): Promise<void> {
    console.log(`[MemStorage] WRITE ${key}`);
    this.store.set(key, structuredClone(data));
  }

  async read(key: string): Promise<unknown | null> {
    const val = this.store.get(key) ?? null;
    console.log(`[MemStorage] READ ${key} → ${val ? 'found' : 'null'}`);
    return val ? structuredClone(val) : null;
  }

  async readMany(collection: string, filter?: Record<string, unknown>): Promise<unknown[]> {
    const prefix = `${collection}/`;
    const results: unknown[] = [];

    for (const [key, value] of this.store) {
      if (!key.startsWith(prefix)) continue;
      if (filter) {
        const record = value as Record<string, unknown>;
        const matches = Object.entries(filter).every(([k, v]) => record[k] === v);
        if (!matches) continue;
      }
      results.push(structuredClone(value));
    }

    return results;
  }

  async append(collection: string, data: unknown): Promise<void> {
    const id = crypto.randomBytes(4).toString('hex');
    const key = `${collection}/${Date.now()}-${id}`;
    await this.write(key, data);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

const storage = new MemoryStorage();

export const write = storage.write.bind(storage);
export const read = storage.read.bind(storage);
export const readMany = storage.readMany.bind(storage);
export const append = storage.append.bind(storage);
export const deleteKey = storage.delete.bind(storage);
export const clear = storage.clear.bind(storage);

export default storage;
