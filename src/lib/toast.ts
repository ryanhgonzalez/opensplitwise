import { create } from 'zustand';

/**
 * One short message at the bottom of the screen, optionally with an action
 * ("Deleted 'Dinner' · Undo"). A new toast replaces the current one.
 */
export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  /** How long it stays, in ms. */
  duration: number;
}

interface ToastStore {
  toast: Toast | null;
  show: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => void;
  hide: (id?: number) => void;
}

let seq = 0;

export const useToast = create<ToastStore>((set, get) => ({
  toast: null,
  show: (toast) => set({ toast: { duration: 8000, ...toast, id: ++seq } }),
  // With an id, only hides that toast, so a timer can't close a newer one.
  hide: (id) => {
    if (id === undefined || get().toast?.id === id) set({ toast: null });
  },
}));

export const showToast = (toast: Parameters<ToastStore['show']>[0]) => useToast.getState().show(toast);
