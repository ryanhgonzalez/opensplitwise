import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useStore, selectCurrentUser, selectFriendBalancesByCurrency, selectOverallBalances } from '../store';
import Avatar from '../components/Avatar';
import PersonSheet from '../components/PersonSheet';
import ContactImportSheet from '../components/ContactImportSheet';
import AddPersonSheet from '../components/AddPersonSheet';
import { planImport, type Contact, type ImportRow } from '../lib/contacts';
import { formatCurrency, formatSigned } from '../utils';
import './People.css';

export default function People() {
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore(s => s.users);
  const groups = useStore(s => s.groups);
  const byCurrency = useStore(selectFriendBalancesByCurrency);
  const overall = useStore(selectOverallBalances);

  const navigate = useNavigate();
  // Only your own row opens the sheet; everyone else has a page.
  const [editingSelf, setEditingSelf] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState<ImportRow[] | null>(null);
  const [imported, setImported] = useState('');

  const others = users.filter(u => u.id !== currentUser.id);

  /** A person's unsettled balances, one per currency, largest first. */
  const balancesOf = (userId: string) =>
    Object.entries(byCurrency)
      .map(([currency, balances]) => ({ currency, amount: balances[userId] ?? 0 }))
      .filter((b) => Math.abs(b.amount) >= 0.005)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // Sort: unsettled balances first, then alphabetical
  const sorted = [...others].sort((a, b) => {
    const openA = balancesOf(a.id).length > 0;
    const openB = balancesOf(b.id).length > 0;
    if (openA !== openB) return openA ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const sharedGroupNames = (userId: string) =>
    groups
      .filter(
        g => g.members.some(m => m.userId === userId) &&
             g.members.some(m => m.userId === currentUser.id),
      )
      .map(g => g.name);

  const fromContacts = (contacts: Contact[]) => {
    setAdding(false);
    setImporting(planImport(contacts, users));
  };

  const finishImport = ({ added, updated }: { added: number; updated: number }) => {
    setImporting(null);
    setImported(
      [
        added && `Added ${added} ${added === 1 ? 'person' : 'people'}`,
        updated && `${added ? 'and' : 'Added'} ${updated === 1 ? 'a number for someone' : `numbers for ${updated} people`} already here`,
      ]
        .filter(Boolean)
        .join(', ') + '.',
    );
  };

  const meSettled = overall.length === 0;

  return (
    <div className="page-content">
      <div className="people-page">
        <header className="people-header">
          <span className="people-header-text">
            <h1 className="page-hero-title">People</h1>
            <p className="text-secondary">Friends &amp; contacts</p>
          </span>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add person
          </button>
        </header>

        {imported && (
          <p className="people-import-done" role="status">
            {imported}
          </p>
        )}

        {/* You */}
        <section>
          <h2 className="cap people-section-label">You</h2>
          <button className="people-row" onClick={() => setEditingSelf(true)}>
            <Avatar user={currentUser} size="md" />
            <span className="people-row-info">
              <span className="people-row-name">{currentUser.name}</span>
              <span className="text-xs text-secondary">{currentUser.email ?? 'Your profile'}</span>
            </span>
            <span className="people-row-balance">
              {meSettled ? (
                <span className="people-row-amount zero">Settled</span>
              ) : (
                overall.map((b) => (
                  <span key={b.currency} className={`num people-row-amount ${b.net > 0 ? 'pos' : 'neg'}`}>
                    {formatSigned(b.net, b.currency)}
                  </span>
                ))
              )}
            </span>
          </button>
        </section>

        {/* Everyone else */}
        {sorted.length > 0 ? (
          <section>
            <h2 className="cap people-section-label">People · {sorted.length}</h2>
            {sorted.map(user => {
              const balances = balancesOf(user.id);
              const settled = balances.length === 0;
              const shared = sharedGroupNames(user.id);
              return (
                <button key={user.id} className="people-row" onClick={() => navigate(`/people/${user.id}`)}>
                  <Avatar user={user} size="md" />
                  <span className="people-row-info">
                    <span className="people-row-name">{user.name}</span>
                    <span className="text-xs text-secondary people-row-groups">
                      {shared.length === 0 ? 'No shared groups' : shared.join(', ')}
                    </span>
                  </span>
                  <span className="people-row-balance">
                    {settled ? (
                      <span className="zero">Settled</span>
                    ) : (
                      balances.map((b) => (
                        <span key={b.currency} className="people-row-line">
                          <span className={`num people-row-amount ${b.amount > 0 ? 'pos' : 'neg'}`}>
                            {formatCurrency(Math.abs(b.amount), b.currency)}
                          </span>
                          <span className="text-xs text-secondary">{b.amount > 0 ? 'owes you' : 'you owe'}</span>
                        </span>
                      ))
                    )}
                  </span>
                </button>
              );
            })}
          </section>
        ) : (
          <div className="empty-box">
            <span className="empty-box-title">No people yet</span>
            <span className="text-secondary">Add friends and contacts so you can split expenses with them.</span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {editingSelf && (
          <PersonSheet open={editingSelf} onClose={() => setEditingSelf(false)} userId={currentUser.id} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {adding && (
          <AddPersonSheet
            onClose={() => setAdding(false)}
            onAdded={(name) => {
              setAdding(false);
              setImported(`Added ${name}.`);
            }}
            onContacts={fromContacts}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {importing && (
          <ContactImportSheet rows={importing} onClose={() => setImporting(null)} onDone={finishImport} />
        )}
      </AnimatePresence>
    </div>
  );
}
