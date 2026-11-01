import { useId, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DATE_PRESET_LABELS,
  EMPTY_FILTER,
  activeFilterCount,
  parseISODate,
  type CategoryOption,
  type DatePreset,
  type ExpenseFilter,
} from '../lib/expenseFilter';
import '../styles/sheet.css';
import './ExpenseFilterBar.css';

const PRESETS: DatePreset[] = ['all', '7d', '30d', '3m', 'custom'];

const PRESET_CHIP: Partial<Record<DatePreset, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '3m': 'Last 3 months',
};

const shortDate = (iso?: string) =>
  parseISODate(iso)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "Oct 1 – Oct 14", "From Oct 1", "Until Oct 14". */
function rangeLabel(from?: string, to?: string): string {
  const a = shortDate(from);
  const b = shortDate(to);
  if (a && b) return `${a} – ${b}`;
  return a ? `From ${a}` : `Until ${b}`;
}

interface Person {
  id: string;
  /** As the list shows them: "You", "Ben". */
  name: string;
}

interface ExpenseFilterBarProps {
  value: ExpenseFilter;
  onChange: (next: ExpenseFilter) => void;
  /** How many expenses survive the filter. */
  matchCount: number;
  /** Categories to offer, from `categoryOptions`. Shown when there are two or more. */
  categories?: CategoryOption[];
  /** Who can be picked under "Paid by". Shown when there are two or more. */
  people?: Person[];
}

const X_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

/**
 * A search box and a Filter button. The date, category and payer choices live
 * in a sheet, so the list starts right under the search; whatever is set shows
 * as chips that clear with a tap.
 */
