// Atomic, mutex-protected JSON persistence for the file-based stores.
//
// The stores (events, codes, languages, ai-config) each keep an in-memory
// cache and rewrite the whole JSON file on every mutation. Without care this
// is racy under concurrent admin writes: two interleaved writes can produce a
// torn file or lose one mutation. This module serialises writes per file via
// a promise-chain mutex and writes atomically (temp file + rename) so a crash
// mid-write can never leave a half-written file.

import { promises as fs } from "node:fs";
import path from "node:path";

const mutexes = new Map<string, Promise<unknown>>();

/** Serialise access to `file`: only one task per path runs at a time. */
export function withLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(file) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain but don't let a rejection here block later callers —
  // errors propagate to the caller of `next`, and the mutex resolves.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  mutexes.set(file, settled);
  return next;
}

/** Write `data` to `file` atomically: write a temp sibling, then rename. */
export async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  // fs.rename is atomic on the same filesystem (POSIX and Windows NTFS).
  await fs.rename(tmp, file);
}

/** Convenience: serialised + atomic JSON write. */
export async function persistJsonAtomic(file: string, value: unknown): Promise<void> {
  await withLock(file, () => writeAtomic(file, JSON.stringify(value, null, 2)));
}
