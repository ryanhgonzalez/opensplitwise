import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { loadPhoto } from '../lib/receiptPhotos';
import './ReceiptViewer.css';

interface ReceiptViewerProps {
  /** A kept photo, loaded from this device… */
  expenseId?: string;
  /** …or one not saved yet. */
  src?: string;
  title: string;
  onClose: () => void;
}

/** A receipt photo, full screen. Tap to zoom in and scroll around; tap again to fit. */
export default function ReceiptViewer({ expenseId, src, title, onClose }: ReceiptViewerProps) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = src ?? loaded;
  const [missing, setMissing] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!expenseId) return;
    let objectUrl: string | null = null;
    let live = true;
    loadPhoto(expenseId)
      .then((blob) => {
        if (!live) return;
        if (!blob) return setMissing(true);
        objectUrl = URL.createObjectURL(blob);
        setLoaded(objectUrl);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [expenseId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Into <body>: inside a sheet, its transform would trap a fixed overlay in the sheet.
  return createPortal(
    <motion.div
      className="rv"
      role="dialog"
      aria-label={`Receipt for ${title}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="rv-bar">
        <span className="rv-title">{title}</span>
        <button className="rv-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={`rv-stage ${zoomed ? 'zoomed' : ''}`} onClick={() => url && setZoomed((z) => !z)}>
        {url && <img className="rv-img" src={url} alt={`Receipt for ${title}`} />}
        {missing && (
          <p className="rv-missing">
            This receipt photo isn't on this device. It may have been taken on another phone, or the browser's storage was cleared.
          </p>
        )}
      </div>
      {url && <p className="rv-hint">{zoomed ? 'Tap to fit' : 'Tap to zoom'}</p>}
    </motion.div>,
    document.body,
  );
}
