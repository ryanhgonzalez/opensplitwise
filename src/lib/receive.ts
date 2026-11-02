import { useCallback, useState } from 'react';
import { dataSnapshot, useStore } from '../store';
import {
  defaultChoice,
  matchPeople,
  mergeNeedsYou,
  type GroupBundle,
  type MergeOptions,
  type MergeSummary,
  type PeopleChoice,
  type SyncState,
} from './groupSync';
import { decompressBundle, parseBundle } from './groupShare';
import { loadPhoto, savePhotos } from './receiptPhotos';
import { useRecentSwap } from './recentSwap';

// ─────────────────────────────────────────────────────────────────────────────
// Taking in someone's group, from their code or a file, for the Scan and Swap
// pages. It merges straight away unless something needs the person here
// (mergeNeedsYou), and keeps what it needs to undo the merge.
// ─────────────────────────────────────────────────────────────────────────────

export interface Received {
  bundle: GroupBundle;
  summary: MergeSummary;
  /** This phone's records before the merge, for Undo. */
  before: SyncState;
  /** How many code parts it came in; 0 for a file. */
  parts: number;
}

/** Merges, saves the receipt photos that came with a file, and notes what came in. */
export async function mergeNow(
  bundle: GroupBundle,
  choice: PeopleChoice,
  options: MergeOptions,
  parts: number,
): Promise<Received> {
  const before = dataSnapshot(useStore.getState());
  const summary = useStore.getState().applyGroupBundle(bundle, choice, options);
  // Photos for expenses taken from them, and any this phone has none for. A
  // newer photo here is never overwritten.
  if (bundle.receipts) {
    const take = new Set(summary.receivedIds);
    for (const id of Object.keys(bundle.receipts)) {
      if (!take.has(id) && !(await loadPhoto(id).catch(() => undefined))) take.add(id);
    }
    await savePhotos(bundle.receipts, take).catch(() => {});
  }
  const fresh = new Set(summary.newIds);
  useRecentSwap.getState().mark(bundle.group.id, summary.newIds, summary.receivedIds.filter((id) => !fresh.has(id)));
  return { bundle, summary, before, parts };
}

/** Puts this phone back as it was before the merge. */
export function undoReceived(r: Received): void {
  useStore.getState().undoMerge(r.before);
  useRecentSwap.getState().clear();
}

/** Who sent it, by this phone's name for them (first name), else as their phone had it. */
export function senderName(r: Pick<Received, 'bundle' | 'summary'>): string {
  const localId = r.summary.peopleIds[r.bundle.senderId];
  const name =
    useStore.getState().users.find((u) => u.id === localId)?.name ??
    r.bundle.users.find((u) => u.id === r.bundle.senderId)?.name;
  return name?.trim().split(/\s+/)[0] || 'your friend';
}

/** "3 new, 1 changed", or "nothing new". */
export function changesText(c: { added: number; updated: number; deleted: number }): string {
  const parts = [
    c.added > 0 && `${c.added} new`,
    c.updated > 0 && `${c.updated} changed`,
    c.deleted > 0 && `${c.deleted} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing new';
}

/**
 * Receiving on a page: take a scanned payload or a file, merge it or hold it
 * for review, and report problems. `onReceived` gets each finished merge.
 */
export function useReceive(onReceived: (r: Received) => void) {
  /** Waiting for the person to check people or edits before merging. */
  const [review, setReview] = useState<{ bundle: GroupBundle; parts: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** False when it can't be used, so scanning carries on. */
  const take = useCallback(
    async (bundle: GroupBundle, parts: number): Promise<boolean> => {
      setError(null);
      const state = dataSnapshot(useStore.getState());
      // A reply holds only what one phone was missing: useless without the group.
      if (bundle.reply && !state.groups.some((g) => g.id === bundle.group.id)) {
        const name = bundle.users.find((u) => u.id === bundle.senderId)?.name.split(' ')[0] ?? 'they';
        setError(
          `That code was ${name}’s reply in a swap with someone else, so it only has part of ${bundle.group.name}. ` +
            `Ask ${name} to open the group and tap Swap, then scan that code.`,
        );
        return false;
      }
      if (mergeNeedsYou(state, bundle)) {
        setReview({ bundle, parts });
        return true;
      }
      onReceived(await mergeNow(bundle, defaultChoice(matchPeople(state, bundle)), {}, parts));
      return true;
    },
    [onReceived],
  );

  const takePayload = useCallback(
    async (payload: Uint8Array, parts: number): Promise<boolean> => {
      try {
        return await take(await decompressBundle(payload), parts);
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [take],
  );

  const takeFile = useCallback(
    async (file: File): Promise<boolean> => {
      try {
        return await take(parseBundle(await file.text()), 0);
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [take],
  );

  const finishReview = useCallback(
    (r: Received) => {
      setReview(null);
      onReceived(r);
    },
    [onReceived],
  );

  return { review, error, takePayload, takeFile, finishReview, cancelReview: () => setReview(null) };
}
