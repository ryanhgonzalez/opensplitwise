import { useState } from 'react';
import { useMatch } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import AddExpenseSheet from './AddExpenseSheet';

/**
 * The Add button in the tab bar and the sidebar: opens the Add expense sheet,
 * starting in the group being viewed, if any.
 */
export function useAddExpense() {
  const [open, setOpen] = useState(false);
  // The group page and anything under it (an expense, sharing).
  const groupId = useMatch('/groups/:id/*')?.params.id;

  const sheet = (
    <AnimatePresence>
      {open && <AddExpenseSheet open={open} onClose={() => setOpen(false)} defaultGroupId={groupId} />}
    </AnimatePresence>
  );
  return { openAddExpense: () => setOpen(true), addExpenseSheet: sheet };
}
