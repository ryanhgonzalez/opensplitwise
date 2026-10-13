import { useState, useMemo } from 'react';
import { useStore, selectCurrentUser } from '../store';
import { formatCurrency, formatSigned } from '../utils';
import { getShareForUser } from '../utils/expense';
import {
  type Period,
  type ViewMode,
  type CategoryBreakdown,
  type MonthlyPoint,
  type GroupContribution,
  filterByPeriod,
  getCategoryBreakdown,
  getMonthlyTrend,
  getGroupContributions,
} from '../lib/analytics';
import { currencySymbol, recordCurrency } from '../lib/currency';
import './Insights.css';

const PERIODS: { label: string; value: Period }[] = [
  { label: '1M', value: 1 },
  { label: '3M', value: 3 },
  { label: '6M', value: 6 },
  { label: 'All', value: 0 },
];

/** Axis labels: "$1.2k", "€80". */
function fmtShort(v: number, currency: string): string {
  const sym = currencySymbol(currency);
  if (v >= 1000) return `${sym}${(v / 1000).toFixed(1)}k`;
  return `${sym}${Math.round(v)}`;
}

// ── Category breakdown: one series, ranked bars ──────────────────────────────

function CategoryBars({ data, currency }: { data: CategoryBreakdown[]; currency: string }) {
  if (data.length === 0) {
    return <p className="ins-empty text-secondary">No expenses in this period</p>;
  }
  const max = Math.max(...data.map((d) => d.amount), 1);
  return (
    <div className="ruled" role="list">
      {data.map((item) => (
        <div
          key={item.category}
          className="ins-cat-row"
          role="listitem"
          title={`${item.label}: ${formatCurrency(item.amount, currency)} (${item.percentage.toFixed(1)}%)`}
        >
          <span className="ins-cat-label">{item.label}</span>
          <span className="ins-cat-track" aria-hidden>
            <span className="ins-cat-bar" style={{ width: `${(item.amount / max) * 100}%` }} />
          </span>
          <span className="num ins-cat-amount">{formatCurrency(item.amount, currency)}</span>
          <span className="num ins-cat-pct">{item.percentage.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Monthly trend: two series, paired columns with a hover readout ───────────

function MonthlyChart({ data, currency }: { data: MonthlyPoint[]; currency: string }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const maxVal = Math.max(...data.map((d) => d.total), 1);
  const hasData = data.some((d) => d.total > 0);
  const hov = hoveredIdx !== null ? data[hoveredIdx] : null;

  return (
    <div className="mc">
      <div className="mc-legend">
        <span className="mc-legend-item"><span className="mc-swatch mc-swatch-total" />Group total</span>
        <span className="mc-legend-item"><span className="mc-swatch mc-swatch-share" />Your share</span>
      </div>

      <div className="mc-plot">
        <div className="num mc-axis" aria-hidden>
          <span>{fmtShort(maxVal, currency)}</span>
          <span>{fmtShort(maxVal / 2, currency)}</span>
          <span>$0</span>
        </div>
        <div className="mc-area">
          <div className="mc-grid" style={{ top: 0 }} />
          <div className="mc-grid" style={{ top: '50%' }} />

          {hov && hov.total > 0 && (
            <div
              className="mc-tooltip"
              style={hoveredIdx! >= data.length / 2 ? { left: 8 } : { right: 8 }}
            >
              <p className="mc-tooltip-month">{hov.month}</p>
              <p><span className="mc-swatch mc-swatch-total" /> Total <strong className="num">{formatCurrency(hov.total, currency)}</strong></p>
              <p><span className="mc-swatch mc-swatch-share" /> Yours <strong className="num">{formatCurrency(hov.yourShare, currency)}</strong></p>
            </div>
          )}

          <div className="mc-bars">
            {data.map((point, i) => (
              <div
                key={point.key}
                className={`mc-col${hoveredIdx === i ? ' hovered' : ''}`}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                title={`${point.month}: total ${formatCurrency(point.total, currency)}, yours ${formatCurrency(point.yourShare, currency)}`}
              >
                <div className="mc-pair">
                  <div className="mc-bar mc-bar-total" style={{ height: `${(point.total / maxVal) * 100}%` }} />
                  <div className="mc-bar mc-bar-share" style={{ height: `${(point.yourShare / maxVal) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>

          {!hasData && <div className="mc-empty">No spending data for this period</div>}
        </div>
      </div>

      <div className="mc-labels">
        {data.map((point) => (
          <span key={point.key}>{point.month.split(' ')[0]}</span>
        ))}
      </div>
    </div>
  );
}

// ── Group contributions: paid bar against a share marker ─────────────────────

function GroupContributionBlock({ group, currency }: { group: GroupContribution; currency: string }) {
  return (
    <div className="gc">
      <div className="gc-head">
        <span className="gc-name">
          <span aria-hidden>{group.emoji}</span> {group.name}
        </span>
        <span className="num text-xs text-secondary">{formatCurrency(group.totalSpent, currency)} total</span>
      </div>
      <div className="ruled">
        {group.members.map((member) => {
          const paidPct = group.totalSpent > 0 ? (member.paid / group.totalSpent) * 100 : 0;
          const sharePct = group.totalSpent > 0 ? (member.share / group.totalSpent) * 100 : 0;
          const net = member.paid - member.share;
          const even = Math.abs(net) < 0.005;
          return (
            <div
              key={member.userId}
              className="gc-row"
              title={`${member.name}: paid ${formatCurrency(member.paid, currency)}, share ${formatCurrency(member.share, currency)}`}
            >
              <span className="gc-member">{member.name}</span>
              <span className="gc-track" aria-hidden>
                <span className="gc-paid" style={{ width: `${paidPct}%` }} />
                {sharePct > 0 && <span className="gc-share" style={{ left: `${Math.min(sharePct, 100)}%` }} />}
              </span>
              <span className="num gc-amount">{formatCurrency(member.paid, currency)}</span>
              <span className={`num gc-net ${even ? 'zero' : net > 0 ? 'pos' : 'neg'}`}>
                {even ? 'even' : formatSigned(net, currency)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Insights() {
  const allExpenses = useStore((s) => s.expenses);
  const groups = useStore((s) => s.groups);
  const users = useStore((s) => s.users);
  const currentUser = useStore(selectCurrentUser)!;

  const [period, setPeriod] = useState<Period>(3);
  const [viewMode, setViewMode] = useState<ViewMode>('personal');

  // Charts can't add euros to dollars, so the page shows one currency at a
  // time; the switch only appears when expenses use more than one.
  const currencies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of allExpenses) counts.set(recordCurrency(e), (counts.get(recordCurrency(e)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [allExpenses]);
  const [chosenCurrency, setChosenCurrency] = useState<string | null>(null);
  const currency = chosenCurrency && currencies.includes(chosenCurrency) ? chosenCurrency : currencies[0] ?? 'USD';

  const filtered = useMemo(
    () => filterByPeriod(allExpenses.filter((e) => recordCurrency(e) === currency), period),
    [allExpenses, period, currency],
  );

  const categoryData = useMemo(
    () => getCategoryBreakdown(filtered, currentUser.id, viewMode, groups),
    [filtered, currentUser.id, viewMode, groups],
  );

  const monthlyData = useMemo(
    () => getMonthlyTrend(filtered, currentUser.id, period),
    [filtered, currentUser.id, period],
  );

  const groupContributions = useMemo(
    () => getGroupContributions(filtered, groups, users, currentUser.id),
    [filtered, groups, users, currentUser.id],
  );

  const totalSpent = useMemo(() => {
    if (viewMode === 'personal') {
      return filtered.reduce((s, e) => s + getShareForUser(e, currentUser.id), 0);
    }
    return filtered.reduce((s, e) => s + e.amount, 0);
  }, [filtered, viewMode, currentUser.id]);

  const activeMonths = monthlyData.filter((m) => m.total > 0).length;
  const avgMonthly = activeMonths > 0 ? totalSpent / activeMonths : 0;
  const expenseCount = filtered.length;
  const topCategory = categoryData[0];

  return (
    <div className="page-content">
      <div className="insights-page">
        <header className="ins-header">
          <div>
            <h1 className="page-hero-title">Insights</h1>
            <p className="text-secondary ins-sub">Your spending overview</p>
          </div>
          <div className="ins-controls">
            <div className="seg" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <button key={p.value} aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
            {currencies.length > 1 && (
              <div className="seg ins-currency-seg" role="group" aria-label="Currency">
                {currencies.map((c) => (
                  <button key={c} aria-pressed={currency === c} onClick={() => setChosenCurrency(c)}>
                    {c}
                  </button>
                ))}
              </div>
            )}
            <div className="seg" role="group" aria-label="View">
              <button aria-pressed={viewMode === 'personal'} onClick={() => setViewMode('personal')}>My share</button>
              <button aria-pressed={viewMode === 'total'} onClick={() => setViewMode('total')}>Group total</button>
            </div>
          </div>
        </header>

        <section className="statement" aria-label="Summary">
          <div>
            <span className="cap">Total spent</span>
            <span className="num ins-figure">{formatCurrency(totalSpent, currency)}</span>
          </div>
          <div>
            <span className="cap">Avg / month</span>
            <span className="num ins-figure">{formatCurrency(avgMonthly, currency)}</span>
          </div>
          <div>
            <span className="cap">Expenses</span>
            <span className="num ins-figure">{expenseCount}</span>
            {topCategory && <span className="text-xs text-secondary">Top: {topCategory.label}</span>}
          </div>
        </section>

        <div className="ins-charts">
          <section className="ins-chart">
            <h2 className="ins-h2">Spending by category</h2>
            <CategoryBars data={categoryData} currency={currency} />
          </section>
          <section className="ins-chart">
            <h2 className="ins-h2">Spending trend</h2>
            <MonthlyChart data={monthlyData} currency={currency} />
          </section>
        </div>

        {groupContributions.length > 0 && (
          <section>
            <div className="ins-gc-head">
              <h2 className="ins-h2">Group contributions</h2>
              <div className="mc-legend">
                <span className="mc-legend-item"><span className="gc-legend-paid" />Paid</span>
                <span className="mc-legend-item"><span className="gc-legend-share" />Their share</span>
              </div>
            </div>
            <div className="ins-gc-grid">
              {groupContributions.map((group) => (
                <GroupContributionBlock key={group.groupId} group={group} currency={currency} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
