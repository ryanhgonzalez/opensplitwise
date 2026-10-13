import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser } from '../store';
import { buildSplit, round, splitByItems } from '../lib/calculations';
import type { CategoryId, Expense, SplitType, ExpenseSplit } from '../types';
import { BUILT_IN_CATEGORIES, MAX_CATEGORY_NAME, categoryLabel, isCustomCategory } from '../lib/categories';
import { convertSplit, currencySymbol, groupCurrency, recordCurrency } from '../lib/currency';
import CurrencySelect from './CurrencySelect';
import ReceiptViewer from './ReceiptViewer';
import { compressReceiptPhoto, formatBytes, loadPhoto, savePhoto } from '../lib/receiptPhotos';
import { FREQUENCY_LABELS, nextOccurrence, ruleIdOf } from '../lib/recurring';
import { showToast } from '../lib/toast';
import type { RepeatFrequency } from '../types';
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
  /** Duplicate: start a new expense from this one's details (not its date or photo). */
  template?: Expense;
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

/** "Today", "Yesterday", or the date; an empty field means today. */
function dateLabel(str: string): string {
  if (!str) return 'Today';
  const d = fromDateInputValue(str);
  const today = new Date();
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - d.getTime()) / 86_400_000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

/** Categories shown before "More…". */
const TOP_CATEGORIES = 4;
/** Fills the row for a group with few expenses yet. */
const DEFAULT_CATEGORIES: CategoryId[] = ['food', 'groceries', 'transport', 'accommodation', 'shopping'];

let itemSeq = 0;
const newItemId = () => `item-${Date.now()}-${itemSeq++}`;

