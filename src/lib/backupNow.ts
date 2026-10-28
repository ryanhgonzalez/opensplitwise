import { dataSnapshot, useStore } from '../store';
import { selectFriendBalances } from '../store/selectors';
import { buildFullExport, downloadExport } from './dataExport';
import { markBackedUp } from './dataSafety';
import { photosFor } from './receiptPhotos';

/**
 * Downloads a full backup, receipt photos included, and records it as the
 * latest backup. The one-tap path used by the reminder and Settings; the
 * Export sheet is where photos can be left out.
 */
export async function downloadFullBackup(): Promise<void> {
  const s = useStore.getState();
  const withPhotos = s.expenses.filter((e) => e.receipt).map((e) => e.id);
  const receipts = withPhotos.length ? await photosFor(withPhotos) : undefined;
  downloadExport(
    buildFullExport({ ...dataSnapshot(s), friendBalances: selectFriendBalances(s), receipts }),
  );
  markBackedUp();
}
