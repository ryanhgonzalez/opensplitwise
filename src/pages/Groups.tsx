import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import GroupTile from '../components/GroupTile';
import CreateGroupSheet from '../components/CreateGroupSheet';
import { useStore, selectGroupTotals } from '../store';
import { formatCurrency, formatDate, formatLedgerDate, formatSigned } from '../utils';
import { groupCurrency } from '../lib/currency';
import type { GroupType } from '../types';
import ReceiveGroupSheet from '../components/ReceiveGroupSheet';
import './Groups.css';

const TYPE_LABELS: Record<GroupType, string> = {
  trip: 'Trip',
  home: 'Home',
  couple: 'Couple',
  family: 'Family',
  friends: 'Friends',
  work: 'Work',
  event: 'Event',
  other: 'Other',
};

export default function Groups() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const groups = useStore((s) => s.groups);
  const users = useStore((s) => s.users);
  const currentUserId = useStore((s) => s.currentUserId);
  const groupTotals = useStore(selectGroupTotals);

  const nameOf = (id: string) => (id === currentUserId ? 'You' : users.find((u) => u.id === id)?.name ?? 'Unknown');
  const totalsOf = (groupId: string) => groupTotals[groupId] ?? { yourBalance: 0, totalSpent: 0 };

  const filtered = groups.filter((g) =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Net across every group, per currency: positive means you are owed overall.
  const netByCurrency = new Map<string, number>();
  for (const g of groups) {
    const c = groupCurrency(g);
    netByCurrency.set(c, (netByCurrency.get(c) ?? 0) + totalsOf(g.id).yourBalance);
  }
  const nets = [...netByCurrency.entries()].filter(([, n]) => Math.abs(n) >= 0.005);
  const netEven = nets.length === 0;

  const memberSummary = (ids: string[]) => {
    const names = ids.map(nameOf);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  };

  return (
    <div className="page-content">
      <div className="groups-page">
        <header className="groups-header">
          <h1 className="page-hero-title">Groups</h1>
          <span className="groups-header-actions">
            <button className="btn btn-secondary" onClick={() => setShowReceive(true)}>
              Receive
            </button>
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              New group
            </button>
          </span>
        </header>

        <section className="statement" aria-label="Summary">
          <div>
            <span className="cap">Groups</span>
            <span className="num groups-figure">{groups.length}</span>
          </div>
          <div>
            <span className="cap">Net balance</span>
            {netEven ? (
              <span className="num groups-figure groups-net zero">Settled</span>
            ) : (
              nets.map(([currency, net]) => (
                <span key={currency} className={`num groups-figure groups-net ${net > 0 ? 'pos' : 'neg'}`}>
                  {formatSigned(net, currency)}
                </span>
              ))
            )}
          </div>
        </section>

        <label className="groups-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span className="sr-only">Search groups</span>
          <input
            type="search"
            placeholder="Search groups..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')} className="groups-search-clear" aria-label="Clear search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </label>

        {groups.length === 0 ? (
          <div className="empty-box">
            <span className="empty-box-title">No groups yet</span>
            <span className="text-secondary">Groups are where you track expenses with the same set of people.</span>
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>New group</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-box">
            <span className="empty-box-title">No groups found</span>
            <span className="text-secondary">Nothing matches “{searchQuery}”.</span>
          </div>
        ) : (
          <div className="groups-table" role="table" aria-label="Groups">
            <div className="groups-row groups-head" role="row">
              <span role="columnheader" className="cap">Group</span>
              <span role="columnheader" className="cap groups-col-wide">Members</span>
              <span role="columnheader" className="cap groups-col-wide">Last active</span>
              <span role="columnheader" className="cap groups-col-wide groups-right">Total spent</span>
              <span role="columnheader" className="cap groups-right">Your balance</span>
            </div>
            {filtered.map((group) => {
              const { yourBalance, totalSpent } = totalsOf(group.id);
              const even = Math.abs(yourBalance) < 0.005;
              return (
                <button
                  key={group.id}
                  role="row"
                  className="groups-row groups-item"
                  onClick={() => navigate(`/groups/${group.id}`)}
                >
                  <span role="cell" className="groups-name-cell">
                    <GroupTile group={group} size={40} />
                    <span className="groups-name-text">
                      <span className="groups-name">{group.name}</span>
                      <span className="text-xs text-secondary groups-type">{TYPE_LABELS[group.type] ?? 'Other'}</span>
                      <span className="text-xs text-secondary groups-meta-mobile">
                        {group.members.length} members · active {formatDate(group.lastActivity)}
                      </span>
                    </span>
                  </span>
                  <span role="cell" className="groups-col-wide groups-members">
                    {memberSummary(group.members.map((m) => m.userId))}
                  </span>
                  <span role="cell" className="num groups-col-wide groups-date">
                    {formatLedgerDate(group.lastActivity)}
                  </span>
                  <span role="cell" className="num groups-col-wide groups-right">
                    {formatCurrency(totalSpent, groupCurrency(group))}
                  </span>
                  <span role="cell" className={`groups-right groups-bal ${even ? 'zero' : `num ${yourBalance > 0 ? 'pos' : 'neg'}`}`}>
                    {even ? 'Settled' : formatSigned(yourBalance, groupCurrency(group))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <ReceiveGroupSheet open={showReceive} onClose={() => setShowReceive(false)} />

      <AnimatePresence>
        {showCreate && (
          <CreateGroupSheet
            open={showCreate}
            onClose={() => setShowCreate(false)}
            onCreated={(groupId) => {
              setShowCreate(false);
              navigate(`/groups/${groupId}`);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
