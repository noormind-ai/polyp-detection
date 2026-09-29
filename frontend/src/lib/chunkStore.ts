"use client";

/**
 * Durable local storage for MediaRecorder chunks, so a crashed tab / OOM /
 * power loss loses at most the last unflushed slice instead of the whole
 * procedure -- unlike a plain JS array, which is gone the instant the tab is.
 *
 * Picks the best backend available, in order: OPFS, then IndexedDB, then a
 * plain in-memory array as a last resort. The memory fallback is not hidden:
 * callers read `kind` and surface it, because pretending a RAM buffer is as
 * safe as the other two is exactly the failure mode this file exists to fix.
 */

export type ChunkStoreKind = "opfs" | "indexeddb" | "memory";

export interface ChunkStore {
  kind: ChunkStoreKind;
  append(blob: Blob, seq: number): Promise<void>;
  /** All chunks in seq order. */
  readAll(): Promise<Blob[]>;
  clear(): Promise<void>;
}

export interface OrphanedRecording {
  caseId: string;
  recordingId: string;
  bytes: number;
  startedAt: number;
}

const ROOT_DIR = "session-recordings";
const DB_NAME = "polyp-session-recordings";
const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";
const META_STORE = "meta";

function pad(seq: number): string {
  return String(seq).padStart(6, "0");
}

// ---------------------------------------------------------------- OPFS ----

async function opfsSupported(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    // Feature-detect only -- no directory is created here, so a browser that
    // exposes the API but can't actually use it costs nothing to rule out.
    return typeof root.getDirectoryHandle === "function"
      // @ts-expect-error async iterator isn't in older lib.dom typings
      && typeof root.entries === "function";
  } catch {
    return false;
  }
}

class OpfsChunkStore implements ChunkStore {
  kind: ChunkStoreKind = "opfs";
  constructor(private dir: FileSystemDirectoryHandle) {}

