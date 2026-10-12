import { useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DATE_PRESET_LABELS,
  EMPTY_FILTER,
  isFilterActive,
  type CategoryOption,
  type DatePreset,
  type ExpenseFilter,
} from '../lib/expenseFilter';
import './ExpenseFilterBar.css';

const PRESETS: DatePreset[] = ['all', '7d', '30d', '3m', 'custom'];

interface ExpenseFilterBarProps {
  value: ExpenseFilter;
  onChange: (next: ExpenseFilter) => void;
  /** How many expenses survive the filter, and how many there are in total. */
  matchCount: number;
  totalCount: number;
  /** Categories to offer, from `categoryOptions`. The row shows when there are two or more. */
  categories?: CategoryOption[];
}

export default function ExpenseFilterBar({
  value,
  onChange,
  matchCount,
  totalCount,
  categories = [],
}: ExpenseFilterBarProps) {
  const searchId = useId();
  const fromId = useId();
  const toId = useId();
  const active = isFilterActive(value);

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

  return (
    <div className="exf">
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
          placeholder="Search expenses…"
          value={value.query}
          onChange={(e) => patch({ query: e.target.value })}
          autoComplete="off"
        />
        {value.query && (
          <button
            type="button"
            className="exf-clear"
            onClick={() => patch({ query: '' })}
            aria-label="Clear search"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      <div className="exf-presets" role="group" aria-label="Filter by date">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`exf-chip ${value.preset === preset ? 'active' : ''}`}
            aria-pressed={value.preset === preset}
            onClick={() => selectPreset(preset)}
          >
            {DATE_PRESET_LABELS[preset]}
          </button>
        ))}
      </div>

      {categories.length >= 2 && (
        <div className="exf-categories" role="group" aria-label="Filter by category">
          {categories.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`exf-cat ${isChosen(option) ? 'active' : ''}`}
              aria-pressed={isChosen(option)}
              onClick={() => toggleCategory(option)}
            >
              {option.label}
              <span className="exf-cat-count num">{option.count}</span>
            </button>
          ))}
        </div>
      )}

      <AnimatePresence initial={false}>
        {value.preset === 'custom' && (
          <motion.div
            className="exf-range"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
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
          </motion.div>
        )}
      </AnimatePresence>

      {active && (
        <div className="exf-summary">
          <span className="text-xs text-secondary" aria-live="polite">
            {matchCount === 0
              ? 'No matches'
              : `Showing ${matchCount} of ${totalCount} expense${totalCount !== 1 ? 's' : ''}`}
          </span>
          <button type="button" className="exf-reset" onClick={() => onChange(EMPTY_FILTER)}>
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
