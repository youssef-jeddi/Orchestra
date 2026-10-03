// ─── Local storage ───
// The default storage backend: same API as the 0G backend, no network calls.
// Keeps everything in memory and, when given a file, mirrors it to disk after
// every change (write to a temp file, then rename — a crash can't leave a
// half-written file), so passkeys, Telegram links, policies and activity
// survive restarts. Without a file it's memory-only (tests, the eval).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export class LocalStorage {
  private store = new Map<string, unknown>();

  constructor(private readonly file: string | null = null) {
    if (file) this.load(file);
  }

  async write(key: string, data: unknown): Promise<void> {
    console.log(`[LocalStorage] WRITE ${key}`);
    this.store.set(key, structuredClone(data));
    this.persist();
  }

  async read(key: string): Promise<unknown | null> {
    const val = this.store.get(key) ?? null;
    console.log(`[LocalStorage] READ ${key} → ${val ? 'found' : 'null'}`);
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
    this.persist();
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.persist();
  }

  private load(file: string): void {
    try {
      const entries = JSON.parse(fs.readFileSync(file, 'utf-8')) as [string, unknown][];
      this.store = new Map(entries);
      console.log(`[LocalStorage] loaded ${this.store.size} record(s) from ${file}`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        // Don't overwrite a file we couldn't parse: keep it for inspection.
        const backup = `${file}.unreadable-${Date.now()}`;
        try { fs.renameSync(file, backup); } catch { /* ignore */ }
        console.warn(`[LocalStorage] couldn't read ${file} (${err.message}); moved it to ${backup} and started empty`);
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(this.store.entries())), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
