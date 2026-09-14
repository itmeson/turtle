/**
 * IndexedDB access — SPEC.md section 9.
 *
 * Thin promise wrapper, no policy. Everything here can fail: private browsing,
 * exhausted quota, a corrupted store, a browser that has decided today is the
 * day. Callers must treat every function as fallible; `available()` reports
 * whether the database opened at all, and `workspace.js` degrades to a
 * localStorage mirror when it did not.
 *
 * The reason this file exists at all is that saving must never touch a network.
 * The failure mode this project is replacing -- "inexplicable loss of progress
 * during save/export" -- is what happens when saving is a request that can fail
 * halfway. Here there is no request.
 */

const DB_NAME = 'turtle-editor';
const DB_VERSION = 1;

export const STORE_PROJECTS = 'projects';
export const STORE_SNAPSHOTS = 'snapshots';
export const STORE_SETTINGS = 'settings';

/** @type {IDBDatabase | null} */
let db = null;
let openFailed = false;

/** @returns {Promise<IDBDatabase|null>} null when IndexedDB is unusable */
export function openDb() {
  if (db) return Promise.resolve(db);
  if (openFailed) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      openFailed = true;
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_PROJECTS)) {
        database.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const store = database.createObjectStore(STORE_SNAPSHOTS, {
          keyPath: 'id', autoIncrement: true,
        });
        store.createIndex('byProject', ['projectId', 'at']);
      }
      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => { db = request.result; resolve(db); };
    request.onerror = () => { openFailed = true; resolve(null); };
    request.onblocked = () => { openFailed = true; resolve(null); };
  });
}

export function available() {
  return db !== null;
}

/**
 * Run one request and report BOTH the value and whether it truly succeeded.
 *
 * For writes the distinction matters and is easy to get wrong: a request can
 * fire `onsuccess` and the transaction can still abort afterwards, which is
 * exactly how a quota error surfaces. So writes resolve on `tx.oncomplete`,
 * not on `request.onsuccess`. Reporting a save that later aborted is the
 * failure this whole project was built to avoid.
 *
 * @param {string} store
 * @param {IDBTransactionMode} mode
 * @param {(s: IDBObjectStore) => IDBRequest} work
 * @returns {Promise<{ok: boolean, value: any}>}
 */
async function runRequest(store, mode, work) {
  const database = await openDb();
  if (!database) return { ok: false, value: null };

  return new Promise((resolve) => {
    let tx;
    try {
      tx = database.transaction(store, mode);
    } catch {
      resolve({ ok: false, value: null });
      return;
    }

    let request;
    try {
      request = work(tx.objectStore(store));
    } catch {
      resolve({ ok: false, value: null });
      return;
    }

    let value = null;
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, value });
    };

    request.onsuccess = () => {
      value = request.result ?? null;
      // Reads are done here; writes must wait for the transaction to commit.
      if (mode === 'readonly') settle(true);
    };
    request.onerror = () => settle(false);
    tx.oncomplete = () => settle(true);
    tx.onerror = () => settle(false);
    tx.onabort = () => settle(false);
  });
}

/** Value-only helper for reads. */
async function withStore(store, mode, work) {
  return (await runRequest(store, mode, work)).value;
}

/** Success-only helper for writes. */
async function writeStore(store, work) {
  return (await runRequest(store, 'readwrite', work)).ok;
}

/* ------------------------------------------------------------- projects */

/** @typedef {{id:string, name:string, code:string, createdAt:number, updatedAt:number}} Project */

/** @param {string} id @returns {Promise<Project|null>} */
export const getProject = (id) =>
  withStore(STORE_PROJECTS, 'readonly', (s) => s.get(id));

/** @param {Project} project @returns {Promise<boolean>} did it actually commit? */
export const putProject = (project) =>
  writeStore(STORE_PROJECTS, (s) => s.put(project));

/**
 * @returns {Promise<Project[]>} newest-created first, and STABLE
 *
 * Ordered by `createdAt`, not `updatedAt`, and that is the whole point.
 *
 * Sorting by last-edited seems friendlier and is not: the list reorders itself
 * underneath a student who is looking at it. Opening a program writes the one
 * they just left, editing a character moves the current one to the top, and the
 * list they are reading rearranges between one glance and the next. It looks
 * random because the thing being ordered is invisible.
 *
 * Creation order never changes. A new program appears at the top and then stays
 * exactly where it is for the rest of the year, which is what makes a list
 * findable. `updatedAt` is still shown on each row -- it is just not what
 * decides position.
 *
 * The id tiebreak keeps two programs created in the same millisecond from
 * swapping places between renders.
 */
export async function listProjects() {
  const all = await withStore(STORE_PROJECTS, 'readonly', (s) => s.getAll());
  if (!Array.isArray(all)) return [];
  return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    || String(a.id).localeCompare(String(b.id)));
}

export const deleteProject = (id) =>
  writeStore(STORE_PROJECTS, (s) => s.delete(id));

/* ------------------------------------------------------------ snapshots */

/** @typedef {{id?:number, projectId:string, code:string, at:number}} Snapshot */

/** @param {Snapshot} snapshot @returns {Promise<boolean>} */
export const addSnapshot = (snapshot) =>
  writeStore(STORE_SNAPSHOTS, (s) => s.add(snapshot));

/** @param {string} projectId @returns {Promise<Snapshot[]>} newest first */
export async function listSnapshots(projectId) {
  const database = await openDb();
  if (!database) return [];
  return new Promise((resolve) => {
    let tx;
    try {
      tx = database.transaction(STORE_SNAPSHOTS, 'readonly');
    } catch {
      resolve([]);
      return;
    }
    const index = tx.objectStore(STORE_SNAPSHOTS).index('byProject');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const rows = Array.isArray(request.result) ? request.result : [];
      rows.sort((a, b) => b.at - a.at);
      resolve(rows);
    };
    request.onerror = () => resolve([]);
    tx.onabort = () => resolve([]);
  });
}

/** Keep only the newest `keep` snapshots for a project. */
export async function pruneSnapshots(projectId, keep) {
  const rows = await listSnapshots(projectId);
  const doomed = rows.slice(keep);
  for (const row of doomed) {
    // eslint-disable-next-line no-await-in-loop
    await writeStore(STORE_SNAPSHOTS, (s) => s.delete(row.id));
  }
  return doomed.length;
}

export async function deleteSnapshotsFor(projectId) {
  const rows = await listSnapshots(projectId);
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await writeStore(STORE_SNAPSHOTS, (s) => s.delete(row.id));
  }
}

/* ------------------------------------------------------------- settings */

export async function getSetting(key, fallback = null) {
  const row = await withStore(STORE_SETTINGS, 'readonly', (s) => s.get(key));
  return row && 'value' in row ? row.value : fallback;
}

export const setSetting = (key, value) =>
  writeStore(STORE_SETTINGS, (s) => s.put({ key, value }));
