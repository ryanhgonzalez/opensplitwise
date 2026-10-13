// ─────────────────────────────────────────────────────────────────────────────
// Receipt photos, kept with their expense.
//
// The rest of the app's data lives in localStorage, which holds about 5 MB in
// all, so photos go in IndexedDB instead, keyed by expense id. The expense
// itself only records that it has one (`Expense.receipt`).
//
// Photos are made small before they're kept: black and white JPEG, at most
// 1600 px on the long side, about 80–150 KB. Receipts are printed black text,
// so colour adds size, not information.
//
// Deleting a photo is never done one by one: `removeOrphanPhotos` drops any
// photo whose expense no longer has one, which covers deleting an expense or
// a group, merges, restores and wiping in one place.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'opensplitwise';
const STORE = 'receipts';

interface StoredPhoto {
  blob: Blob;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open (private mode, blocked storage) shouldn't stick.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = run(store);
    store.transaction.oncomplete = () => resolve(req ? req.result : undefined);
    store.transaction.onerror = () => reject(store.transaction.error);
    store.transaction.onabort = () => reject(store.transaction.error);
  });
}

export async function savePhoto(expenseId: string, blob: Blob): Promise<void> {
  await tx('readwrite', (s) => s.put({ blob, savedAt: Date.now() } satisfies StoredPhoto, expenseId));
}

export async function loadPhoto(expenseId: string): Promise<Blob | undefined> {
  const record = (await tx<StoredPhoto | undefined>('readonly', (s) => s.get(expenseId))) as StoredPhoto | undefined;
  return record?.blob;
}

/**
 * Deletes photos no expense refers to any more. Photos saved in the last
 * minute are spared: a new expense's photo is saved just after the expense,
 * and this may run in between.
 */
export async function removeOrphanPhotos(keep: Set<string>): Promise<number> {
  const keys = ((await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? []) as string[];
  const stale: string[] = [];
  for (const key of keys) {
    if (keep.has(key)) continue;
    const record = (await tx<StoredPhoto | undefined>('readonly', (s) => s.get(key))) as StoredPhoto | undefined;
    if (!record || Date.now() - record.savedAt > 60_000) stale.push(key);
  }
  if (stale.length) await tx('readwrite', (s) => void stale.forEach((key) => s.delete(key)));
  return stale.length;
}

// ─── Making a photo small ─────────────────────────────────────────────────────

/** Longest side kept: enough to read every line of a long receipt. */
const MAX_SIDE = 1600;
const QUALITY = 0.72;

/** A photo of a receipt as it's kept: black and white JPEG, at most 1600 px on the long side. */
export async function compressReceiptPhoto(file: Blob): Promise<Blob> {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  img.close();

  // Grey by hand: canvas filters aren't available in every Safari.
  const pixels = ctx.getImageData(0, 0, w, h);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = grey;
  }
  ctx.putImageData(pixels, 0, 0);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t save the photo.'))), 'image/jpeg', QUALITY),
  );
}

// ─── Photos inside files (backups, shared groups) ─────────────────────────────

/** expense id → photo as a data: URL, for JSON files. */
export type PhotoMap = Record<string, string>;

export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

/** The photos of these expenses, as data: URLs; missing photos are skipped. */
export async function photosFor(expenseIds: string[]): Promise<PhotoMap> {
  const out: PhotoMap = {};
  for (const id of expenseIds) {
    const blob = await loadPhoto(id).catch(() => undefined);
    if (blob) out[id] = await blobToDataUrl(blob);
  }
  return out;
}

/** Saves photos from a file; `only` limits which expenses' photos are taken. */
export async function savePhotos(photos: PhotoMap | undefined, only?: Set<string>): Promise<number> {
  let saved = 0;
  for (const [id, url] of Object.entries(photos ?? {})) {
    if (only && !only.has(id)) continue;
    if (!url.startsWith('data:image/')) continue;
    await savePhoto(id, await dataUrlToBlob(url));
    saved++;
  }
  return saved;
}

/** "1.4 MB", "320 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
