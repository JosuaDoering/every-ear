// Atomic, mutex-protected JSON persistence for the file-based stores.
//
// The stores (events, codes, languages, ai-config) each keep an in-memory
// cache and rewrite the whole JSON file on every mutation. Without care this
// is racy under concurrent admin writes: two interleaved writes can produce a
// torn file or lose one mutation. This module serialises writes per file via
// a promise-chain mutex and writes atomically (temp file + rename) so a crash
// mid-write can never leave a half-written file.

import { promises as fs, mkdirSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * Synchronous variant for callers that cannot await (settings/caddy boot code).
 * Same temp-file + rename guarantee.
 */
export function writeAtomicSync(file: string, data: string, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode, encoding: "utf8" });
  renameSync(tmp, file);
}

/** Convenience: serialised + atomic JSON write. */
export async function persistJsonAtomic(file: string, value: unknown): Promise<void> {
  await withLock(file, () => writeAtomic(file, JSON.stringify(value, null, 2)));
}

/**
 * Run `task` at most once at a time per `key`, sharing the pending promise with
 * every concurrent caller. Used by the stores' lazy `load()`: the load awaits
 * the file read, so without this two callers that arrive before the cache is
 * filled would each build their own Map and the later write would discard the
 * earlier one's mutation.
 */
const inflight = new Map<string, Promise<unknown>>();

export function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const next = task().finally(() => inflight.delete(key));
  inflight.set(key, next);
  return next;
}

/** Forget a key's pending load (a reset while a load is still running). */
export function forgetPending(key: string): void {
  inflight.delete(key);
}

/**
 * Read and parse a JSON store, downgrading a corrupt file to "empty" instead of
 * aborting boot. A single truncated write (power loss, full disk) must never
 * take the whole service down mid-event; the bad file is moved aside so it can
 * be inspected and, if possible, repaired afterwards.
 */
export async function readJsonStore<T>(
  file: string,
  parse: (raw: unknown) => T,
  fallback: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return parse(JSON.parse(raw));
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    console.error(`[store] ${path.basename(file)} is unreadable, backing up to ${backup}:`, err);
    await fs.rename(file, backup).catch(() => undefined);
    return fallback;
  }
}
