import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useToast } from '../lib/toast';
import './ToastHost.css';

/** Shows the current toast (src/lib/toast.ts). Rendered once, at the app root. */
export default function ToastHost() {
  const toast = useToast((s) => s.toast);
  const hide = useToast((s) => s.hide);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => hide(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast, hide]);

  return (
    <div className="toast-host" aria-live="polite">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.18 }}
          >
            <span className="toast-message">{toast.message}</span>
            {toast.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.action!.run();
                  hide(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