export default function ExpenseFilterBar({
  value,
  onChange,
  matchCount,
  categories = [],
  people = [],
}: ExpenseFilterBarProps) {
  const searchId = useId();
  const fromId = useId();
  const toId = useId();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(value);

  const patch = (updates: Partial<ExpenseFilter>) => onChange({ ...value, ...updates });

  const selectPreset = (preset: DatePreset) =>
    // Leaving a custom range drops its bounds, so returning to it later starts
    // blank rather than silently re-applying dates the user can no longer see.
    patch(preset === 'custom' ? { preset } : { preset, from: undefined, to: undefined });

  const chosen = value.categories ?? [];
  const isChosen = (option: CategoryOption) => option.ids.some((id) => chosen.includes(id));
  const toggleCategory = (option: CategoryOption) =>
    patch({
      categories: isChosen(option)
        ? chosen.filter((id) => !option.ids.includes(id))
        : [...chosen, ...option.ids],
    });

  const payers = value.payers ?? [];
  const togglePayer = (id: string) =>
    patch({ payers: payers.includes(id) ? payers.filter((p) => p !== id) : [...payers, id] });

  // What's set, as chips under the search.
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (value.preset === 'custom' ? value.from || value.to : value.preset !== 'all') {
    chips.push({
      key: 'date',
      label: value.preset === 'custom' ? rangeLabel(value.from, value.to) : PRESET_CHIP[value.preset]!,
      clear: () => patch({ preset: 'all', from: undefined, to: undefined }),
    });
  }
  if (chosen.length) {
    const picked = categories.filter(isChosen);
    chips.push({
      key: 'cat',
      label: picked.length === 1 ? picked[0].label : `${picked.length || chosen.length} categories`,
      clear: () => patch({ categories: [] }),
    });
  }
  if (payers.length) {
    const only = payers.length === 1 ? people.find((p) => p.id === payers[0]) : undefined;
    chips.push({
      key: 'payer',
      label: only ? `Paid by ${only.name === 'You' ? 'you' : only.name}` : `Paid by ${payers.length} people`,
      clear: () => patch({ payers: [] }),
    });
  }

  return (
    <div className="exf">
      <div className="exf-top">
        <div className="exf-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.8" />
            <path d="M21 21L16.65 16.65" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <label htmlFor={searchId} className="exf-visually-hidden">
            Search expenses
          </label>
          <input
            id={searchId}
            type="search"
            className="exf-search-input"
            placeholder="Search"
            value={value.query}
            onChange={(e) => patch({ query: e.target.value })}
            autoComplete="off"
          />
          {value.query && (
            <button type="button" className="exf-clear" onClick={() => patch({ query: '' })} aria-label="Clear search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          className={`exf-open ${count ? 'active' : ''}`}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Filter{count ? ` · ${count}` : ''}
        </button>
      </div>

      {chips.length > 0 && (
        <div className="exf-chips">
          {chips.map((c) => (
            <button key={c.key} type="button" className="exf-applied" onClick={c.clear} aria-label={`${c.label}. Remove this filter`}>
              {c.label}
              {X_ICON}
            </button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            className="sheet-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              className="sheet-panel exf-sheet"
              role="dialog"
              aria-label="Filter expenses"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 340 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sheet-handle" />
              <div className="sheet-header">
                <span className="sheet-title">Filter expenses</span>
                {count > 0 ? (
                  <button
                    type="button"
                    className="exf-reset"
                    onClick={() => onChange({ ...EMPTY_FILTER, query: value.query })}
                  >
                    Clear
                  </button>
                ) : (
                  <button className="sheet-close" onClick={() => setOpen(false)} aria-label="Close">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="sheet-body exf-body">
                <div className="exf-group" role="group" aria-labelledby={`${searchId}-when`}>
                  <p className="exf-label" id={`${searchId}-when`}>When</p>
                  <div className="exf-options">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`exf-option ${value.preset === preset ? 'active' : ''}`}
                        aria-pressed={value.preset === preset}
                        onClick={() => selectPreset(preset)}
                      >
                        {DATE_PRESET_LABELS[preset]}
                      </button>
                    ))}
                  </div>
                  {value.preset === 'custom' && (
                    <div className="exf-range-inner">
                      <div className="exf-range-field">
                        <label htmlFor={fromId} className="text-xs text-secondary">From</label>
                        <input
                          id={fromId}
                          type="date"
                          className="exf-date-input"
                          value={value.from ?? ''}
                          max={value.to || undefined}
                          onChange={(e) => patch({ from: e.target.value || undefined })}
                        />
                      </div>
                      <div className="exf-range-field">
                        <label htmlFor={toId} className="text-xs text-secondary">To</label>
                        <input
                          id={toId}
                          type="date"
                          className="exf-date-input"
                          value={value.to ?? ''}
                          min={value.from || undefined}
                          onChange={(e) => patch({ to: e.target.value || undefined })}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {categories.length >= 2 && (
                  <div className="exf-group" role="group" aria-labelledby={`${searchId}-cat`}>
                    <p className="exf-label" id={`${searchId}-cat`}>Category</p>
                    <div className="exf-options">
                      {categories.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className={`exf-option ${isChosen(option) ? 'active' : ''}`}
                          aria-pressed={isChosen(option)}
                          onClick={() => toggleCategory(option)}
                        >
                          {option.label}
                          <span className="exf-count num">{option.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {people.length >= 2 && (
                  <div className="exf-group" role="group" aria-labelledby={`${searchId}-paid`}>
                    <p className="exf-label" id={`${searchId}-paid`}>Paid by</p>
                    <div className="exf-options">
                      <button
                        type="button"
                        className={`exf-option ${payers.length === 0 ? 'active' : ''}`}
                        aria-pressed={payers.length === 0}
                        onClick={() => patch({ payers: [] })}
                      >
                        Anyone
                      </button>
                      {people.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`exf-option ${payers.includes(p.id) ? 'active' : ''}`}
                          aria-pressed={payers.includes(p.id)}
                          onClick={() => togglePayer(p.id)}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="sheet-footer">
                <button type="button" className="sheet-cta" onClick={() => setOpen(false)}>
                  {matchCount === 0 ? 'No matches' : `Show ${matchCount} expense${matchCount === 1 ? '' : 's'}`}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
