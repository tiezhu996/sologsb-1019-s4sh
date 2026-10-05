import type { PersistedEnvelope, WithdrawalCheckpoint } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'current';
const CHECKPOINT_STORE = 'checkpoints';
const CHECKPOINT_KEY = 'withdrawal-pending';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) db.createObjectStore(CHECKPOINT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function readEnvelope(): Promise<PersistedEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeEnvelope(envelope: PersistedEnvelope): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(envelope, SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** 撤回检查点的 IndexedDB 镜像，localStorage 不可用时仍可恢复。 */
export async function writeCheckpointMirror(checkpoint: WithdrawalCheckpoint): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    tx.objectStore(CHECKPOINT_STORE).put(checkpoint, CHECKPOINT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function readCheckpointMirror(): Promise<WithdrawalCheckpoint | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
    const request = tx.objectStore(CHECKPOINT_STORE).get(CHECKPOINT_KEY);
    request.onsuccess = () => resolve((request.result as WithdrawalCheckpoint | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function clearCheckpointMirror(): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    tx.objectStore(CHECKPOINT_STORE).delete(CHECKPOINT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
