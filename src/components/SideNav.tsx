import { NavLink } from 'react-router-dom';
import { useStore, selectCurrentUser } from '../store';
import Avatar from './Avatar';
import { NAV_ITEMS, NavIcon } from './navItems';
import { useAddExpense } from './useAddExpense';
import './SideNav.css';

export default function SideNav() {
  const currentUser = useStore(selectCurrentUser)!;
  const { openAddExpense, addExpenseSheet } = useAddExpense();

  return (
    <>
      <aside className="side-nav">
        <span className="side-nav-wordmark">OpenSplitwise</span>

        <button className="btn btn-primary side-nav-add-btn" onClick={openAddExpense}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Add expense
        </button>

        <nav className="side-nav-items" aria-label="Main">
          {NAV_ITEMS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) => `side-nav-item ${isActive ? 'active' : ''}`}
            >
              <NavIcon path={tab.path} size={18} />
              <span>{tab.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="side-nav-spacer" />

        <NavLink to="/settings" className={({ isActive }) => `side-nav-user ${isActive ? 'active' : ''}`}>
          <Avatar user={currentUser} size="sm" />
          <span className="side-nav-user-info">
            <span className="side-nav-user-name">{currentUser.name}</span>
            <span className="side-nav-user-sub">Settings</span>
          </span>
        </NavLink>
      </aside>

      {addExpenseSheet}
    </>
  );
}
