import { useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store';
import type { ImportRow } from '../lib/contacts';
import '../styles/sheet.css';
import './ContactImportSheet.css';

interface ContactImportSheetProps {
  rows: ImportRow[];
  onClose: () => void;
  onDone: (result: { added: number; updated: number }) => void;
}

const TICK = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M20 6L9 17L4 12" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Tick who to add from a contacts file or the picker; people already here are shown, not added. */
export default function ContactImportSheet({ rows, onClose, onDone }: ContactImportSheetProps) {
  const users = useStore((s) => s.users);
  const importContacts = useStore((s) => s.importContacts);
  const usable = rows.map((r, i) => ({ ...r, i })).filter((r) => r.action !== 'skip');
  const [picked, setPicked] = useState<Set<number>>(() => new Set(usable.map((r) => r.i)));

  const toggle = (i: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const allPicked = usable.length > 0 && usable.every((r) => picked.has(r.i));

  const chosen = rows.filter((_, i) => picked.has(i));
  const adding = chosen.filter((r) => r.action === 'new').length;
  const numbering = chosen.filter((r) => r.action === 'phone').length;
  const label = [
    adding && `Add ${adding} ${adding === 1 ? 'person' : 'people'}`,
    numbering && `${adding ? 'update' : 'Update'} ${numbering}`,
  ]
    .filter(Boolean)
    .join(', ');

  const save = () => {
    onDone(importContacts(chosen.map(({ name, phone, email, userId, action }) => ({ name, phone, email, userId: action === 'phone' ? userId : undefined }))));
  };

  const nameOf = (id?: string) => users.find((u) => u.id === id)?.name ?? '';

  return (
    <motion.div className="sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="sheet-panel"
        role="dialog"
        aria-label="Add from contacts"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">Add from contacts</span>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="sheet-body">
          {rows.length === 0 ? (
            <p className="cis-empty">No contacts with a name were found.</p>
          ) : (
            <>
              <div className="cis-top">
                <span className="text-sm text-secondary">
                  {rows.length} {rows.length === 1 ? 'contact' : 'contacts'}
                  {usable.length < rows.length && ` · ${rows.length - usable.length} already here`}
                </span>
                {usable.length > 1 && (
                  <button
                    className="cis-all"
                    onClick={() => setPicked(allPicked ? new Set() : new Set(usable.map((r) => r.i)))}
                  >
                    {allPicked ? 'Select none' : 'Select all'}
                  </button>
                )}
              </div>
              <ul className="cis-list">
                {rows.map((r, i) => {
                  const skip = r.action === 'skip';
                  const on = picked.has(i);
                  const detail = [r.phone, r.email].filter(Boolean).join(' · ');
                  return (
                    <li key={`${r.name}-${i}`}>
                      <button
                        className={`cis-row ${skip ? 'skip' : ''}`}
                        onClick={() => !skip && toggle(i)}
                        disabled={skip}
                        role="checkbox"
                        aria-checked={on}
                      >
                        <span className={`cgs-checkbox ${on ? 'checked' : ''}`}>{on && TICK}</span>
                        <span className="cis-text">
                          <span className="cis-name">{r.name}</span>
                          {detail && <span className="cis-detail">{detail}</span>}
                        </span>
                        <span className="cis-tag">
                          {r.action === 'new' ? 'New' : r.action === 'phone' ? `Adds number to ${nameOf(r.userId).split(' ')[0]}` : 'Already here'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="sheet-footer">
          <button className="sheet-cta" onClick={save} disabled={chosen.length === 0}>
            {chosen.length === 0 ? 'Nothing to add' : label}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
