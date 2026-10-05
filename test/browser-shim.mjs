// 最小浏览器环境 shim
Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2, 10) },
  configurable: true
});

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }
};

globalThis.window = {
  setTimeout: (fn, t) => setTimeout(fn, t),
  clearTimeout: (t) => clearTimeout(t),
  addEventListener() {},
  removeEventListener() {}
};

const channels = new Set();
globalThis.BroadcastChannel = class {
  constructor() { channels.add(this); }
  onmessage = null;
  postMessage() {}
};
globalThis.window.BroadcastChannel = globalThis.BroadcastChannel;
globalThis.__pushChannel = (msg) => channels.forEach((c) => c.onmessage && c.onmessage({ data: msg }));

// ── 内存版 IndexedDB ──
const dbData = { snapshots: new Map(), tombstones: new Map(), exports: new Map(), checkpoints: new Map() };

const makeStore = (name) => {
  const map = dbData[name];
  return {
    put(value, key) {
      map.set(key !== undefined ? key : value.id, structuredClone(value));
      const req = { onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    get(key) {
      const req = { onsuccess: null, onerror: null, result: map.has(key) ? structuredClone(map.get(key)) : undefined };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    getAll() {
      const req = { onsuccess: null, onerror: null, result: [...map.values()].map((v) => structuredClone(v)) };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    getAllKeys() {
      const req = { onsuccess: null, onerror: null, result: [...map.keys()] };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    delete(key) {
      map.delete(key);
      const req = { onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    }
  };
};

const makeTx = (names, mode) => {
  const tx = { oncomplete: null, onerror: null, onabort: null, _mode: mode,
    objectStore: (name) => makeStore(name) };
  // 模拟真实 IDB：complete 是事务结束事件，晚于全部请求回调与 await 续体
  setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
  return tx;
};

const healthyIDB = {
  open() {
    const req = {
      onsuccess: null, onerror: null,
      result: {
        transaction: (names, mode) => makeTx(names, mode),
        close() {},
        objectStoreNames: { contains: (n) => n in dbData }
      }
    };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  }
};

globalThis.__idbFail = false;
globalThis.indexedDB = {
  open() {
    if (!globalThis.__idbFail) return healthyIDB.open();
    // eslint-disable-next-line no-console
    const fail = new Error('磁盘写入失败（模拟）');
    const req = {
      onsuccess: null, onerror: null,
      result: {
        transaction() {
          let aborted = false;
          const tx = {
            oncomplete: null, onerror: null, onabort: null, error: fail,
            objectStore() {
              const failingRequest = () => {
                const r = { onsuccess: null, onerror: null, error: fail, result: undefined };
                queueMicrotask(() => {
                  aborted = true;
                  if (r.onerror) r.onerror(fail);
                  if (tx.onerror) tx.onerror(fail);
                  if (tx.onabort) tx.onabort(fail);
                });
                return r;
              };
              return { put: failingRequest, getAll: failingRequest, get: failingRequest, delete: failingRequest };
            }
          };
          // 真实 IDB 中 complete 晚于请求回调：双跳微任务，且失败时不触发
          queueMicrotask(() => queueMicrotask(() => { if (!aborted && tx.oncomplete) tx.oncomplete(); }));
          return tx;
        },
        close() {}, objectStoreNames: { contains: () => true }
      }
    };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  }
};
globalThis.__dbData = dbData;
globalThis.window.indexedDB = globalThis.indexedDB;
