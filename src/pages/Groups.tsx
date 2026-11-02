import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import GroupTile from '../components/GroupTile';
import CreateGroupSheet from '../components/CreateGroupSheet';
import SearchField from '../components/SearchField';
import { useStore, selectGroupTotals } from '../store';
import { formatCurrency, formatDate, formatLedgerDate, formatSigned } from '../utils';
import { groupCurrency } from '../lib/currency';
import { groupTypeLabel } from '../lib/groupTypes';
import type { Group } from '../types';
import '../styles/sheet.css';
import './Groups.css';

export default function Groups() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // "Add group" asks first: make a new one, or get one a friend already has.
  const [showAdd, setShowAdd] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Two-person ledgers live on that person's page, not here.
  const groups = useStore((s) => s.groups).filter((g) => !g.direct);
  const users = useStore((s) => s.users);
  const currentUserId = useStore((s) => s.currentUserId);
  const groupTotals = useStore(selectGroupTotals);

  const nameOf = (id: string) => (id === currentUserId ? 'You' : users.find((u) => u.id === id)?.name ?? 'Unknown');
  const totalsOf = (groupId: string) => groupTotals[groupId] ?? { yourBalance: 0, totalSpent: 0 };

  const filtered = groups.filter((g) =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const active = filtered.filter((g) => !g.archivedAt);
  // Most recently archived first.
  const archived = filtered
    .filter((g) => g.archivedAt)
    .sort((a, b) => b.archivedAt!.getTime() - a.archivedAt!.getTime());
  const allArchived = groups.filter((g) => g.archivedAt).length;
  // A search looks in the archive too.
  const archiveOpen = showArchived || (!!searchQuery && archived.length > 0);

  const memberSummary = (ids: string[]) => {
    const names = ids.map(nameOf);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  };

  const table = (label: string, heading: ReactNode, list: Group[]) => (
    <div className="groups-table" role="table" aria-label={label}>
      <div className="groups-row groups-head" role="row">
        <span role="columnheader" className="cap">{heading}</span>
        <span role="columnheader" className="cap groups-col-wide">Members</span>
        <span role="columnheader" className="cap groups-col-wide">Last active</span>
        <span role="columnheader" className="cap groups-col-wide groups-right">Total spent</span>
        <span role="columnheader" className="cap groups-right">Your balance</span>
      </div>
      {list.map((group) => {
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
                <span className="text-xs text-secondary groups-type">{groupTypeLabel(group.type)}</span>
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
  );

  return (
    <div className="page-content">
      <div className="groups-page">
        <header className="groups-header">
          <h1 className="page-hero-title">Groups</h1>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add group
          </button>
        </header>

        <SearchField value={searchQuery} onChange={setSearchQuery} placeholder="Search groups..." label="Search groups" />

        {groups.length === 0 ? (
          <div className="empty-box">
            <span className="empty-box-title">No groups yet</span>
            <span className="text-secondary">Groups are where you track expenses with the same set of people.</span>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add group</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-box">
            <span className="empty-box-title">No groups found</span>
            <span className="text-secondary">Nothing matches “{searchQuery}”.</span>
          </div>
        ) : (
          <>
            {active.length > 0 ? (
              table(
                'Groups',
                `Groups · ${searchQuery ? `${active.length} of ${groups.length - allArchived}` : active.length}`,
                active,
              )
            ) : (
              !searchQuery && (
                <div className="empty-box">
                  <span className="empty-box-title">All your groups are archived</span>
                  <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add group</button>
                </div>
              )
            )}

            {(searchQuery ? archived.length > 0 : allArchived > 0) && (
              <section className="groups-archive" aria-label="Archived groups">
                <button
                  className="groups-archive-toggle"
                  onClick={() => setShowArchived((v) => !v)}
                  aria-expanded={archiveOpen}
                >
                  <span>Archived · {searchQuery ? archived.length : allArchived}</span>
                  <svg className={archiveOpen ? 'open' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {archiveOpen && (
                  <>
                    <p className="text-xs text-secondary groups-archive-note">
                      Hidden from your groups. Balances in them still count. Open one to unarchive it.
                    </p>
                    {table('Archived groups', `${archived.length} ${archived.length === 1 ? 'group' : 'groups'}`, archived)}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <AnimatePresence>
        {showAdd && (
          <motion.div
            className="sheet-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowAdd(false)}
          >
            <motion.div
              className="sheet-panel groups-add-panel"
              role="dialog"
              aria-label="Add a group"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 340 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sheet-handle" />
              <div className="sheet-header">
                <span className="sheet-title">Add a group</span>
                <button className="sheet-close" onClick={() => setShowAdd(false)} aria-label="Close">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="sheet-body groups-add-options">
                <button
                  className="groups-add-option"
                  onClick={() => {
                    setShowAdd(false);
                    setShowCreate(true);
                  }}
                >
                  <span className="groups-add-title">Create a new group</span>
                  <span className="groups-add-sub">Name it and choose who's in it.</span>
                </button>
                <button className="groups-add-option" onClick={() => navigate('/scan', { state: { from: '/groups' } })}>
                  <span className="groups-add-title">Get one from a friend</span>
                  <span className="groups-add-sub">Scan the code on their phone, or open a file they sent.</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
