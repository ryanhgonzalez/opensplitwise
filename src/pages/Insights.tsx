import { useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore, selectCurrentUser } from '../store';
import Avatar from '../components/Avatar';
import { formatCurrency } from '../utils';
import {
  type Period,
  type ViewMode,
  type CategoryBreakdown,
  type GroupContribution,
  type Step,
  type TrendPoint,
  chooseStep,
  getCategoryBreakdown,
  getGroupContributions,
  getLargestExpenses,
  getSharedWith,
  getTrend,
  inRange,
  previousRange,
  trendRange,
  valueOf,
} from '../lib/analytics';
import { groupCurrency, recordCurrency } from '../lib/currency';
import '../styles/sheet.css';
import './Insights.css';

const PERIODS: { label: string; value: Period }[] = [
  { label: '1M', value: 1 },
  { label: '3M', value: 3 },
  { label: '6M', value: 6 },
  { label: 'All', value: 0 },
];

/**
 * Like formatCurrency, but keeps a minus: refunds can leave a month, a total or
 * what someone paid below zero, and "$480.00" would read as money spent.
 */
function money(n: number, currency: string): string {
  return `${n <= -0.005 ? '−' : ''}${formatCurrency(n, currency)}`;
}

/** "▲ 24%", "▼ 8%", "same", "new": how a figure moved against the period before. */
function change(now: number, before: number | undefined): string | null {
  if (before === undefined) return null;
  if (Math.abs(before) < 0.005) return Math.abs(now) < 0.005 ? 'same' : 'new';
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.5) return 'same';
  return `${pct > 0 ? '▲' : '▼'} ${Math.round(Math.abs(pct))}%`;
}

const STEP_WORD: Record<Step, string> = { day: 'day', week: 'week', month: 'month' };

const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ── Category breakdown: one series, ranked bars ──────────────────────────────

