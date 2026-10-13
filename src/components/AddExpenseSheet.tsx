import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser } from '../store';
import { buildSplit, round, splitByItems } from '../lib/calculations';
import { CATEGORY_LABELS } from '../types';
import type { CategoryId, Expense, SplitType, ExpenseSplit } from '../types';
import { BUILT_IN_CATEGORIES, MAX_CATEGORY_NAME, isCustomCategory } from '../lib/categories';
import { convertSplit, currencySymbol, groupCurrency, recordCurrency } from '../lib/currency';
import CurrencySelect from './CurrencySelect';
import ReceiptViewer from './ReceiptViewer';
import { compressReceiptPhoto, formatBytes, loadPhoto, savePhoto } from '../lib/receiptPhotos';
import type { TotalCandidate } from '../lib/receiptScanner';
import { formatCurrency } from '../utils/format';
import Avatar from './Avatar';
import '../styles/sheet.css';
import './AddExpenseSheet.css';

// Local UI split mode — adds "items" on top of the persisted SplitType values.
// Itemized entry produces an `exact` split on save, so it's never persisted as a type.
type SplitMode = 'equal' | 'exact' | 'percentage' | 'items';

const SPLIT_TYPES: { value: SplitMode; label: string }[] = [
  { value: 'equal',      label: 'Equal' },
  { value: 'exact',      label: 'Exact' },
  { value: 'percentage', label: 'Percent' },
  { value: 'items',      label: 'Items' },
];

interface Participant {
  userId: string;
  checked: boolean;
  value: string; // dollar amount or percentage, depending on splitType
}

interface ItemRow {
  id: string;
  description: string;
  price: string;
  assigned: string[]; // userIds sharing this item
}

interface AddExpenseSheetProps {
  open: boolean;
  onClose: () => void;
  defaultGroupId?: string;
  editExpense?: Expense;
}

// ─── Date-input helpers (local, timezone-safe) ────────────────────────────────
function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function fromDateInputValue(str: string): Date {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1); // local midnight
}

let itemSeq = 0;
const newItemId = () => `item-${Date.now()}-${itemSeq++}`;

