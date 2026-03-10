import { Project } from '../types';

const DB_NAME = 'clinical-ai-db';
const DB_VERSION = 1;
const STORE_NAME = 'app-state';
const PROJECTS_KEY = 'projects';

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);

    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.oncomplete = () => db.close();

    operation(store, resolve, reject);
  });
};

export const loadProjectsFromIndexedDb = async (): Promise<Project[] | null> =>
  withStore<Project[] | null>('readonly', (store, resolve, reject) => {
    const request = store.get(PROJECTS_KEY);
    request.onsuccess = () => {
      const result = request.result;
      resolve(Array.isArray(result) ? (result as Project[]) : null);
    };
    request.onerror = () => reject(request.error || new Error('Failed to load projects from IndexedDB.'));
  });

export const saveProjectsToIndexedDb = async (projects: Project[]): Promise<void> =>
  withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.put(projects, PROJECTS_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Failed to save projects to IndexedDB.'));
  });

export const clearProjectsInIndexedDb = async (): Promise<void> =>
  withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.delete(PROJECTS_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Failed to clear projects from IndexedDB.'));
  });