export default function AddExpenseSheet({ open, onClose, defaultGroupId, editExpense, template }: AddExpenseSheetProps) {
  const isEditing = !!editExpense;
  // Where the form's starting values come from: the expense being edited, or the one being duplicated.
  const source = editExpense ?? template;
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore(s => s.users);
  const groups = useStore(s => s.groups);
  const addExpense = useStore(s => s.addExpense);
  const updateExpense = useStore(s => s.updateExpense);
  const addGroupCategory = useStore(s => s.addGroupCategory);
  const addRecurring = useStore(s => s.addRecurring);
  const recurring = useStore(s => s.recurring);
  const allExpenses = useStore(s => s.expenses);

  const initSplitType = (e?: Expense): SplitMode =>
    e?.items?.length ? 'items'
    : e?.split.type === 'percentage' ? 'exact' : (e?.split.type === 'shares' ? 'exact' : (e?.split.type ?? 'equal'));

  // Paid in another currency than the group's: the form shows and edits what was
  // actually paid; balances get the converted figures on save.
  const sourceForeign =
    source?.original && source.original.currency !== recordCurrency(source)
      ? source.original
      : undefined;

  const [description, setDescription] = useState(source?.description ?? '');
  const [amountStr, setAmountStr] = useState(source ? String(sourceForeign?.amount ?? source.amount) : '');
  /** The currency the amount is entered in; null = the group's. */
  const [entryCurrency, setEntryCurrency] = useState<string | null>(sourceForeign?.currency ?? null);
  /** Group currency per 1 unit of the entry currency, as typed. */
  const [rateStr, setRateStr] = useState(sourceForeign ? String(sourceForeign.rate) : '');
  const [category, setCategory] = useState<CategoryId>(source?.category ?? 'food');
  // Inline "+ New" category entry; null while closed.
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [newCategoryHint, setNewCategoryHint] = useState<string | null>(null);
  const [dateStr, setDateStr] = useState(editExpense ? toDateInputValue(editExpense.date) : '');
  const [groupId, setGroupId] = useState(source?.groupId ?? defaultGroupId ?? '');
  const [paidBy, setPaidBy] = useState(source?.paidBy ?? currentUser.id);
  const [splitType, setSplitType] = useState<SplitMode>(initSplitType(source));
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [lineItems, setLineItems] = useState<ItemRow[]>([]);
  const [showAllCategories, setShowAllCategories] = useState(false);
  /** The date came from a scanned receipt (until changed by hand). */
  const [scannedDate, setScannedDate] = useState(false);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // Receipt scanning (client-side OCR — fills a draft the user reviews before saving)
  const cameraInputRef = useRef<HTMLInputElement>(null); // capture=camera (touch devices)
  const fileInputRef = useRef<HTMLInputElement>(null);   // library / file picker (all devices)
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  // Repeating: set when adding; an edited repeat shows its rule instead.
  const [repeat, setRepeat] = useState<RepeatFrequency | ''>('');
  const editRule = editExpense ? recurring.find(r => r.id === ruleIdOf(editExpense.id)) : undefined;
  const editingLatestRepeat = !!editRule && allExpenses
    .filter(e => ruleIdOf(e.id) === editRule.id)
    .every(e => e.date <= editExpense!.date);

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

  // The group's most-used categories first (all groups when none is picked yet),
  // topped up with common ones; the chosen one always shows.
  const topCategories = useMemo(() => {
    const counts = new Map<CategoryId, number>();
    for (const e of allExpenses) {
      if (groupId && e.groupId !== groupId) continue;
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    }
    const valid = (c: CategoryId) => !isCustomCategory(c) || !!selectedGroup?.categories?.some(x => x.id === c);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).filter(valid);
    return [...new Set([...ranked, ...DEFAULT_CATEGORIES])].slice(0, TOP_CATEGORIES);
  }, [allExpenses, groupId, selectedGroup]);
  const allCategories: CategoryId[] = [...BUILT_IN_CATEGORIES, ...(selectedGroup?.categories?.map(c => c.id) ?? [])];
  const shownCategories = showAllCategories
    ? allCategories
    : topCategories.includes(category) ? topCategories : [...topCategories, category];

  const openNewCategory = () => {
    if (!selectedGroup) {
      setNewCategoryHint('Choose a group first. Custom categories are saved to the group.');
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

    if (source && source.groupId === selectedGroup.id) {
      const eSplitType = initSplitType(source);
      setSplitType(eSplitType);
      // Split by item: bring the receipt's lines back, to adjust.
      if (source.items?.length) {
        const memberIds = selectedGroup.members.map(m => m.userId);
        setLineItems(source.items.map(it => ({
          id: newItemId(),
          description: it.description,
          price: it.amount.toFixed(2),
          assigned: it.assigned.filter(id => memberIds.includes(id)),
        })));
      }
      // Shares are stored converted; show them in the currency the amount is edited in.
      const entries = sourceForeign
        ? convertSplit(source.split.entries, 1 / sourceForeign.rate, sourceForeign.amount)
        : source.split.entries;
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
      if (result.date) { setDateStr(toDateInputValue(result.date)); setScannedDate(true); filledAny = true; }
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
    } else if (repeat && groupId) {
      // Repeating: the rule adds this one (if its date has come) and the rest as they're due.
      const start = new Date(expenseDate.getFullYear(), expenseDate.getMonth(), expenseDate.getDate());
      const { rule, added: repeats } = addRecurring({
        groupId,
        frequency: repeat,
        startDate: start,
        template: { description: description.trim(), amount, currency: groupCur, original, paidBy, split, category, items },
        receipt,
      });
      if (newPhoto && repeats[0]) void savePhoto(repeats[0].id, newPhoto.blob);
      const next = nextOccurrence(rule, new Date(Date.now() + 86_400_000));
      showToast({
        message: `${description.trim()} repeats ${FREQUENCY_LABELS[repeat].toLowerCase()}; next on ${next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      });
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
    setRepeat('');
    setRemoveExisting(false);
    setViewingPhoto(false);
    setPhotoError(null);
    setDescription(source?.description ?? '');
    setAmountStr(source ? String(sourceForeign?.amount ?? source.amount) : '');
    setEntryCurrency(sourceForeign?.currency ?? null);
    setRateStr(sourceForeign ? String(sourceForeign.rate) : '');
    setCategory(source?.category ?? 'food');
    setNewCategory(null);
    setNewCategoryHint(null);
    setDateStr(editExpense ? toDateInputValue(editExpense.date) : '');
    setGroupId(source?.groupId ?? defaultGroupId ?? '');
    setPaidBy(source?.paidBy ?? currentUser.id);
    setSplitType(initSplitType(source));
    setParticipants([]);
    setLineItems([]);
    setShowAllCategories(false);
    setScannedDate(false);
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
            className="sheet-panel aes-panel"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">{isEditing ? 'Edit expense' : template ? 'Duplicate expense' : 'Add expense'}</span>
              <button className="sheet-close" onClick={handleClose} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="sheet-body">
              <div className="aes-layout">
              <div className="aes-col-details">
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
                    <div className="aes-scan-strip busy" role="status">
                      <span className="aes-scan-spinner" aria-hidden />
                      <span className="aes-scan-text">
                        <span className="aes-scan-title">{scanStatus}</span>
                      </span>
                    </div>
                  ) : scanned && newPhoto ? (
                    <div className="aes-scan-strip done">
                      <button type="button" className="aes-scan-thumb" onClick={() => setViewingPhoto(true)} aria-label="View receipt photo">
                        <img src={newPhoto.url} alt="" />
                      </button>
                      <span className="aes-scan-text">
                        <span className="aes-scan-title">Read from the receipt</span>
                        <span className="aes-scan-sub">
                          {lineItems.length > 0
                            ? `Total, date and ${lineItems.length} items · check them`
                            : 'Check what it filled in'}
                        </span>
                      </span>
                      <button type="button" className="aes-scan-link" onClick={() => fileInputRef.current?.click()}>
                        Rescan
                      </button>
                    </div>
                  ) : (
                    <div className="aes-scan-strip">
                      <svg className="aes-scan-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                        <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                      <span className="aes-scan-text">
                        <span className="aes-scan-title">Scan a receipt</span>
                        <span className="aes-scan-sub">Fills in the total, date and items</span>
                      </span>
                      {/* Camera capture — only useful on touch devices (hidden on desktop via CSS) */}
                      <button type="button" className="aes-scan-btn aes-scan-camera" onClick={() => cameraInputRef.current?.click()}>
                        Camera
                      </button>
                      {/* Library / file picker — on iOS/Android this sheet also offers the camera */}
                      <button type="button" className="aes-scan-btn" onClick={() => fileInputRef.current?.click()}>
                        Photo
                      </button>
                    </div>
                  )}
                  {scanError && <div className="aes-scan-msg error">{scanError}</div>}
                  {!scanning && !scanned && !newPhoto && (
                    <button type="button" className="aes-scan-attach" onClick={() => photoInputRef.current?.click()}>
                      Or attach a photo without reading it
                    </button>
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
                {(newPhoto && !scanned) || (hasExisting && existingPhotoUrl) ? (
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
                ) : isEditing && !newPhoto ? (
                  <button type="button" className="aes-photo-add" onClick={() => photoInputRef.current?.click()}>
                    + Attach receipt photo
                  </button>
                ) : null}
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
              <input
                className="field-input aes-description"
                placeholder="What was it for?"
                aria-label="What was it for?"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />

              {/* Group (only shown when no default) */}
              {!defaultGroupId && (
                <div className="field-group">
                  <div className="field-label">Group</div>
                  {groups.length === 0 ? (
                    <p className="text-secondary text-sm">No groups yet — create one first</p>
                  ) : (
                    <div className="aes-group-picker">
                      {groups.map(g => (
                        <button
                          key={g.id}
                          type="button"
                          className={`aes-group-option ${groupId === g.id ? 'active' : ''}`}
                          aria-pressed={groupId === g.id}
                          onClick={() => setGroupId(g.id)}
                        >
                          <span aria-hidden>{g.emoji}</span>
                          <span className="aes-group-name">{g.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Scanned before a group was picked: the items are waiting for one */}
              {!selectedGroup && lineItems.length > 0 && (
                <div className="aes-pending-items">
                  <div className="aes-pending-head">
                    <span>{lineItems.length} {lineItems.length === 1 ? 'item' : 'items'} from the receipt</span>
                    <span className="num">{formatCurrency(itemsSum, cur)}</span>
                  </div>
                  <p className="aes-pending-hint">
                    Pick a group above and they'll be split by item, shared by everyone until you change who had what.
                  </p>
                  <div className="aes-pending-list">
                    {lineItems.slice(0, 3).map(it => (
                      <div key={it.id} className="aes-pending-row">
                        <span>{it.description || 'Item'}</span>
                        <span className="num">{formatCurrency(parseFloat(it.price) || 0, cur)}</span>
                      </div>
                    ))}
                    {lineItems.length > 3 && <div className="aes-pending-row">and {lineItems.length - 3} more</div>}
                  </div>
                </div>
              )}

              {/* Paid by · Date · Repeats: compact, each opens its own picker */}
              <div className="aes-pills">
                <label className={`aes-pill ${selectedGroup ? '' : 'disabled'}`}>
                  <span className="aes-pill-label">Paid by</span>
                  <span className="aes-pill-value">{paidBy === currentUser.id ? 'You' : getUserById(paidBy)?.name.split(' ')[0] ?? 'You'} ▾</span>
                  <select
                    className="aes-pill-select"
                    aria-label="Paid by"
                    value={paidBy}
                    disabled={!selectedGroup}
                    onChange={e => setPaidBy(e.target.value)}
                  >
                    {(selectedGroup?.members.map(m => m.userId) ?? [currentUser.id]).map(uid => (
                      <option key={uid} value={uid}>
                        {uid === currentUser.id ? 'You' : getUserById(uid)?.name ?? 'Someone'}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="aes-pill"
                  onClick={() => {
                    const el = dateInputRef.current;
                    if (!el) return;
                    try { el.showPicker(); } catch { el.focus(); }
                  }}
                >
                  <span className="aes-pill-label">{scannedDate ? 'Date · from receipt' : 'Date'}</span>
                  <span className="aes-pill-value">{dateLabel(dateStr)} ▾</span>
                  <input
                    ref={dateInputRef}
                    className="aes-pill-date"
                    type="date"
                    tabIndex={-1}
                    aria-label="Date"
                    value={dateStr}
                    onChange={e => { setDateStr(e.target.value); setScannedDate(false); }}
                  />
                </button>
                {!isEditing && (
                  <label className="aes-pill">
                    <span className="aes-pill-label">Repeats</span>
                    <span className="aes-pill-value">{repeat ? FREQUENCY_LABELS[repeat] : 'Never'} ▾</span>
                    <select
                      id="aes-repeat"
                      className="aes-pill-select"
                      aria-label="Repeats"
                      value={repeat}
                      onChange={e => setRepeat(e.target.value as RepeatFrequency | '')}
                    >
                      <option value="">Never</option>
                      {(Object.keys(FREQUENCY_LABELS) as RepeatFrequency[]).map(f => (
                        <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {repeat && (
                <div className="aes-field-hint text-tertiary text-xs aes-repeat-hint">
                  Added automatically on each date, starting with this one. Stop it from the group page.
                </div>
              )}
              {isEditing && editRule && (
                <div className="aes-repeat-note">
                  Repeats {FREQUENCY_LABELS[editRule.frequency].toLowerCase()}.{' '}
                  {editingLatestRepeat
                    ? 'Changes here also apply to the next ones.'
                    : 'Only this one changes; edit the latest to change the next ones.'}
                </div>
              )}

              {/* Category: the group's most used first; the rest behind More */}
              <div className="field-group">
                <div className="field-label">Category</div>
                <div className="aes-category-row">
                  {shownCategories.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`aes-category-btn ${category === c ? 'active' : ''}`}
                      aria-pressed={category === c}
                      onClick={() => setCategory(c)}
                    >
                      {categoryLabel(c, selectedGroup)}
                    </button>
                  ))}
                  {!showAllCategories ? (
                    <button type="button" className="aes-category-btn aes-category-new" onClick={() => setShowAllCategories(true)}>
                      More…
                    </button>
                  ) : newCategory === null ? (
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
              </div>

              <div className="aes-col-split">
              {!selectedGroup && (
                <p className="aes-split-placeholder">Pick a group to choose who's in it and how it's split.</p>
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
              </div>
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
                {isEditing ? 'Save changes' : 'Add expense'}{ctaTotal > 0 ? ` · ${formatCurrency(ctaTotal, cur)}` : ''}
              </button>
              {!groupId && <p className="aes-cta-hint">Pick a group to add it</p>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