export default function AddExpenseSheet({ open, onClose, defaultGroupId, editExpense }: AddExpenseSheetProps) {
  const isEditing = !!editExpense;
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore(s => s.users);
  const groups = useStore(s => s.groups);
  const addExpense = useStore(s => s.addExpense);
  const updateExpense = useStore(s => s.updateExpense);
  const addGroupCategory = useStore(s => s.addGroupCategory);

  const initSplitType = (e?: Expense): SplitMode =>
    e?.items?.length ? 'items'
    : e?.split.type === 'percentage' ? 'exact' : (e?.split.type === 'shares' ? 'exact' : (e?.split.type ?? 'equal'));

  // Paid in another currency than the group's: the form shows and edits what was
  // actually paid; balances get the converted figures on save.
  const editForeign =
    editExpense?.original && editExpense.original.currency !== recordCurrency(editExpense)
      ? editExpense.original
      : undefined;

  const [description, setDescription] = useState(editExpense?.description ?? '');
  const [amountStr, setAmountStr] = useState(editExpense ? String(editForeign?.amount ?? editExpense.amount) : '');
  /** The currency the amount is entered in; null = the group's. */
  const [entryCurrency, setEntryCurrency] = useState<string | null>(editForeign?.currency ?? null);
  /** Group currency per 1 unit of the entry currency, as typed. */
  const [rateStr, setRateStr] = useState(editForeign ? String(editForeign.rate) : '');
  const [category, setCategory] = useState<CategoryId>(editExpense?.category ?? 'food');
  // Inline "+ New" category entry; null while closed.
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [newCategoryHint, setNewCategoryHint] = useState<string | null>(null);
  const [dateStr, setDateStr] = useState(editExpense ? toDateInputValue(editExpense.date) : '');
  const [groupId, setGroupId] = useState(editExpense?.groupId ?? defaultGroupId ?? '');
  const [paidBy, setPaidBy] = useState(editExpense?.paidBy ?? currentUser.id);
  const [splitType, setSplitType] = useState<SplitMode>(initSplitType(editExpense));
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [lineItems, setLineItems] = useState<ItemRow[]>([]);

  // Receipt scanning (client-side OCR — fills a draft the user reviews before saving)
  const cameraInputRef = useRef<HTMLInputElement>(null); // capture=camera (touch devices)
  const fileInputRef = useRef<HTMLInputElement>(null);   // library / file picker (all devices)
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  // Receipt photo kept with the expense. `newPhoto` is one picked or scanned
  // in this sheet; otherwise an edited expense keeps its existing photo
  // unless removed.
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [newPhoto, setNewPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [existingPhotoUrl, setExistingPhotoUrl] = useState<string | null>(null);
  const [removeExisting, setRemoveExisting] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const hasExisting = !!editExpense?.receipt && !removeExisting;

  useEffect(() => {
    if (!open || !editExpense?.receipt) return;
    let url: string | null = null;
    let live = true;
    loadPhoto(editExpense.id)
      .then((blob) => {
        if (live && blob) setExistingPhotoUrl((url = URL.createObjectURL(blob)));
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, editExpense]);

  const keepPhoto = async (file: Blob) => {
    setPhotoError(null);
    try {
      const blob = await compressReceiptPhoto(file);
      setNewPhoto((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
    } catch {
      setPhotoError('That photo couldn’t be read. Try another one.');
    }
  };

  const dropPhoto = () => {
    if (newPhoto) {
      URL.revokeObjectURL(newPhoto.url);
      setNewPhoto(null);
    } else {
      setRemoveExisting(true);
    }
  };

  // Amounts the scan found that could be the total: tap one to use it.
  const [totalCandidates, setTotalCandidates] = useState<TotalCandidate[]>([]);

  const selectedGroup = useMemo(() => groups.find(g => g.id === groupId), [groups, groupId]);
  const groupMemberIds = useMemo(() => selectedGroup?.members.map(m => m.userId) ?? [], [selectedGroup]);
  const getUserById = (id: string) => users.find(u => u.id === id);

  // A custom category belongs to one group; moving the expense elsewhere drops it to Other.
  useEffect(() => {
    setCategory(c =>
      isCustomCategory(c) && !selectedGroup?.categories?.some(x => x.id === c) ? 'other' : c,
    );
    setNewCategoryHint(null);
  }, [selectedGroup]);

  const openNewCategory = () => {
    if (!selectedGroup) {
      setNewCategoryHint('Choose a group below first. Custom categories are saved to the group.');
      return;
    }
    setNewCategoryHint(null);
    setNewCategory('');
  };

  const saveNewCategory = () => {
    if (!selectedGroup || newCategory === null) return;
    const id = addGroupCategory(selectedGroup.id, newCategory);
    if (id) setCategory(id);
    setNewCategory(null);
  };

  // Rebuild participants when selected group changes (or when editing a different expense).
  useEffect(() => {
    if (!selectedGroup) { setParticipants([]); return; }

    if (editExpense && editExpense.groupId === selectedGroup.id) {
      const eSplitType = initSplitType(editExpense);
      setSplitType(eSplitType);
      // Split by item: bring the receipt's lines back, to adjust.
      if (editExpense.items?.length) {
        const memberIds = selectedGroup.members.map(m => m.userId);
        setLineItems(editExpense.items.map(it => ({
          id: newItemId(),
          description: it.description,
          price: it.amount.toFixed(2),
          assigned: it.assigned.filter(id => memberIds.includes(id)),
        })));
      }
      // Shares are stored converted; show them in the currency the amount is edited in.
      const entries = editForeign
        ? convertSplit(editExpense.split.entries, 1 / editForeign.rate, editForeign.amount)
        : editExpense.split.entries;
      setParticipants(
        selectedGroup.members.map(m => {
          const entry = entries.find(e => e.userId === m.userId);
          return {
            userId: m.userId,
            checked: !!entry,
            value: entry && eSplitType !== 'equal' ? String(entry.amount) : '',
          };
        })
      );
    } else {
      setParticipants(
        selectedGroup.members.map(m => ({ userId: m.userId, checked: true, value: '' }))
      );
      // Any items already added (e.g. from a scan before a group was picked) default to
      // being shared by everyone in the newly-selected group.
      setLineItems(prev => prev.map(it => ({ ...it, assigned: selectedGroup.members.map(m => m.userId) })));
      if (!selectedGroup.members.some(m => m.userId === paidBy)) {
        setPaidBy(currentUser.id);
      }
    }
  }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsedAmount = parseFloat(amountStr) || 0;
  const groupCur = groupCurrency(selectedGroup);
  const cur = entryCurrency ?? groupCur;
  const isForeign = cur !== groupCur;
  const rate = isForeign ? parseFloat(rateStr) || 0 : 1;
  const sym = currencySymbol(cur);
  const checkedParticipants = participants.filter(p => p.checked);
  const checkedCount = checkedParticipants.length;

  // Computed split preview for equal mode
  const equalShare = checkedCount > 0 ? round(parsedAmount / checkedCount) : 0;

  // Running total for exact / percentage modes
  const enteredTotal = useMemo(() => {
    if (splitType === 'exact' || splitType === 'percentage') {
      return checkedParticipants.reduce((s, p) => s + (parseFloat(p.value) || 0), 0);
    }
    return parsedAmount;
  }, [participants, splitType, parsedAmount]);

  const remainder = splitType === 'exact'
    ? round(parsedAmount - enteredTotal)
    : splitType === 'percentage'
    ? round(100 - enteredTotal)
    : 0;

  // ── Itemized computation ────────────────────────────────────────────────────
  const itemsSum = useMemo(
    () => round(lineItems.reduce((s, it) => s + (parseFloat(it.price) || 0), 0)),
    [lineItems],
  );
  // In items mode the hero amount is the grand total (incl. tax/tip). Left blank, it
  // falls back to the items sum (no tax/tip).
  const effectiveTotal = splitType === 'items' ? (parsedAmount > 0 ? parsedAmount : itemsSum) : parsedAmount;

  // Per-person entries: each item split equally among its assignees, then the
  // remaining tax/tip distributed proportionally (see splitByItems).
  const itemEntries = useMemo(
    () => splitByItems(
      effectiveTotal,
      itemsSum,
      lineItems.map(it => ({ price: parseFloat(it.price) || 0, assigned: it.assigned })),
      groupMemberIds,
    ),
    [lineItems, groupMemberIds, effectiveTotal, itemsSum],
  );

  const itemAmountFor = (id: string) => itemEntries.find(e => e.userId === id)?.amount ?? 0;

  // ── Validation ──────────────────────────────────────────────────────────────
  const splitValid = useMemo(() => {
    if (checkedCount === 0) return false;
    if (splitType === 'equal') return parsedAmount > 0;
    if (splitType === 'exact') return Math.abs(remainder) < 0.01 && parsedAmount > 0;
    if (splitType === 'percentage') return Math.abs(remainder) < 0.01;
    return false;
  }, [splitType, remainder, parsedAmount, checkedCount]);

  const pricedItems = lineItems.filter(it => (parseFloat(it.price) || 0) > 0);
  const allPricedAssigned = pricedItems.every(it => it.assigned.some(id => groupMemberIds.includes(id)));
  const itemsValid =
    groupMemberIds.length > 0 &&
    pricedItems.length > 0 &&
    allPricedAssigned &&
    itemsSum > 0 &&
    // A total below the items is a discount, taken off everyone in proportion (splitByItems).
    effectiveTotal > 0;

  const rateValid = !isForeign || rate > 0;

  const canSubmit =
    rateValid &&
    description.trim().length > 0 &&
    !!groupId &&
    (splitType === 'items' ? itemsValid : parsedAmount > 0 && splitValid);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const toggleParticipant = (userId: string) => {
    setParticipants(prev => prev.map(p => p.userId === userId ? { ...p, checked: !p.checked } : p));
  };

  const setParticipantValue = (userId: string, value: string) => {
    setParticipants(prev => prev.map(p => p.userId === userId ? { ...p, value } : p));
  };

  const handleSplitTypeChange = (mode: SplitMode) => {
    setSplitType(mode);
    setParticipants(prev => prev.map(p => ({ ...p, value: '' })));
    if (mode === 'items' && lineItems.length === 0) {
      setLineItems([{ id: newItemId(), description: '', price: '', assigned: [...groupMemberIds] }]);
    }
  };

  const addItem = () =>
    setLineItems(prev => [...prev, { id: newItemId(), description: '', price: '', assigned: [...groupMemberIds] }]);
  const removeItem = (id: string) => setLineItems(prev => prev.filter(it => it.id !== id));
  const updateItem = (id: string, field: 'description' | 'price', value: string) =>
    setLineItems(prev => prev.map(it => (it.id === id ? { ...it, [field]: value } : it)));
  const toggleItemAssign = (id: string, userId: string) =>
    setLineItems(prev => prev.map(it => it.id === id
      ? { ...it, assigned: it.assigned.includes(userId) ? it.assigned.filter(u => u !== userId) : [...it.assigned, userId] }
      : it));

  const handleReceiptSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;

    // The photo is kept with the expense whatever the scan makes of it.
    void keepPhoto(file);
    setScanning(true);
    setScanError(null);
    setScanStatus('Reading receipt…');
    setScanned(false);
    setTotalCandidates([]);
    try {
      const { scanReceipt } = await import('../lib/receiptScanner');
      const result = await scanReceipt(file, p => {
        if (p.phase === 'download') {
          // First scan only: the reader is stored for offline use afterwards.
          setScanStatus(`Downloading receipt reader… ${Math.round(p.loaded / 1e6)} / ${Math.round(p.total / 1e6)} MB`);
        } else if (p.phase === 'prepare') {
          setScanStatus('Preparing receipt reader…');
        } else {
          setScanStatus(`Reading receipt… ${Math.round(p.fraction * 100)}%`);
        }
      });

      let filledAny = false;
      if (result.amount && result.amount > 0) { setAmountStr(result.amount.toFixed(2)); filledAny = true; }
      // A receipt that says it's in another currency than the group's: enter it in that one.
      if (result.currency) setEntryCurrency(result.currency === groupCur ? null : result.currency);
      setTotalCandidates(result.totalCandidates ?? []);
      if (result.description) { setDescription(result.description); filledAny = true; }
      if (result.category) { setCategory(result.category); filledAny = true; }
      if (result.date) { setDateStr(toDateInputValue(result.date)); filledAny = true; }
      if (result.lineItems && result.lineItems.length > 0) {
        const assigned = groupMemberIds;
        setLineItems(result.lineItems.map(li => ({
          id: newItemId(),
          description: li.description,
          price: li.amount.toFixed(2),
          assigned: [...assigned],
        })));
        setSplitType('items');
        filledAny = true;
      }

      if (!filledAny) {
        setScanError("Couldn't read that receipt. Try a clearer, well-lit photo — or enter the details manually.");
      } else {
        setScanned(true);
        if (!result.amount) setScanError("Couldn't find the total — please enter the amount manually.");
        else if (result.fallbackReason) {
          // Usually: offline before the reader's first download.
          setScanError(`Used the basic reader, since the receipt reader couldn't load (${result.fallbackReason}). Check the details carefully.`);
        }
      }
    } catch {
      setScanError('Something went wrong scanning the receipt. Please enter the details manually.');
    } finally {
      setScanning(false);
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;

    const receipt = newPhoto ? { bytes: newPhoto.blob.size } : hasExisting ? editExpense!.receipt : undefined;

    const expenseDate = dateStr ? fromDateInputValue(dateStr) : new Date();

    let amount: number;
    let split: ExpenseSplit;
    // Kept so the receipt can be reopened and adjusted; dropped for any other split.
    const items: Expense['items'] = splitType === 'items'
      ? lineItems
          .filter(it => (parseFloat(it.price) || 0) > 0)
          .map(it => ({ description: it.description.trim() || 'Item', amount: round(parseFloat(it.price)), assigned: it.assigned }))
      : undefined;
    if (splitType === 'items') {
      amount = effectiveTotal;
      split = { type: 'exact', entries: itemEntries };
    } else {
      amount = parsedAmount;
      const activeParticipants = participants
        .filter(p => p.checked)
        .map(p => ({
          userId: p.userId,
          value: splitType !== 'equal' ? (parseFloat(p.value) || 0) : undefined,
        }));
      split = buildSplit(parsedAmount, splitType as SplitType, activeParticipants);
    }

    // Balances are kept in the group's currency: convert what was entered, and
    // remember what was actually paid.
    let original: Expense['original'];
    if (isForeign) {
      const converted = round(amount * rate);
      original = { amount, currency: cur, rate };
      split = { ...split, entries: convertSplit(split.entries, rate, converted) };
      amount = converted;
    }

    if (isEditing && editExpense) {
      updateExpense(editExpense.id, {
        description: description.trim(),
        amount,
        paidBy,
        groupId: groupId || undefined,
        split,
        category,
        date: expenseDate,
        currency: groupCur,
        original,
        receipt,
        items,
      });
      if (newPhoto) void savePhoto(editExpense.id, newPhoto.blob);
    } else {
      const added = addExpense({
        description: description.trim(),
        amount,
        currency: groupCur,
        original,
        paidBy,
        groupId: groupId || undefined,
        date: expenseDate,
        split,
        category,
        receipt,
        items,
      });
      // Saved under the new expense's id, which exists only now.
      if (newPhoto) void savePhoto(added.id, newPhoto.blob);
    }

    handleClose();
  };

  const handleClose = () => {
    if (newPhoto) URL.revokeObjectURL(newPhoto.url);
    setNewPhoto(null);
    setRemoveExisting(false);
    setViewingPhoto(false);
    setPhotoError(null);
    setDescription(editExpense?.description ?? '');
    setAmountStr(editExpense ? String(editForeign?.amount ?? editExpense.amount) : '');
    setEntryCurrency(editForeign?.currency ?? null);
    setRateStr(editForeign ? String(editForeign.rate) : '');
    setCategory(editExpense?.category ?? 'food');
    setNewCategory(null);
    setNewCategoryHint(null);
    setDateStr(editExpense ? toDateInputValue(editExpense.date) : '');
    setGroupId(editExpense?.groupId ?? defaultGroupId ?? '');
    setPaidBy(editExpense?.paidBy ?? currentUser.id);
    setSplitType(initSplitType(editExpense));
    setParticipants([]);
    setLineItems([]);
    setScanning(false);
    setScanStatus('');
    setScanError(null);
    setTotalCandidates([]);
    setScanned(false);
    onClose();
  };

  const ctaTotal = splitType === 'items' ? effectiveTotal : parsedAmount;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
        >
          <motion.div
            className="sheet-panel"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">{isEditing ? 'Edit Expense' : 'Add Expense'}</span>
              <button className="sheet-close" onClick={handleClose} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="sheet-body">
              {/* Receipt scan (client-side OCR) — pre-fills an editable draft */}
              {!isEditing && (
                <div className="aes-scan">
                  <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={handleReceiptSelected}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={handleReceiptSelected}
                  />

                  {scanning ? (
                    <button type="button" className="aes-scan-btn" disabled>
                      <span className="aes-scan-spinner" aria-hidden />
                      {scanStatus}
                    </button>
                  ) : (
                    <div className="aes-scan-actions">
                      {/* Camera capture — only useful on touch devices (hidden on desktop via CSS) */}
                      <button
                        type="button"
                        className="aes-scan-btn aes-scan-camera"
                        onClick={() => cameraInputRef.current?.click()}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="2" />
                        </svg>
                        Take photo
                      </button>
                      {/* Library / file picker — on iOS/Android this sheet also offers the camera */}
                      <button
                        type="button"
                        className="aes-scan-btn"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M12 16V4M8 8l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Upload photo
                      </button>
                    </div>
                  )}
                  {scanError && <div className="aes-scan-msg error">{scanError}</div>}
                  {scanned && !scanError && (
                    <div className="aes-scan-msg ok">Filled from receipt — double-check the details below.</div>
                  )}
                </div>
              )}

              {/* Receipt photo, kept with the expense on this device */}
              <div className="aes-photo">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void keepPhoto(f);
                  }}
                />
                {newPhoto || (hasExisting && existingPhotoUrl) ? (
                  <div className="aes-photo-row">
                    <button
                      type="button"
                      className="aes-photo-thumb"
                      onClick={() => setViewingPhoto(true)}
                      aria-label="View receipt photo"
                    >
                      <img src={newPhoto?.url ?? existingPhotoUrl!} alt="" />
                    </button>
                    <span className="aes-photo-text">
                      <span className="aes-photo-title">Receipt photo</span>
                      <span className="aes-photo-sub">
                        {formatBytes(newPhoto?.blob.size ?? editExpense?.receipt?.bytes ?? 0)} · kept on this device
                      </span>
                    </span>
                    <button type="button" className="aes-photo-action" onClick={() => photoInputRef.current?.click()}>
                      Replace
                    </button>
                    <button type="button" className="aes-photo-action" onClick={dropPhoto}>
                      Remove
                    </button>
                  </div>
                ) : (
                  <button type="button" className="aes-photo-add" onClick={() => photoInputRef.current?.click()}>
                    + Attach receipt photo
                  </button>
                )}
                {photoError && <div className="aes-scan-msg error">{photoError}</div>}
              </div>

              {/* Amount — hero input */}
              <div className="aes-amount-hero">
                <span className="aes-currency-symbol">{sym}</span>
                <input
                  className="aes-amount-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  value={amountStr}
                  onChange={e => setAmountStr(e.target.value)}
                />
                {/* Shows the code; the invisible select on top opens the full list */}
                <span className={`aes-currency-pick ${isForeign ? 'foreign' : ''}`}>
                  {cur}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <CurrencySelect
                    className="aes-currency-pick-select"
                    aria-label="Currency of this expense"
                    value={cur}
                    onChange={c => setEntryCurrency(c === groupCur ? null : c)}
                  />
                </span>
              </div>

              {/* Paid in another currency than the group's: the rate converts it */}
              {isForeign && (
                <div className="aes-rate">
                  <label className="aes-rate-row">
                    <span>1 {cur} =</span>
                    <input
                      className="field-input aes-rate-input"
                      type="number"
                      inputMode="decimal"
                      placeholder="rate"
                      min="0"
                      step="any"
                      value={rateStr}
                      onChange={e => setRateStr(e.target.value)}
                      aria-label={`${groupCur} per 1 ${cur}`}
                    />
                    <span>{groupCur}</span>
                  </label>
                  <span className="aes-rate-hint">
                    {rate > 0 && ctaTotal > 0
                      ? `= ${formatCurrency(round(ctaTotal * rate), groupCur)}${selectedGroup ? ` in ${selectedGroup.name}` : ''}. Your card statement shows the rate you actually paid.`
                      : `${selectedGroup?.name ?? 'This group'} is in ${groupCur}. Enter the rate to convert; your card statement shows the one you actually paid.`}
                  </span>
                </div>
              )}

              {/* After a scan: the other amounts that could be the total, one tap to switch */}
              {totalCandidates.length > 1 && (
                <div className="aes-total-pick" role="group" aria-label="Amounts on the receipt">
                  <div className="aes-total-pick-label">Not the total? Pick it from the receipt</div>
                  <div className="aes-total-pick-row">
                    {totalCandidates.map(c => {
                      const active = Math.abs((parseFloat(amountStr) || 0) - c.amount) < 0.005;
                      return (
                        <button
                          key={c.amount}
                          type="button"
                          className={`aes-total-chip ${active ? 'active' : ''}`}
                          aria-pressed={active}
                          onClick={() => setAmountStr(c.amount.toFixed(2))}
                        >
                          <span className="num">{formatCurrency(c.amount, cur)}</span>
                          <span className="aes-total-chip-label">{c.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Description */}
              <div className="field-group">
                <div className="field-label">What was it for?</div>
                <input
                  className="field-input"
                  placeholder="Dinner, gas, groceries…"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>

              {/* Category */}
              <div className="field-group">
                <div className="field-label">Category</div>
                <div className="aes-category-row">
                  {BUILT_IN_CATEGORIES.map(c => (
                    <button
                      key={c}
                      className={`aes-category-btn ${category === c ? 'active' : ''}`}
                      aria-pressed={category === c}
                      onClick={() => setCategory(c)}
                    >
                      {CATEGORY_LABELS[c]}
                    </button>
                  ))}
                  {selectedGroup?.categories?.map(c => (
                    <button
                      key={c.id}
                      className={`aes-category-btn ${category === c.id ? 'active' : ''}`}
                      aria-pressed={category === c.id}
                      onClick={() => setCategory(c.id)}
                    >
                      {c.name}
                    </button>
                  ))}
                  {newCategory === null ? (
                    <button type="button" className="aes-category-btn aes-category-new" onClick={openNewCategory}>
                      + New
                    </button>
                  ) : (
                    <form
                      className="aes-category-form"
                      onSubmit={e => { e.preventDefault(); saveNewCategory(); }}
                    >
                      <input
                        className="aes-category-input"
                        autoFocus
                        maxLength={MAX_CATEGORY_NAME}
                        placeholder="Category name"
                        aria-label="New category name"
                        value={newCategory}
                        onChange={e => setNewCategory(e.target.value)}
                        onKeyDown={e => e.key === 'Escape' && setNewCategory(null)}
                      />
                      <button type="submit" className="aes-category-btn active" disabled={!newCategory.trim()}>
                        Add
                      </button>
                      <button type="button" className="aes-category-btn" onClick={() => setNewCategory(null)}>
                        Cancel
                      </button>
                    </form>
                  )}
                </div>
                {newCategoryHint && <p className="aes-category-hint">{newCategoryHint}</p>}
              </div>

              {/* Date */}
              <div className="field-group">
                <div className="field-label">Date</div>
                <input
                  className="field-input aes-date-input"
                  type="date"
                  value={dateStr}
                  onChange={e => setDateStr(e.target.value)}
                />
                <div className="aes-field-hint text-tertiary text-xs">Leave empty to use today's date.</div>
              </div>

              {/* Group (only shown when no default) */}
              {!defaultGroupId && (
                <div className="field-group">
                  <div className="field-label">Group</div>
                  <div className="aes-group-picker">
                    {groups.length === 0 ? (
                      <p className="text-secondary text-sm">No groups yet — create one first</p>
                    ) : (
                      groups.map(g => (
                        <button
                          key={g.id}
                          className={`aes-group-option ${groupId === g.id ? 'active' : ''}`}
                          style={groupId === g.id ? { borderColor: `${g.color}55`, background: `${g.color}18` } : {}}
                          onClick={() => setGroupId(g.id)}
                        >
                          <span style={{ fontSize: 18 }}>{g.emoji}</span>
                          <span className="aes-group-name">{g.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Paid by */}
              {selectedGroup && (
                <div className="field-group">
                  <div className="field-label">Paid by</div>
                  <div className="aes-paid-by-row">
                    {selectedGroup.members.map(m => {
                      const u = getUserById(m.userId);
                      if (!u) return null;
                      return (
                        <button
                          key={m.userId}
                          className={`aes-payer-btn ${paidBy === m.userId ? 'active' : ''}`}
                          onClick={() => setPaidBy(m.userId)}
                        >
                          <Avatar user={u} size="sm" showRing={paidBy === m.userId} />
                          <span className="aes-payer-name">
                            {m.userId === currentUser.id ? 'You' : u.name.split(' ')[0]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Split section */}
              {selectedGroup && (
                <div className="field-group">
                  <div className="aes-split-header">
                    <div className="field-label" style={{ margin: 0 }}>Split</div>
                    <div className="aes-split-tabs">
                      {SPLIT_TYPES.map(st => (
                        <button
                          key={st.value}
                          className={`aes-split-tab ${splitType === st.value ? 'active' : ''}`}
                          onClick={() => handleSplitTypeChange(st.value)}
                        >
                          {st.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {splitType !== 'items' ? (
                    <>
                      <div className="aes-participants">
                        {participants.map(p => {
                          const u = getUserById(p.userId);
                          if (!u) return null;
                          const isMe = p.userId === currentUser.id;
                          const sharePreview = splitType === 'equal' && parsedAmount > 0 && p.checked
                            ? `${formatCurrency(equalShare, cur)} each`
                            : null;

                          return (
                            <div
                              key={p.userId}
                              className={`aes-participant ${p.checked ? 'checked' : 'unchecked'}`}
                            >
                              <button className="aes-participant-check" onClick={() => toggleParticipant(p.userId)}>
                                <div className={`cgs-checkbox ${p.checked ? 'checked' : ''}`} style={{ width: 20, height: 20 }}>
                                  {p.checked && (
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                      <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  )}
                                </div>
                              </button>
                              <Avatar user={u} size="sm" />
                              <span className="aes-participant-name">
                                {isMe ? 'You' : u.name.split(' ')[0]}
                              </span>

                              {splitType === 'equal' && (
                                <span className="aes-equal-share text-secondary text-sm">
                                  {sharePreview ?? '—'}
                                </span>
                              )}

                              {(splitType === 'exact' || splitType === 'percentage') && p.checked && (
                                <div className="aes-value-input-wrap">
                                  <span className="aes-value-prefix">
                                    {splitType === 'exact' ? sym : ''}
                                  </span>
                                  <input
                                    className="aes-value-input"
                                    type="number"
                                    inputMode="decimal"
                                    placeholder="0"
                                    min="0"
                                    value={p.value}
                                    onChange={e => setParticipantValue(p.userId, e.target.value)}
                                  />
                                  {splitType === 'percentage' && (
                                    <span className="aes-value-suffix">%</span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Remainder indicator */}
                      {splitType !== 'equal' && parsedAmount > 0 && (
                        <div className={`aes-remainder ${Math.abs(remainder) < 0.01 ? 'ok' : 'warn'}`}>
                          {Math.abs(remainder) < 0.01 ? (
                            <>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                                <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              Splits add up ✓
                            </>
                          ) : (
                            <>
                              {splitType === 'exact'
                                ? `${formatCurrency(remainder, cur)} ${remainder > 0 ? 'remaining' : 'over'}`
                                : `${remainder > 0 ? remainder.toFixed(1) + '% remaining' : Math.abs(remainder).toFixed(1) + '% over'}`
                              }
                            </>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    /* ── Itemized split ── */
                    <div className="aes-items">
                      <div className="aes-field-hint text-tertiary text-xs" style={{ marginBottom: 10 }}>
                        Add each item and tap who shared it. Set the amount above to include tax &amp; tip
                        (or leave it blank to use the item total).
                      </div>

                      {lineItems.map(it => {
                        const price = parseFloat(it.price) || 0;
                        const who = it.assigned.filter(id => groupMemberIds.includes(id));
                        const perEach = who.length > 0 && price > 0 ? price / who.length : 0;
                        return (
                          <div key={it.id} className="aes-item">
                            <div className="aes-item-top">
                              <input
                                className="field-input aes-item-name"
                                placeholder="Item name"
                                value={it.description}
                                onChange={e => updateItem(it.id, 'description', e.target.value)}
                              />
                              <div className="aes-item-price-wrap">
                                <span className="aes-value-prefix">{sym}</span>
                                <input
                                  className="aes-item-price"
                                  type="number"
                                  inputMode="decimal"
                                  placeholder="0.00"
                                  min="0"
                                  value={it.price}
                                  onChange={e => updateItem(it.id, 'price', e.target.value)}
                                />
                              </div>
                              <button className="aes-item-remove" onClick={() => removeItem(it.id)} aria-label="Remove item">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                                </svg>
                              </button>
                            </div>

                            <div className="aes-item-assign">
                              {selectedGroup.members.map(m => {
                                const u = getUserById(m.userId);
                                if (!u) return null;
                                const on = it.assigned.includes(m.userId);
                                return (
                                  <button
                                    key={m.userId}
                                    className={`aes-assign-chip ${on ? 'on' : ''}`}
                                    onClick={() => toggleItemAssign(it.id, m.userId)}
                                  >
                                    <Avatar user={u} size="sm" />
                                    <span>{m.userId === currentUser.id ? 'You' : u.name.split(' ')[0]}</span>
                                  </button>
                                );
                              })}
                            </div>

                            {price > 0 && (
                              who.length > 0 ? (
                                <div className="aes-item-hint text-tertiary text-xs">
                                  {formatCurrency(perEach, cur)} each · {who.length} {who.length === 1 ? 'person' : 'people'}
                                </div>
                              ) : (
                                <div className="aes-item-hint warn">Assign at least one person</div>
                              )
                            )}
                          </div>
                        );
                      })}

                      <button className="aes-add-item" onClick={addItem}>+ Add item</button>

                      {/* Summary */}
                      <div className="aes-items-summary">
                        <div className="aes-items-row">
                          <span>Items</span><span>{formatCurrency(itemsSum, cur)}</span>
                        </div>
                        {itemsSum > 0 && Math.abs(effectiveTotal - itemsSum) > 0.005 && (
                          <div className="aes-items-row">
                            <span>{effectiveTotal >= itemsSum ? 'Tax & tip' : 'Discount'}</span>
                            <span>
                              {effectiveTotal < itemsSum ? '−' : ''}
                              {formatCurrency(effectiveTotal - itemsSum, cur)}
                            </span>
                          </div>
                        )}
                        <div className="aes-items-row total">
                          <span>Total</span><span>{formatCurrency(effectiveTotal, cur)}</span>
                        </div>

                        <div className="aes-items-people">
                          {groupMemberIds.map(id => {
                            const u = getUserById(id);
                            const amt = itemAmountFor(id);
                            if (!u || amt <= 0) return null;
                            return (
                              <div key={id} className="aes-items-person">
                                <Avatar user={u} size="sm" />
                                <span className="aes-items-person-name">
                                  {id === currentUser.id ? 'You' : u.name.split(' ')[0]}
                                </span>
                                <span className="aes-items-person-amt">{formatCurrency(amt, cur)}</span>
                              </div>
                            );
                          })}
                        </div>

                        {itemsSum > effectiveTotal + 0.01 && (
                          <div className="aes-remainder">
                            The total is {formatCurrency(itemsSum - effectiveTotal, cur)} less than the items, so that
                            comes off as a discount, in proportion to what each person had. If an item or the total
                            was read wrong, fix it.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {viewingPhoto && (newPhoto || existingPhotoUrl) && (
              <ReceiptViewer
                src={newPhoto?.url ?? existingPhotoUrl!}
                title={description.trim() || 'Receipt photo'}
                onClose={() => setViewingPhoto(false)}
              />
            )}

            <div className="sheet-footer">
              <button className="sheet-cta" onClick={handleSubmit} disabled={!canSubmit}>
                {isEditing ? 'Save Changes' : 'Add Expense'}{ctaTotal > 0 ? ` · ${formatCurrency(ctaTotal, cur)}` : ''}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

