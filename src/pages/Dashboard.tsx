import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import AddExpenseSheet from '../components/AddExpenseSheet';
import AccountMenuSheet from '../components/AccountMenuSheet';
import BackupReminder from '../components/BackupReminder';
import { useStore, selectCurrentUser, selectMainCurrency, selectOverallBalances, selectRecentExpenses, selectGroupTotals } from '../store';
import { expenseAmountLabel, groupCurrency, recordCurrency } from '../lib/currency';
import { formatCurrency, formatDate, formatLedgerDate, formatSigned, getNetAmountForUser } from '../utils';
import './Dashboard.css';

type BalanceTab = 'owe' | 'owed';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<BalanceTab>('owed');
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const navigate = useNavigate();

  const currentUser = useStore(selectCurrentUser)!;
  const balances = useStore(selectOverallBalances);
  const mainCurrency = useStore(selectMainCurrency);
  const recentExpenses = useStore(selectRecentExpenses(5));
  const groups = useStore((s) => s.groups);
  const users = useStore((s) => s.users);
  const groupTotals = useStore(selectGroupTotals);

  const getUserById = (id: string) => users.find((u) => u.id === id);
  const getGroupById = (id?: string) => (id ? groups.find((g) => g.id === id) : undefined);
  const balanceOf = (groupId: string) => groupTotals[groupId]?.yourBalance ?? 0;
  // One entry per currency with a balance. With none, show zero in the main currency.
  const shown = balances.length ? balances : [{ currency: mainCurrency, net: 0, totalOwed: 0, totalOwe: 0, owedByFriend: [], oweToFriend: [] }];
  const multiCurrency = shown.length > 1;
  const settled = balances.length === 0;
  const isPositive = shown[0].net > 0;
  const activeGroups = groups.filter((g) => Math.abs(balanceOf(g.id)) >= 0.005).length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  // A friend can owe in more than one currency; each is its own row.
  const rows = shown.flatMap((b) =>
    (activeTab === 'owed' ? b.owedByFriend : b.oweToFriend).map((r) => ({ ...r, currency: b.currency })),
  );
  const owedCount = new Set(shown.flatMap((b) => b.owedByFriend.map((r) => r.userId))).size;
  const oweCount = new Set(shown.flatMap((b) => b.oweToFriend.map((r) => r.userId))).size;

  return (
    <div className="page-content">
      <div className="dash">
        {/* Header */}
        <header className="dash-header">
          <div>
            <p className="text-secondary text-sm">{greeting}</p>
            <h1 className="dash-name">{currentUser.name}</h1>
          </div>
          <button
            className="dash-account-btn"
            aria-label="Account menu"
            onClick={() => setShowAccountMenu(true)}
          >
            <Avatar user={currentUser} size="lg" />
          </button>
          <button className="btn btn-primary dash-add-btn" onClick={() => setShowAddExpense(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add expense
          </button>
        </header>

        {/* Overall balance */}
        <section className="statement dash-statement" aria-label="Overall balance">
          <div>
            <span className="cap">
              {settled ? 'All settled up' : multiCurrency ? 'Overall balance' : isPositive ? 'Overall, you are owed' : 'Overall, you owe'}
            </span>
            {shown.map((b) => (
              <span
                key={b.currency}
                className={`num dash-net ${multiCurrency ? 'dash-net-multi' : ''} ${Math.abs(b.net) < 0.005 ? 'zero' : b.net > 0 ? 'pos' : 'neg'}`}
              >
                {formatSigned(b.net, b.currency)}
              </span>
            ))}
            {activeGroups > 0 && (
              <span className="text-xs text-secondary">
                across {activeGroups} {activeGroups === 1 ? 'group' : 'groups'}
              </span>
            )}
          </div>
          <div className="dash-statement-part">
            <span className="cap">Owed to you</span>
            {shown.map((b) => (
              <span key={b.currency} className="num pos dash-part-amount">{formatCurrency(b.totalOwed, b.currency)}</span>
            ))}
          </div>
          <div className="dash-statement-part">
            <span className="cap">You owe</span>
            {shown.map((b) => (
              <span key={b.currency} className="num neg dash-part-amount">{formatCurrency(b.totalOwe, b.currency)}</span>
            ))}
          </div>
        </section>

        <BackupReminder />

        <div className="dash-columns">
          <div className="dash-main">
            {/* Who owes whom */}
            <section>
              <div className="dash-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={activeTab === 'owed'}
                  className={`dash-tab ${activeTab === 'owed' ? 'active' : ''}`}
                  onClick={() => setActiveTab('owed')}
                >
                  Owed to you · {owedCount}
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === 'owe'}
                  className={`dash-tab ${activeTab === 'owe' ? 'active' : ''}`}
                  onClick={() => setActiveTab('owe')}
                >
                  You owe · {oweCount}
                </button>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  role="tabpanel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {rows.length === 0 ? (
                    <p className="dash-empty text-secondary">
                      {activeTab === 'owed' ? 'Nobody owes you right now.' : 'You don’t owe anyone right now.'}
                    </p>
                  ) : (
                    rows.map((b) => {
                      const friend = getUserById(b.userId);
                      if (!friend) return null;
                      return (
                        <div key={`${b.userId}-${b.currency}`} className="dash-person">
                          <Avatar user={friend} size="md" />
                          <div className="dash-person-info">
                            <span className="dash-person-name">{friend.name}</span>
                            <span className="text-xs text-secondary">
                              {activeTab === 'owed' ? 'owes you' : 'you owe'}
                            </span>
                          </div>
                          <span className={`num ${activeTab === 'owed' ? 'pos' : 'neg'} dash-person-amount`}>
                            {formatCurrency(b.amount, b.currency)}
                          </span>
                        </div>
                      );
                    })
                  )}
                </motion.div>
              </AnimatePresence>
            </section>

            {/* Recent expenses */}
            <section className="dash-recent">
              <div className="dash-section-head">
                <h2>Recent expenses</h2>
                <Link to="/activity" className="dash-link">All activity</Link>
              </div>
              <div className="ruled">
                {recentExpenses.map((expense) => {
                  const paidByUser = getUserById(expense.paidBy);
                  const isPaidByMe = expense.paidBy === currentUser.id;
                  const net = getNetAmountForUser(expense, currentUser.id);
                  const group = getGroupById(expense.groupId);
                  return (
                    <div key={expense.id} className="dash-expense">
                      <span className="num dash-expense-date" title={formatDate(expense.date)}>
                        {formatLedgerDate(expense.date)}
                      </span>
                      <span className="dash-expense-info">
                        <span className="dash-expense-desc">{expense.description}</span>
                        <span className="text-xs text-secondary">
                          {isPaidByMe ? 'You' : paidByUser?.name} paid {expenseAmountLabel(expense)}
                        </span>
                      </span>
                      <span className="dash-expense-group">{group?.name ?? ''}</span>
                      <span className={`num dash-expense-share ${net > 0.005 ? 'pos' : net < -0.005 ? 'neg' : 'zero'}`}>
                        {formatSigned(net, recordCurrency(expense))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Groups */}
          <aside className="dash-groups">
            <div className="dash-section-head">
              <h2>Groups</h2>
              <Link to="/groups" className="dash-link">All groups</Link>
            </div>
            <div className="dash-group-list">
              {groups.map((group) => {
                const bal = balanceOf(group.id);
                const even = Math.abs(bal) < 0.005;
                return (
                  <button
                    key={group.id}
                    className="dash-group"
                    onClick={() => navigate(`/groups/${group.id}`)}
                  >
                    <GroupTile group={group} size={36} />
                    <span className="dash-group-info">
                      <span className="dash-group-name">{group.name}</span>
                      <span className="dash-group-meta text-xs text-secondary">
                        {group.members.length} members · active {formatDate(group.lastActivity)}
                      </span>
                    </span>
                    <span className={`${even ? '' : 'num'} dash-group-bal ${even ? 'zero' : bal > 0 ? 'pos' : 'neg'}`}>
                      {even ? 'settled' : formatSigned(bal, groupCurrency(group))}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      </div>

      {/* FAB (mobile) */}
      <button
        className="glass-fab fab-fixed"
        aria-label="Add expense"
        onClick={() => setShowAddExpense(true)}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      <AnimatePresence>
        {showAddExpense && (
          <AddExpenseSheet
            open={showAddExpense}
            onClose={() => setShowAddExpense(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAccountMenu && (
          <AccountMenuSheet
            open={showAccountMenu}
            onClose={() => setShowAccountMenu(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