function CategoryBars({
  data,
  currency,
  before,
}: {
  data: CategoryBreakdown[];
  currency: string;
  /** Each category's spending in the period before, when there is one. */
  before?: Map<string, number>;
}) {
  if (data.length === 0) {
    return <p className="ins-empty text-secondary">No expenses in this period</p>;
  }
  const max = Math.max(...data.map((d) => d.amount), 1);
  return (
    <div className={`ruled ${before ? 'ins-cat-compare' : ''}`} role="list">
      {data.map((item) => {
        const moved = before ? change(item.amount, before.get(item.category) ?? 0) : null;
        return (
          <div
            key={item.category}
            className="ins-cat-row"
            role="listitem"
            title={`${item.label}: ${money(item.amount, currency)} (${item.percentage.toFixed(1)}%)`}
          >
            <span className="ins-cat-label">{item.label}</span>
            <span className="ins-cat-track" aria-hidden>
              <span className="ins-cat-bar" style={{ width: `${(item.amount / max) * 100}%` }} />
            </span>
            <span className="num ins-cat-amount">{money(item.amount, currency)}</span>
            <span className="num ins-cat-pct">
              {moved ? <span aria-label={`${moved} on the period before`}>{moved}</span> : `${item.percentage.toFixed(1)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Trend: one series, stepped by day, week or month ─────────────────────────

/** A round axis top: €350, €1.5k. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3.5 ? 3.5 : n <= 5 ? 5 : n <= 7.5 ? 7.5 : 10) * p;
}

function TrendChart({
  points,
  step,
  currency,
  average,
  dayNumbers,
  detail,
}: {
  points: TrendPoint[];
  step: Step;
  currency: string;
  average: number;
  /** A trip: call each day "Day 2". */
  dayNumbers: boolean;
  /** What the readout says about a step's expenses. */
  detail: (p: TrendPoint) => string;
}) {
  const [hoverIdx, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  // A hover shows its step; otherwise the one tapped stays up.
  const hovered = hoverIdx ?? pinned;
  const values = points.map((p) => p.value);
  const top = niceMax(Math.max(...values, 0));
  const bottom = Math.min(0, ...values) < 0 ? -niceMax(-Math.min(...values)) : 0;
  const span = top - bottom;
  const y = (v: number) => ((v - bottom) / span) * 100; // % from the bottom
  const hasData = points.some((p) => Math.abs(p.value) > 0.005);
  const hov = hovered !== null ? points[hovered] : null;

  const title = (p: TrendPoint, i: number) =>
    step === 'day'
      ? `${dayNumbers ? `Day ${i + 1} · ` : ''}${p.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : step === 'week'
        ? `Week of ${shortDate(p.start)}`
        : p.start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // About seven labels, counting back from the newest step.
  const every = Math.ceil(points.length / 7);
  const label = (p: TrendPoint, i: number) => {
    if ((points.length - 1 - i) % every !== 0) return '';
    if (step === 'day') return String(p.start.getDate());
    if (step === 'week') return shortDate(p.start).toUpperCase();
    const mon = p.start.toLocaleDateString('en-US', { month: 'short' });
    return points.length > 12 && (i === 0 || p.start.getMonth() === 0) ? `${mon} '${String(p.start.getFullYear()).slice(2)}` : mon;
  };

  return (
    <div className="tr">
      <div className="tr-plot">
        <div className="num tr-axis" aria-hidden>
          <span>{money(top, currency).replace(/\.00$/, '')}</span>
          <span>{money((top + bottom) / 2, currency).replace(/\.00$/, '')}</span>
          <span>{money(bottom, currency).replace(/\.00$/, '')}</span>
        </div>
        <div className="tr-area">
          <div className="tr-grid" style={{ bottom: '100%' }} />
          <div className="tr-grid" style={{ bottom: '50%' }} />
          <div className="tr-grid tr-zero" style={{ bottom: `${y(0)}%` }} />
          {hasData && <div className="tr-avg" style={{ bottom: `${y(average)}%` }} aria-hidden />}

          <div className="tr-bars">
            {points.map((p, i) => {
              const h = Math.abs(y(p.value) - y(0));
              return (
                <button
                  key={p.key}
                  type="button"
                  className={`tr-col${hovered === i ? ' hovered' : ''}${p.partial ? ' partial' : ''}`}
                  // A mouse shows the figures on hover; keyboard focus does too.
                  onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(i)}
                  onPointerLeave={(e) => e.pointerType === 'mouse' && setHovered(null)}
                  onFocus={(e) => e.currentTarget.matches(':focus-visible') && setHovered(i)}
                  onBlur={() => setHovered(null)}
                  // Phones have no hover: a tap pins the step's figures, a second tap hides them.
                  onClick={() => setPinned(pinned === i ? null : i)}
                  aria-label={`${title(p, i)}: ${money(p.value, currency)}`}
                >
                  <span
                    className={`tr-bar ${p.value < 0 ? 'neg' : ''}`}
                    style={p.value < 0 ? { top: `${100 - y(0)}%`, height: `${h}%` } : { bottom: `${y(0)}%`, height: `${h}%` }}
                  />
                </button>
              );
            })}
          </div>

          {hov && (
            <div className="tr-tooltip" style={hovered! >= points.length / 2 ? { right: `${100 - ((hovered! + 1) / points.length) * 100}%` } : { left: `${(hovered! / points.length) * 100}%` }}>
              <p className="tr-tooltip-title">{title(hov, hovered!)}</p>
              <p>
                {money(hov.value, currency)}
                {hov.partial ? ' so far' : ''}
              </p>
              {hov.expenses.length > 0 && <p className="tr-tooltip-detail">{detail(hov)}</p>}
            </div>
          )}

          {!hasData && <div className="tr-empty">No spending in this period</div>}
        </div>
      </div>
      <div className="num tr-labels" aria-hidden>
        {points.map((p, i) => (
          <span key={p.key}>{label(p, i)}</span>
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
        <span className="num text-xs text-secondary">{money(group.totalSpent, currency)} total</span>
      </div>
      <div className="ruled">
        {group.members.map((member) => {
          const paidPct = group.totalSpent > 0 ? (member.paid / group.totalSpent) * 100 : 0;
          const sharePct = group.totalSpent > 0 ? (member.share / group.totalSpent) * 100 : 0;
          return (
            <div
              key={member.userId}
              className="gc-row"
              title={`${member.name}: paid ${money(member.paid, currency)}, share ${money(member.share, currency)}`}
            >
              <span className="gc-member">{member.name}</span>
              <span className="gc-track" aria-hidden>
                <span className="gc-paid" style={{ width: `${paidPct}%` }} />
                {sharePct > 0 && <span className="gc-share" style={{ left: `${Math.min(sharePct, 100)}%` }} />}
              </span>
              <span className="num gc-amount">{money(member.paid, currency)}</span>
              {/* Not paid minus share: payments between people aren't spending, so that
                  difference isn't what anyone owes. Balances are on the group's page. */}
              <span className="num gc-share-amount">{money(member.share, currency)}</span>
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
  const me = currentUser.id;

  // One group, or all of them. In the address so a group's page can link here.
  const [params, setParams] = useSearchParams();
  const group = groups.find((g) => g.id === params.get('group'));
  const chooseGroup = (id: string) =>
    setParams((p) => {
      if (id) p.set('group', id);
      else p.delete('group');
      return p;
    }, { replace: true });
  const scoped = useMemo(
    () => (group ? allExpenses.filter((e) => e.groupId === group.id) : allExpenses),
    [allExpenses, group],
  );

  // A trip or event has a clear start and end, so a group opens on all of it.
  const [period, setPeriod] = useState<Period>(() => (group ? 0 : 3));
  const [viewMode, setViewMode] = useState<ViewMode>('personal');

  // Charts can't add euros to dollars, so the page shows one currency at a
  // time; the switch only appears when expenses use more than one.
  const currencies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of scoped) counts.set(recordCurrency(e), (counts.get(recordCurrency(e)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [scoped]);
  const [chosenCurrency, setChosenCurrency] = useState<string | null>(null);
  // A group has one currency; across groups, the one chosen or the most used.
  const currency = group
    ? groupCurrency(group)
    : chosenCurrency && currencies.includes(chosenCurrency) ? chosenCurrency : currencies[0] ?? 'USD';

  const inCurrency = useMemo(() => scoped.filter((e) => recordCurrency(e) === currency), [scoped, currency]);
  // What the page covers, and the time step that suits its length.
  const range = useMemo(() => trendRange(inCurrency, period, !!group), [inCurrency, period, group]);
  const step = chooseStep(range);
  const filtered = useMemo(() => inRange(inCurrency, range), [inCurrency, range]);
  // The same length of time just before, to say what changed. None for "All".
  const before = useMemo(() => {
    const prev = previousRange(range, period);
    return prev ? { range: prev, expenses: inRange(inCurrency, prev) } : null;
  }, [range, period, inCurrency]);

  const trend = useMemo(() => getTrend(filtered, me, viewMode, range, step), [filtered, me, viewMode, range, step]);
  const total = filtered.reduce((s, e) => s + valueOf(e, me, viewMode), 0);
  // Over every step the period covers, not just the busy ones.
  const average = trend.length > 0 ? total / trend.length : 0;
  const beforeTotal = before?.expenses.reduce((s, e) => s + valueOf(e, me, viewMode), 0);
  const beforeSteps = before ? getTrend(before.expenses, me, viewMode, before.range, step).length : 0;
  const beforeAverage = before && beforeSteps > 0 ? beforeTotal! / beforeSteps : undefined;

  const categoryData = useMemo(
    () => getCategoryBreakdown(filtered, me, viewMode, groups),
    [filtered, me, viewMode, groups],
  );
  const categoriesBefore = useMemo(
    () =>
      before
        ? new Map(getCategoryBreakdown(before.expenses, me, viewMode, groups).map((c) => [c.category, c.amount]))
        : undefined,
    [before, me, viewMode, groups],
  );
  const largest = useMemo(() => getLargestExpenses(filtered), [filtered]);
  const sharedWith = useMemo(() => getSharedWith(filtered, me), [filtered, me]);
  const groupContributions = useMemo(
    () => getGroupContributions(filtered, group ? [group] : groups, users, me),
    [filtered, group, groups, users, me],
  );

  const userById = (id: string) => users.find((u) => u.id === id);
  const groupName = (id?: string) => groups.find((g) => g.id === id)?.name ?? '';
  const isTrip = !!group && period === 0 && step === 'day';
  const topCategory = categoryData[0];
  const who = viewMode === 'personal' ? 'Your share' : 'Group total';
  const periodWords = period === 0 ? (group ? 'the whole group' : 'all time') : `last ${period === 1 ? 'month' : `${period} months`}`;

  /** What a step's readout says: the groups it was mostly in, or a trip's expenses. */
  const detail = (p: TrendPoint) => {
    const n = p.expenses.length;
    if (group) {
      const names = [...p.expenses].sort((a, b) => b.amount - a.amount).slice(0, 3).map((e) => e.description);
      return `${names.join(', ')}${n > 3 ? ` +${n - 3} more` : ''}`;
    }
    const byGroup = new Map<string, number>();
    for (const e of p.expenses) byGroup.set(e.groupId ?? '', (byGroup.get(e.groupId ?? '') ?? 0) + Math.abs(valueOf(e, me, viewMode)));
    const topGroup = [...byGroup.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return `${n} ${n === 1 ? 'expense' : 'expenses'}${topGroup ? ` · mostly ${groupName(topGroup)}` : ''}`;
  };

  const totalMoved = change(total, beforeTotal);
  const averageMoved =
    beforeAverage === undefined || Math.abs(average - beforeAverage) < 0.5
      ? beforeAverage === undefined ? null : 'about the same'
      : `${average > beforeAverage ? '▲' : '▼'} ${money(Math.abs(average - beforeAverage), currency).replace(/\.\d\d$/, '')} a ${STEP_WORD[step]}`;

  return (
    <div className="page-content">
      <div className="insights-page">
        <header className="ins-header">
          <div>
            <h1 className="page-hero-title">Insights</h1>
            <p className="text-secondary ins-sub">
              {group ? group.name : 'All groups'} · {periodWords} · {who.toLowerCase()}
            </p>
          </div>
          <div className="ins-controls">
            <label className="ins-group-pick">
              <span className="sr-only">Group</span>
              <select className="field-input" value={group?.id ?? ''} onChange={(e) => chooseGroup(e.target.value)}>
                <option value="">All groups</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>
            <div className="seg" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <button key={p.value} aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
            {!group && currencies.length > 1 && (
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
            <span className="cap">{who}</span>
            <span className="num ins-figure">{money(total, currency)}</span>
            {totalMoved && (
              <span className="text-xs text-secondary">
                {totalMoved === 'same' ? 'Same as' : totalMoved === 'new' ? 'Nothing in' : `${totalMoved} vs`} the {period === 1 ? 'month' : `${period} months`} before
              </span>
            )}
          </div>
          <div>
            <span className="cap">Avg / {STEP_WORD[step]}</span>
            <span className="num ins-figure">{money(average, currency)}</span>
            {averageMoved && <span className="text-xs text-secondary">{averageMoved}</span>}
          </div>
          <div>
            <span className="cap">{isTrip ? 'Days' : 'Expenses'}</span>
            <span className="num ins-figure">{isTrip ? trend.length : filtered.length}</span>
            {!isTrip && topCategory && <span className="text-xs text-secondary">Most on {topCategory.label}</span>}
          </div>
        </section>

        <section className="ins-chart">
          <div className="ins-chart-head">
            <h2 className="ins-h2">{who} by {STEP_WORD[step]}</h2>
            <span className="text-xs text-secondary">
              Dashed: average {money(average, currency).replace(/\.\d\d$/, '')}
              {trend.some((p) => p.partial) ? ` · Striped: this ${STEP_WORD[step]} so far` : ''}
            </span>
          </div>
          <TrendChart points={trend} step={step} currency={currency} average={average} dayNumbers={isTrip} detail={detail} />
          {step === 'day' && trend.length > 0 && (
            <p className="text-xs text-secondary ins-chart-foot">
              {trend[0].start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              {trend[trend.length - 1].start.getMonth() !== trend[0].start.getMonth() &&
                ` – ${trend[trend.length - 1].start.toLocaleDateString('en-US', { month: 'long' })}`}{' '}
              · tap a {STEP_WORD[step]} for its expenses
            </p>
          )}
        </section>

        <div className="ins-charts">
          <section className="ins-chart">
            <div className="ins-chart-head">
              <h2 className="ins-h2">By category</h2>
              {categoriesBefore && <span className="text-xs text-secondary">Right: change on the period before</span>}
            </div>
            <CategoryBars data={categoryData} currency={currency} before={categoriesBefore} />
          </section>

          {sharedWith.length > 0 && (
            <section className="ins-chart">
              <div className="ins-chart-head">
                <h2 className="ins-h2">Who you share with</h2>
                <span className="text-xs text-secondary">Your share of expenses with each</span>
              </div>
              <div className="ruled" role="list">
                {sharedWith.map((r) => {
                  const u = userById(r.userId);
                  return (
                    <div key={r.userId} className="ins-who-row" role="listitem">
                      {u && <Avatar user={u} size="sm" />}
                      <span className="ins-cat-label">{u?.name.split(' ')[0] ?? 'Someone'}</span>
                      <span className="ins-cat-track" aria-hidden>
                        <span className="ins-cat-bar" style={{ width: `${(r.amount / sharedWith[0].amount) * 100}%` }} />
                      </span>
                      <span className="num ins-cat-amount">{money(r.amount, currency)}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-secondary ins-chart-foot">
                An expense with two people counts for both, so these add up to more than your share.
              </p>
            </section>
          )}
        </div>

        {largest.length > 0 && (
          <section>
            <h2 className="ins-h2">Largest expenses</h2>
            <div className="ins-big" role="table" aria-label="Largest expenses">
              <div className="ins-big-row ins-big-head" role="row">
                <span role="columnheader" className="cap">Date</span>
                <span role="columnheader" className="cap">Description</span>
                <span role="columnheader" className="cap ins-big-wide">Group</span>
                <span role="columnheader" className="cap ins-right ins-big-wide">Amount</span>
                <span role="columnheader" className="cap ins-right">Your share</span>
              </div>
              {largest.map((e) => (
                <Link
                  key={e.id}
                  to={e.groupId ? `/groups/${e.groupId}/expenses/${e.id}` : '/groups'}
                  className="ins-big-row"
                  role="row"
                >
                  <span role="cell" className="num ins-big-date">{shortDate(e.date).toUpperCase()}</span>
                  <span role="cell" className="ins-big-desc">
                    <span className="ins-big-name">{e.description}</span>
                    <span className="text-xs text-secondary ins-big-narrow">
                      {money(e.amount, currency)} total{group ? '' : ` · ${groupName(e.groupId)}`}
                    </span>
                  </span>
                  <span role="cell" className="text-secondary ins-big-wide">{groupName(e.groupId)}</span>
                  <span role="cell" className="num ins-right ins-big-wide">{money(e.amount, currency)}</span>
                  <span role="cell" className="num ins-right">{money(valueOf(e, me, 'personal'), currency)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

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
              {groupContributions.map((g) => (
                <GroupContributionBlock key={g.groupId} group={g} currency={currency} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
