import { NavLink } from 'react-router-dom';
import { NAV_ITEMS, NavIcon } from './navItems';
import { useAddExpense } from './useAddExpense';
import './BottomNav.css';

export default function BottomNav() {
  const { openAddExpense, addExpenseSheet } = useAddExpense();

  const tab = (item: (typeof NAV_ITEMS)[number]) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) => `bottom-nav-tab ${isActive ? 'active' : ''}`}
    >
      <NavIcon path={item.path} />
      <span className="bottom-nav-label">{item.label}</span>
    </NavLink>
  );

  return (
    <>
      <nav className="bottom-nav" aria-label="Main">
        {NAV_ITEMS.slice(0, 2).map(tab)}
        <span className="bottom-nav-add-slot">
          <button type="button" className="bottom-nav-add" aria-label="Add expense" onClick={openAddExpense}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </span>
        {NAV_ITEMS.slice(2).map(tab)}
      </nav>
      {addExpenseSheet}
    </>
  );
}
