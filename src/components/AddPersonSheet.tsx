import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store';
import { contactPicker, parseVcf, pickContacts, type Contact } from '../lib/contacts';
import '../styles/sheet.css';
import './AddPersonSheet.css';

interface AddPersonSheetProps {
  onClose: () => void;
  /** Added one by hand: their name, for the note on the page. */
  onAdded: (name: string) => void;
  /** Chose contacts (picker or file): the page shows them to tick. */
  onContacts: (contacts: Contact[]) => void;
}

/** Add someone: type their details, or bring them in from contacts. */
export default function AddPersonSheet({ onClose, onAdded, onContacts }: AddPersonSheetProps) {
  const users = useStore((s) => s.users);
  const importContacts = useStore((s) => s.importContacts);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const sameName = trimmed && users.some((u) => u.name.trim().toLowerCase() === trimmed.toLowerCase());

  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!trimmed) return;
    importContacts([{ name: trimmed, phone: phone.trim() || undefined, email: email.trim() || undefined }]);
    onAdded(trimmed);
  };

  const fromPicker = async () => {
    try {
      const picked = await pickContacts();
      if (picked.length) onContacts(picked);
    } catch {
      // Cancelled or refused.
    }
  };

  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    const contacts = parseVcf(await file.text());
    if (contacts.length === 0) setFileError('No contacts with a name in that file. Contacts files end in .vcf.');
    else onContacts(contacts);
  };

  return (
    <motion.div className="sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="sheet-panel"
        role="dialog"
        aria-label="Add a person"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">Add a person</span>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form className="sheet-body" id="aps-form" onSubmit={save}>
          <div className="field-group">
            <label className="field-label" htmlFor="aps-name">Name</label>
            <input
              id="aps-name"
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Their name"
              autoComplete="off"
            />
            {sameName && <p className="aps-note">Someone called {trimmed} is already here.</p>}
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="aps-phone">Phone</label>
            <input
              id="aps-phone"
              className="field-input"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Optional, for texting reminders"
              autoComplete="off"
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="aps-email">Email</label>
            <input
              id="aps-email"
              className="field-input"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Optional"
              autoComplete="off"
              autoCapitalize="none"
            />
          </div>
          <p className="aps-note">Phone numbers and emails stay on this device.</p>

          <div className="aps-or" aria-hidden>
            <span>or</span>
          </div>

          <div className="aps-import">
            {contactPicker() && (
              <button type="button" className="btn btn-secondary aps-import-btn" onClick={fromPicker}>
                Choose from contacts
              </button>
            )}
            <button type="button" className="btn btn-secondary aps-import-btn" onClick={() => fileRef.current?.click()}>
              Import a contacts file (.vcf)
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              hidden
              onChange={(e) => {
                setFileError(null);
                void fromFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {fileError && <p className="aps-note aps-error">{fileError}</p>}
            {!contactPicker() && (
              <p className="aps-note">
                On iPhone: in Contacts, open someone and tap Share Contact, or long-press a list and choose Export,
                then save the file and pick it here.
              </p>
            )}
          </div>
        </form>

        <div className="sheet-footer">
          <button className="sheet-cta" type="submit" form="aps-form" disabled={!trimmed}>
            Add {trimmed ? trimmed.split(/\s+/)[0] : 'person'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
