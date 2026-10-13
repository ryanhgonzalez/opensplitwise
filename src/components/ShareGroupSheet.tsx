import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { buildBundle, type GroupBundle } from '../lib/groupSync';
import { compressBundle, sendBundleFile, toFrames } from '../lib/groupShare';
import '../styles/sheet.css';
import './GroupShare.css';

interface ShareGroupSheetProps {
  open: boolean;
  onClose: () => void;
  groupId: string;
}

/** How long each frame of the code stays on screen. */
const FRAME_MS = 300;

/**
 * Sends a group to someone's phone: as a cycling QR code they scan in the app
 * (together, no internet needed), or as a file through the share sheet.
 */
export default function ShareGroupSheet({ open, onClose, groupId }: ShareGroupSheetProps) {
  const [tab, setTab] = useState<'code' | 'file'>('code');
  const [bundle, setBundle] = useState<GroupBundle | null>(null);
  const [frames, setFrames] = useState<Uint8Array[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Pack the group as it is right now, each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const s = useStore.getState();
    const b = buildBundle(
      {
        currentUserId: s.currentUserId,
        users: s.users,
        groups: s.groups,
        expenses: s.expenses,
        settlements: s.settlements,
        activities: s.activities,
        tombstones: s.tombstones,
        userAliases: s.userAliases,
        groupSyncedAt: s.groupSyncedAt,
      },
      groupId,
    );
    setBundle(b);
    setSent(false);
    setError(null);
    if (b) {
      compressBundle(b)
        .then((payload) => live && setFrames(toFrames(payload)))
        .catch((err: Error) => live && setError(err.message));
    }
    return () => {
      live = false;
    };
  }, [open, groupId]);

  // Cycle through the frames.
  useEffect(() => {
    if (!open || tab !== 'code' || frames.length < 2) return;
    const timer = setInterval(() => setFrameIndex((i) => (i + 1) % frames.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [open, tab, frames]);

  // Draw the current frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frames[frameIndex % Math.max(frames.length, 1)];
    if (!canvas || !frame || tab !== 'code') return;
    let live = true;
    import('qrcode').then((QR) => {
      if (!live) return;
      QR.toCanvas(canvas, [{ data: frame, mode: 'byte' }], {
        errorCorrectionLevel: 'L',
        margin: 2,
        width: Math.min(340, window.innerWidth - 64),
        color: { dark: '#000000', light: '#ffffff' },
      }).catch((err: Error) => setError(err.message));
    });
    return () => {
      live = false;
    };
  }, [frames, frameIndex, tab]);

  const sendFile = async () => {
    if (!bundle) return;
    if (await sendBundleFile(bundle)) setSent(true);
  };

  const expenseCount = bundle?.expenses.length ?? 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            className="sheet-panel"
            role="dialog"
            aria-label="Share group"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">Share {bundle?.group.name ?? 'group'}</span>
              <button className="sheet-close" onClick={onClose} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="sheet-body">
              <div className="gs-tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
                  Show code
                </button>
                <button role="tab" aria-selected={tab === 'file'} className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>
                  Send file
                </button>
              </div>

              {error && <p className="gs-error">{error}</p>}

              {tab === 'code' ? (
                <div className="gs-code">
                  <p className="gs-lead">
                    On their phone: <strong>Groups → Receive → Scan code</strong>, then point the camera here.
                  </p>
                  <div className="gs-qr-wrap">
                    <canvas ref={canvasRef} className="gs-qr" aria-label="Group code, changing several times a second" />
                  </div>
                  <p className="gs-meta num">
                    {frames.length > 1 ? `Part ${frameIndex + 1} of ${frames.length}` : frames.length ? 'One part' : 'Preparing…'}
                    {' · '}
                    {expenseCount} {expenseCount === 1 ? 'expense' : 'expenses'}
                  </p>
                  <p className="gs-hint">
                    The code changes several times a second; keep it in view until their phone has every part. Turning
                    your screen brightness up helps. Sharing again later sends what's new and changed.
                  </p>
                </div>
              ) : (
                <div className="gs-file">
                  <p className="gs-lead">
                    For when you're not together: send the group as a file with AirDrop, Messages or email. They open
                    it from <strong>Groups → Receive → Open file</strong>.
                  </p>
                  <button className="btn btn-primary gs-send" onClick={sendFile} disabled={!bundle}>
                    Send file
                  </button>
                  {sent && <p className="gs-hint">Sent. When they open it, your changes are merged into their copy.</p>}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