  async append(blob: Blob, seq: number): Promise<void> {
    const handle = await this.dir.getFileHandle(`${pad(seq)}.chunk`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async readAll(): Promise<Blob[]> {
    const names: string[] = [];
    // @ts-expect-error async iterator isn't in older lib.dom typings
    for await (const name of this.dir.keys()) {
      if (name.endsWith(".chunk")) names.push(name);
    }
    names.sort();
    const blobs: Blob[] = [];
    for (const name of names) {
      const handle = await this.dir.getFileHandle(name);
      blobs.push(await handle.getFile());
    }
    return blobs;
  }

  async clear(): Promise<void> {
    // @ts-expect-error async iterator isn't in older lib.dom typings
    for await (const name of this.dir.keys()) {
      await this.dir.removeEntry(name).catch(() => { /* already gone */ });
    }
  }
}

async function openOpfsStore(caseId: string, recordingId: string): Promise<OpfsChunkStore> {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle(ROOT_DIR, { create: true });
  const dir = await sessions.getDirectoryHandle(recordingId, { create: true });
  const metaHandle = await dir.getFileHandle("meta.json", { create: true });
  const writable = await metaHandle.createWritable();
  await writable.write(JSON.stringify({ caseId, recordingId, startedAt: Date.now() }));
  await writable.close();
  return new OpfsChunkStore(dir);
}

async function listOpfsOrphans(): Promise<OrphanedRecording[]> {
  const out: OrphanedRecording[] = [];
  if (!(await opfsSupported())) return out;
  try {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle(ROOT_DIR, { create: false }).catch(() => null);
    if (!sessions) return out;
    // @ts-expect-error async iterator isn't in older lib.dom typings
    for await (const [name, handle] of sessions.entries()) {
      if (handle.kind !== "directory") continue;
      try {
        const metaHandle = await (handle as FileSystemDirectoryHandle).getFileHandle("meta.json");
        const meta = JSON.parse(await (await metaHandle.getFile()).text());
        let bytes = 0;
        // @ts-expect-error async iterator isn't in older lib.dom typings
        for await (const [fname, fh] of (handle as FileSystemDirectoryHandle).entries()) {
          if (fname.endsWith(".chunk")) bytes += (await (fh as FileSystemFileHandle).getFile()).size;
        }
        out.push({ caseId: meta.caseId, recordingId: meta.recordingId ?? name, bytes, startedAt: meta.startedAt ?? 0 });
      } catch { /* unreadable entry, skip it rather than fail the whole scan */ }
    }
  } catch { /* OPFS unavailable or root dir never created */ }
  return out;
}

export async function deleteOpfsRecording(recordingId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle(ROOT_DIR, { create: false }).catch(() => null);
    await sessions?.removeEntry(recordingId, { recursive: true } as FileSystemRemoveOptions).catch(() => {});
  } catch { /* nothing to delete */ }
}

// ----------------------------------------------------------- IndexedDB ----

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const store = db.createObjectStore(CHUNKS_STORE, { keyPath: ["recordingId", "seq"] });
        store.createIndex("recordingId", "recordingId", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "recordingId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IndexedDbChunkStore implements ChunkStore {
  kind: ChunkStoreKind = "indexeddb";
  constructor(private db: IDBDatabase, private recordingId: string) {}

  async append(blob: Blob, seq: number): Promise<void> {
    const db = this.db;
    const recordingId = this.recordingId;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHUNKS_STORE, "readwrite");
      tx.objectStore(CHUNKS_STORE).put({ recordingId, seq, blob });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async readAll(): Promise<Blob[]> {
    const db = this.db;
    const recordingId = this.recordingId;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNKS_STORE, "readonly");
      const index = tx.objectStore(CHUNKS_STORE).index("recordingId");
      const rows: { seq: number; blob: Blob }[] = [];
      const req = index.openCursor(IDBKeyRange.only(recordingId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { rows.push(cursor.value); cursor.continue(); }
        else { rows.sort((a, b) => a.seq - b.seq); resolve(rows.map((r) => r.blob)); }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = this.db;
    const recordingId = this.recordingId;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([CHUNKS_STORE, META_STORE], "readwrite");
      const index = tx.objectStore(CHUNKS_STORE).index("recordingId");
      const req = index.openCursor(IDBKeyRange.only(recordingId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.objectStore(META_STORE).delete(recordingId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

async function openIndexedDbStore(caseId: string, recordingId: string): Promise<IndexedDbChunkStore> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ recordingId, caseId, startedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return new IndexedDbChunkStore(db, recordingId);
}

async function listIndexedDbOrphans(): Promise<OrphanedRecording[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const db = await openDb();
    return await new Promise<OrphanedRecording[]>((resolve) => {
      const out: OrphanedRecording[] = [];
      const tx = db.transaction([META_STORE, CHUNKS_STORE], "readonly");
      const metaReq = tx.objectStore(META_STORE).openCursor();
      const chunkIndex = tx.objectStore(CHUNKS_STORE).index("recordingId");
      metaReq.onsuccess = () => {
        const cursor = metaReq.result;
        if (!cursor) { resolve(out); return; }
        const meta = cursor.value;
        let bytes = 0;
        const chunkReq = chunkIndex.openCursor(IDBKeyRange.only(meta.recordingId));
        chunkReq.onsuccess = () => {
          const c = chunkReq.result;
          if (c) { bytes += (c.value.blob as Blob).size; c.continue(); }
          else {
            out.push({ caseId: meta.caseId, recordingId: meta.recordingId, bytes, startedAt: meta.startedAt });
            cursor.continue();
          }
        };
      };
      metaReq.onerror = () => resolve(out);
    });
  } catch {
    return [];
  }
}

export async function deleteIndexedDbRecording(recordingId: string): Promise<void> {
  try {
    const db = await openDb();
    await new IndexedDbChunkStore(db, recordingId).clear();
  } catch { /* nothing to delete */ }
}

// -------------------------------------------------------------- Memory ----

class MemoryChunkStore implements ChunkStore {
  kind: ChunkStoreKind = "memory";
  private chunks: Blob[] = [];
  async append(blob: Blob): Promise<void> { this.chunks.push(blob); }
  async readAll(): Promise<Blob[]> { return this.chunks; }
  async clear(): Promise<void> { this.chunks = []; }
}

// --------------------------------------------------------------- Public ----

/** Opens the best durable store available for one recording. Never rejects --
 *  a backend that fails partway through setup is treated as unavailable and
 *  the next one down the list is tried instead. */
export async function openChunkStore(caseId: string, recordingId: string): Promise<ChunkStore> {
  if (await opfsSupported()) {
    try { return await openOpfsStore(caseId, recordingId); } catch { /* fall through */ }
  }
  if (typeof indexedDB !== "undefined") {
    try { return await openIndexedDbStore(caseId, recordingId); } catch { /* fall through */ }
  }
  return new MemoryChunkStore();
}

/** Recordings with chunks sitting in durable local storage from a session
 *  that never finished uploading -- e.g. the tab crashed or was closed before
 *  Stop. Used to offer "resume/download/discard" on the next page load. */
export async function listOrphanedRecordings(): Promise<OrphanedRecording[]> {
  const [opfs, idb] = await Promise.all([listOpfsOrphans(), listIndexedDbOrphans()]);
  return [...opfs, ...idb];
}

/** Discards a recording's local copy from whichever backend holds it, once
 *  its upload is confirmed complete. Safe to call even if it's in neither. */
export async function forgetRecording(recordingId: string): Promise<void> {
  await Promise.all([deleteOpfsRecording(recordingId), deleteIndexedDbRecording(recordingId)]);
}

/** Reads back an orphaned recording's chunks (from whichever backend has
 *  them) for the crash-recovery flow to offer as a local download. Returns
 *  null if neither backend has anything under this id -- e.g. it was the
 *  in-memory fallback, which by definition can't survive to be recovered. */
export async function readOrphanBlobs(recordingId: string): Promise<{ blobs: Blob[]; kind: ChunkStoreKind } | null> {
  try {
    if (await opfsSupported()) {
      const root = await navigator.storage.getDirectory();
      const sessions = await root.getDirectoryHandle(ROOT_DIR, { create: false }).catch(() => null);
      const dir = await sessions?.getDirectoryHandle(recordingId, { create: false }).catch(() => null);
      if (dir) {
        const blobs = await new OpfsChunkStore(dir).readAll();
        if (blobs.length) return { blobs, kind: "opfs" };
      }
    }
  } catch { /* fall through to IndexedDB */ }
  try {
    if (typeof indexedDB !== "undefined") {
      const db = await openDb();
      const blobs = await new IndexedDbChunkStore(db, recordingId).readAll();
      if (blobs.length) return { blobs, kind: "indexeddb" };
    }
  } catch { /* nothing recoverable */ }
  return null;
}
