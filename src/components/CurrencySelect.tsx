import { useMemo } from 'react';
import { COMMON_CURRENCIES, allCurrencies, currencyName } from '../lib/currency';

interface CurrencySelectProps {
  value: string;
  onChange: (currency: string) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

/** Native select (works well on phones): common currencies first, then every other one. */
export default function CurrencySelect({ value, onChange, id, className = 'field-input', ...rest }: CurrencySelectProps) {
  const others = useMemo(() => allCurrencies().filter((c) => !COMMON_CURRENCIES.includes(c)), []);
  const option = (code: string) => (
    <option key={code} value={code}>
      {code} · {currencyName(code)}
    </option>
  );
  return (
    <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={rest['aria-label']}>
      <optgroup label="Common">{COMMON_CURRENCIES.map(option)}</optgroup>
      {others.length > 0 && <optgroup label="All currencies">{others.map(option)}</optgroup>}
    </select>
  );
}
