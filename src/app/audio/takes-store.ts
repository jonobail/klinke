// Recorded audio and saved projects live in IndexedDB (too big for localStorage). The song keeps
// only each take's id, position and waveform peaks; the audio is stored under the open project
// (`<project id>/<take id>`), so every project keeps its own takes.

export interface TakeAudio {
  sampleRate: number;
  channels: Float32Array[];
}

const DB = 'klinke';
const TAKES = 'takes';
export const PROJECTS = 'projects';
/** The open project's id, so the app opens where it left off. */
const CURRENT_KEY = 'klinke.project';
/** Takes recorded before projects existed belong to the first project, which gets this id. */
export const FIRST_PROJECT = 'p1';

let db: Promise<IDBDatabase> | undefined;
let project = readCurrent();

function readCurrent(): string {
  try {
    return localStorage.getItem(CURRENT_KEY) || FIRST_PROJECT;
  } catch {
    return FIRST_PROJECT;
  }
}

/** The project takes are read from and recorded into. */
export const currentProject = () => project;

export function setCurrentProject(id: string) {
  project = id;
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    // Private mode: the app opens the first project next time.
  }
}

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) d.createObjectStore(TAKES);
      if (e.oldVersion < 2) d.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (e.oldVersion === 1) {
        // Version 1 kept takes by bare id: they move into the first project.
        const takes = req.transaction!.objectStore(TAKES);
        const cursor = takes.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const key = String(c.key);
          if (!key.includes('/')) {
            takes.put(c.value, `${FIRST_PROJECT}/${key}`);
            c.delete();
          }
          c.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

export async function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const store = (await open()).transaction(storeName, mode).objectStore(storeName);
  return new Promise((resolve, reject) => {
    const req = work(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const key = (id: string, of = project) => `${of}/${id}`;
const inProject = (of: string) => IDBKeyRange.bound(`${of}/`, `${of}/￿`);

export const putTake = (id: string, audio: TakeAudio, of = project) =>
  run(TAKES, 'readwrite', (s) => s.put(audio, key(id, of)));
export const getTake = (id: string, of = project) =>
  run<TakeAudio | undefined>(TAKES, 'readonly', (s) => s.get(key(id, of)));

/**
 * Clearing a track's takes keeps their audio until the project is next opened (see `purgeTakes`),
 * so UNDO can bring them back.
 */
export const deleteTake = async (_id: string) => undefined;

/** Ids of the takes kept for a project. */
export async function takeIds(of = project): Promise<string[]> {
  const keys = await run(TAKES, 'readonly', (s) => s.getAllKeys(inProject(of)));
  return keys.map((k) => String(k).slice(of.length + 1));
}

/** Drops a project's audio that its song no longer refers to. */
export async function purgeTakes(of: string, used: ReadonlySet<string>) {
  for (const id of await takeIds(of))
    if (!used.has(id)) await run(TAKES, 'readwrite', (s) => s.delete(key(id, of)));
}

/** Drops every take of a project (it's being deleted). */
export const deleteProjectTakes = (of: string) =>
  run(TAKES, 'readwrite', (s) => s.delete(inProject(of)));

/** Copies a project's takes to another project (duplicating it). */
export async function copyTakes(from: string, to: string) {
  for (const id of await takeIds(from)) {
    const audio = await getTake(id, from);
    if (audio) await putTake(id, audio, to);
  }
}
