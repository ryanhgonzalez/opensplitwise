import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './store';
import BottomNav from './components/BottomNav';
import SideNav from './components/SideNav';
import Dashboard from './pages/Dashboard';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import Activity from './pages/Activity';
import SettleUp from './pages/SettleUp';
import Insights from './pages/Insights';
import People from './pages/People';
import Onboarding from './pages/Onboarding';
import IdentityPicker from './components/IdentityPicker';
import InstallGuide from './components/InstallGuide';
import ToastHost from './components/ToastHost';
import { requestPersistentStorage } from './lib/dataSafety';
import { removeOrphanPhotos } from './lib/receiptPhotos';

const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        variants={pageVariants}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <Routes location={location}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/groups/:id" element={<GroupDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settle" element={<SettleUp />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/people" element={<People />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

export default function App() {
  const hasOnboarded = useStore((s) => s.hasOnboarded);
  const needsIdentity = useStore((s) => s.needsIdentity);
  const theme = useStore((s) => s.theme);
  const hasExpenses = useStore((s) => s.expenses.length > 0);
  const expenses = useStore((s) => s.expenses);

  // Once there's something worth keeping, ask the browser not to clear it.
  // Waiting until then matters in Firefox, which asks the person.
  useEffect(() => {
    if (hasExpenses) void requestPersistentStorage();
  }, [hasExpenses]);

  // Receipt photos whose expense is gone (deleted, merged away, restored over)
  // are cleared out after expenses settle, and once at startup. The wait
  // outlasts the Undo toast, so undoing a delete keeps the photo.
  useEffect(() => {
    const timer = setTimeout(() => {
      const keep = new Set(expenses.filter((e) => e.receipt).map((e) => e.id));
      removeOrphanPhotos(keep).catch(() => {});
    }, 20_000);
    return () => clearTimeout(timer);
  }, [expenses]);

  // Apply theme to <html data-theme="..."> and keep it in sync
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      if (theme === 'system') {
        root.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
      } else {
        root.setAttribute('data-theme', theme);
      }
    };

    apply();

    if (theme === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  // The install guide sits on top of whichever screen is showing.
  if (!hasOnboarded) {
    return (
      <>
        <Onboarding />
        <InstallGuide />
      </>
    );
  }

  // Data was imported from someone else's export — the person using the app has
  // to say who they are before anything is rendered from a stranger's viewpoint.
  if (needsIdentity) {
    return (
      <>
        <IdentityPicker variant="gate" />
        <InstallGuide />
      </>
    );
  }

  return (
    <BrowserRouter>
      {/* App shell */}
      <div className="app-shell">
        <SideNav />
        <div className="app-main">
          <AnimatedRoutes />
          <BottomNav />
        </div>
      </div>
      <InstallGuide />
      <ToastHost />
    </BrowserRouter>
  );
}
