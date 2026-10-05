import type { PersistedEnvelope, WithdrawCheckpoint, WithdrawalRecord } from '../types';
import { applyTombstoneToState } from './withdrawal';

const DB_NAME = 'sologsb-1019-coding';
const DB_VERSION = 2;
const SNAPSHOTS = 'snapshots';
const TOMBSTONES = 'tombstones';
const EXPORTS = 'exports';
const CHECKPOINTS = 'checkpoints';
const SNAPSHOT_KEY = 'current';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
      if (!db.objectStoreNames.contains(TOMBSTONES)) db.createObjectStore(TOMBSTONES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(EXPORTS)) db.createObjectStore(EXPORTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHECKPOINTS)) db.createObjectStore(CHECKPOINTS, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const txAsPromise = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export interface SavedExport {
  id: string;
  at: string;
  format: 'json' | 'csv';
  fileName: string;
  transcriptIds: string[];
  content: string;
}

export async function readEnvelope(): Promise<PersistedEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    const tx = db.transaction(SNAPSHOTS, 'readonly');
    const result = await new Promise<unknown>((resolve, reject) => {
      const request = tx.objectStore(SNAPSHOTS).get(SNAPSHOT_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
    return (result as PersistedEnvelope | undefined) ?? null;
  } finally {
    db.close();
  }
}

/**
 * 写入快照前在同一个读写事务内读取墓碑并清洗内容，
 * 保证即使晚到的旧标签页写入，也无法把已撤回原文重新持久化。
 */
export async function writeEnvelope(envelope: PersistedEnvelope): Promise<void> {
  if (!('indexedDB' in window)) {
    sanitizeWithMemoryTombstones(envelope);
    return;
  }
  const db = await openDatabase();
  try {
    const tx = db.transaction([SNAPSHOTS, TOMBSTONES], 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const tombstoneStore = tx.objectStore(TOMBSTONES);
      const request = tombstoneStore.getAll();
      request.onsuccess = () => {
        try {
          const records = (request.result as WithdrawalRecord[] | undefined) ?? [];
          records.forEach((record) => applyTombstoneToState(envelope.state, record));
          tx.objectStore(SNAPSHOTS).put(envelope, SNAPSHOT_KEY);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
  } finally {
    db.close();
  }
}

export async function readTombstones(): Promise<WithdrawalRecord[]> {
  if (!('indexedDB' in window)) return readMemoryTombstones();
  const db = await openDatabase();
  try {
    const tx = db.transaction(TOMBSTONES, 'readonly');
    const result = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore(TOMBSTONES).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
    return result as WithdrawalRecord[];
  } finally {
    db.close();
  }
}

/** 撤回提交：墓碑与清洗后的状态在同一个事务内落盘，避免半成功状态 */
export async function commitWithdrawal(record: WithdrawalRecord, envelope: PersistedEnvelope): Promise<void> {
  if (!('indexedDB' in window)) {
    sanitizeWithMemoryTombstones(envelope, record);
    return;
  }
  const db = await openDatabase();
  try {
    const tx = db.transaction([SNAPSHOTS, TOMBSTONES, EXPORTS], 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const tombstoneStore = tx.objectStore(TOMBSTONES);
      const request = tombstoneStore.getAll();
      request.onsuccess = () => {
        try {
          const records = (request.result as WithdrawalRecord[] | undefined) ?? [];
          if (!records.some((item) => item.id === record.id)) records.push(record);
          records.forEach((item) => applyTombstoneToState(envelope.state, item));
          tx.objectStore(TOMBSTONES).put(record);
          tx.objectStore(SNAPSHOTS).put(envelope, SNAPSHOT_KEY);
          const exportStore = tx.objectStore(EXPORTS);
          const exportRequest = exportStore.getAll();
          exportRequest.onsuccess = () => {
            const saved = (exportRequest.result as SavedExport[] | undefined) ?? [];
            saved
              .filter((item) => item.transcriptIds.includes(record.transcriptId))
              .forEach((item) => exportStore.delete(item.id));
            resolve();
          };
          exportRequest.onerror = () => reject(exportRequest.error);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
  } finally {
    db.close();
  }
}

export async function listExports(): Promise<SavedExport[]> {
  if (!('indexedDB' in window)) return readMemoryExports();
  const db = await openDatabase();
  try {
    const tx = db.transaction(EXPORTS, 'readonly');
    const result = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore(EXPORTS).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
    return result as SavedExport[];
  } finally {
    db.close();
  }
}

/** 保存工作台内导出物；若包含已被撤回的访谈则拒绝，避免原文经导出通道复活 */
export async function saveExport(saved: SavedExport): Promise<void> {
  if (!('indexedDB' in window)) {
    if (memoryExportBlocked(saved.transcriptIds)) throw new Error('导出包含已撤回访谈，已阻止保存');
    memoryExports.push(saved);
    return;
  }
  const db = await openDatabase();
  try {
    const tx = db.transaction([EXPORTS, TOMBSTONES], 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = tx.objectStore(TOMBSTONES).getAll();
      request.onsuccess = () => {
        const records = (request.result as WithdrawalRecord[] | undefined) ?? [];
        if (records.some((record) => saved.transcriptIds.includes(record.transcriptId))) {
          reject(new Error('导出包含已撤回访谈，已阻止保存'));
          return;
        }
        tx.objectStore(EXPORTS).put(saved);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
  } finally {
    db.close();
  }
}

export async function deleteExportsForTranscript(transcriptId: string): Promise<SavedExport[]> {
  if (!('indexedDB' in window)) {
    const removed = memoryExports.filter((item) => item.transcriptIds.includes(transcriptId));
    memoryExports = memoryExports.filter((item) => !item.transcriptIds.includes(transcriptId));
    return removed;
  }
  const db = await openDatabase();
  try {
    const tx = db.transaction(EXPORTS, 'readwrite');
    const removed = await new Promise<SavedExport[]>((resolve, reject) => {
      const request = tx.objectStore(EXPORTS).getAll();
      request.onsuccess = () => {
        const saved = (request.result as SavedExport[] | undefined) ?? [];
        const matched = saved.filter((item) => item.transcriptIds.includes(transcriptId));
        matched.forEach((item) => tx.objectStore(EXPORTS).delete(item.id));
        resolve(matched);
      };
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
    return removed;
  } finally {
    db.close();
  }
}

export async function saveCheckpoint(checkpoint: WithdrawCheckpoint): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    const tx = db.transaction(CHECKPOINTS, 'readwrite');
    tx.objectStore(CHECKPOINTS).put(checkpoint);
    await txAsPromise(tx);
  } finally {
    db.close();
  }
}

export async function readCheckpoint(): Promise<WithdrawCheckpoint | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    const tx = db.transaction(CHECKPOINTS, 'readonly');
    const result = await new Promise<unknown>((resolve, reject) => {
      const request = tx.objectStore(CHECKPOINTS).getAllKeys();
      request.onsuccess = async () => {
        const keys = request.result as IDBValidKey[];
        if (!keys.length) {
          resolve(null);
          return;
        }
        const getRequest = tx.objectStore(CHECKPOINTS).get(keys[0]);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
    await txAsPromise(tx);
    return (result as WithdrawCheckpoint | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function deleteCheckpoint(id: string): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    const tx = db.transaction(CHECKPOINTS, 'readwrite');
    tx.objectStore(CHECKPOINTS).delete(id);
    await txAsPromise(tx);
  } finally {
    db.close();
  }
}

// 无 IndexedDB 环境（隐私模式等）的内存兜底
let memoryTombstones: WithdrawalRecord[] = [];
let memoryExports: SavedExport[] = [];

const memoryExportBlocked = (transcriptIds: string[]) =>
  memoryTombstones.some((record) => transcriptIds.includes(record.transcriptId));

const sanitizeWithMemoryTombstones = (envelope: PersistedEnvelope, extra?: WithdrawalRecord) => {
  [...memoryTombstones, ...(extra ? [extra] : [])].forEach((record) => applyTombstoneToState(envelope.state, record));
  if (extra && !memoryTombstones.some((record) => record.id === extra.id)) memoryTombstones.push(extra);
};

const readMemoryTombstones = () => memoryTombstones;
const readMemoryExports = () => memoryExports;
