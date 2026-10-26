import { useState } from 'react';
import { useStore } from '../store';
import { showToast } from '../lib/toast';

/**
 * Makes and downloads a group's PDF report. Shared by the group page and
 * Settings. `makingId` is the group whose report is being made, if any.
 */
export function useGroupReport() {
  const [makingId, setMakingId] = useState<string | null>(null);

  const downloadReport = async (groupId: string) => {
    if (makingId) return;
    setMakingId(groupId);
    try {
      // Read at the moment of download, so the report has the latest records.
      const { groups, expenses, settlements, users } = useStore.getState();
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      // Completed payments change who still owes what; the report must apply them.
      const payments = settlements.filter((s) => s.groupId === groupId);
      const { generateGroupReport } = await import('../lib/groupReport');
      await generateGroupReport(group, expenses.filter((e) => e.groupId === groupId), users, payments);
    } catch {
      showToast({ message: "Couldn't make the report. Try again." });
    } finally {
      setMakingId(null);
    }
  };

  return { downloadReport, makingId };
}
