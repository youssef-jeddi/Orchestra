// ─── Local storage ───
// The default storage backend: same API as the 0G backend, no network calls.
// Keeps everything in memory and, when given a file, mirrors it to disk after
// every change (write to a temp file, then rename — a crash can't leave a
// half-written file), so passkeys, Telegram links, policies and activity
// survive restarts. Without a file it's memory-only (tests, the eval).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { shortKey } from '../../utils/redact';

function unreadable(file: string, reason: string): Error {
  return new Error(`[LocalStorage] Can't read ${file} (${reason}). Refusing to start so no data is overwritten. Fix or restore the file, or move it away to start with empty storage.`);
}

export class LocalStorage {
  private store = new Map<string, unknown>();

  constructor(private readonly file: string | null = null) {
    if (file) this.load(file);
  }

  async write(key: string, data: unknown): Promise<void> {
    console.log(`[LocalStorage] WRITE ${shortKey(key)}`);
    this.store.set(key, structuredClone(data));
    this.persist();
  }

  async read(key: string): Promise<unknown | null> {
    const val = this.store.get(key) ?? null;
    console.log(`[LocalStorage] READ ${shortKey(key)} → ${val ? 'found' : 'null'}`);
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

  /**
   * A missing file is a first run and starts empty. Anything else that goes wrong throws and leaves
   * the file alone: starting empty would let the next write replace real data (passkeys, limits,
   * pending approvals) with nothing, and that must be a decision the owner makes.
   */
  private load(file: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      throw unreadable(file, err?.message ?? String(err));
    }
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch (err: any) {
      throw unreadable(file, raw.trim() === '' ? 'the file is empty' : `not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(entries) || !entries.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string')) {
      throw unreadable(file, 'not a list of [key, value] pairs');
    }
    this.store = new Map(entries as [string, unknown][]);
    console.log(`[LocalStorage] loaded ${this.store.size} record(s) from ${file}`);
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(this.store.entries())), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
