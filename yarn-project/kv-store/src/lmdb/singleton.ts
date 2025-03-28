import type { Database, Key } from 'lmdb';

import type { AztecAsyncSingleton, AztecSingleton } from '../interfaces/singleton.js';

/** The slot where this singleton will store its value */
type ValueSlot = ['singleton', string, 'value'];

/**
 * Stores a single value in LMDB.
 */
export class LmdbAztecSingleton<T> implements AztecSingleton<T>, AztecAsyncSingleton<T> {
  #db: Database<T, ValueSlot>;
  #slot: ValueSlot;

  constructor(db: Database<unknown, Key>, name: string) {
    this.#db = db as Database<T, ValueSlot>;
    this.#slot = ['singleton', name, 'value'];
  }

  get(): T | undefined {
    return this.#db.get(this.#slot);
  }

  getAsync(): Promise<T | undefined> {
    return Promise.resolve(this.get());
  }

  set(val: T): Promise<boolean> {
    return this.#db.put(this.#slot, val);
  }

  delete(): Promise<boolean> {
    return this.#db.remove(this.#slot);
  }
}
