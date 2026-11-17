/**
 * Where the gateway keeps its state: invoices, payments nobody could match,
 * the payments already counted, the block it has read up to, and webhooks
 * still to deliver. Two stores ship: one in memory, and one JSON file written
 * whole through a temporary file, so a crash mid-write leaves the last good
 * file. A store that holds more than one process's state wants a database;
 * the interface is two methods.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Invoice, UnmatchedPayment } from './types';
import type { Delivery } from './webhook';

export interface PayState {
  version: 1;
  invoices: Invoice[];
  unmatched: UnmatchedPayment[];
  /** Payment ids already counted, newest last. */
  seen: string[];
  /** The next child index in `address` mode. */
  nextIndex: number;
  /** The last block read; null before the first read. */
  cursor: number | null;
  outbox: Delivery[];
}

export const emptyState = (): PayState => ({ version: 1, invoices: [], unmatched: [], seen: [], nextIndex: 0, cursor: null, outbox: [] });

export interface PayStore {
  load(): Promise<PayState | null>;
  save(state: PayState): Promise<void>;
}

export class MemoryPayStore implements PayStore {
  private saved: string | null = null;

  async load(): Promise<PayState | null> {
    return this.saved === null ? null : (JSON.parse(this.saved) as PayState);
  }

  async save(state: PayState): Promise<void> {
    this.saved = JSON.stringify(state);
  }
}

export class JsonFilePayStore implements PayStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<PayState | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch {
      throw new Error(`${this.path} is not JSON; it was not replaced`);
    }
    if (typeof state !== 'object' || state === null || (state as PayState).version !== 1 || !Array.isArray((state as PayState).invoices)) throw new Error(`${this.path} is not a gateway state file`);
    return state as PayState;
  }

  async save(state: PayState): Promise<void> {
    const body = `${JSON.stringify(state)}\n`;
    const write = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, body, 'utf8');
      await rename(temporary, this.path);
    });
    this.writing = write.catch(() => undefined);
    await write;
  }
}
