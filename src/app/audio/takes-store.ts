// Recorded audio lives in IndexedDB (too big for localStorage); the song keeps only each take's
// id, position and waveform peaks.

export interface TakeAudio {
  sampleRate: number;
  channels: Float32Array[];
}

const DB = 'klinke';
const STORE = 'takes';

let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const store = (await open()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = work(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const putTake = (id: string, audio: TakeAudio) => run('readwrite', (s) => s.put(audio, id));
export const getTake = (id: string) => run<TakeAudio | undefined>('readonly', (s) => s.get(id));
export const deleteTake = (id: string) => run('readwrite', (s) => s.delete(id));
export const takeIds = async () => (await run('readonly', (s) => s.getAllKeys())).map(String);
