import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { SendPanel } from './ShareGroup';
import { ReceivePanel } from './ReceiveGroup';
import { CloseIcon } from './sharingParts';
import './Sharing.css';

/**
 * Swapping a group with someone, by its moving code or a file.
 *
 * From a group (?group=): Send it, or Get their changes to it, as two tabs.
 * Without one (Groups → Add group → Get one from a friend): just the camera,
 * to receive a group this device doesn't have yet. The tab is in the
 * address, so Back works.
 */
export default function ShareHub() {
  const [params, setParams] = useSearchParams();
  const groupId = params.get('group');
  const group = useStore((s) => (groupId ? s.groups.find((g) => g.id === groupId) : undefined));
  const [reviewing, setReviewing] = useState(false);
  const onReviewChange = useCallback((r: boolean) => setReviewing(r), []);

  const tab = !group || params.get('tab') === 'receive' ? 'receive' : 'send';
  const setTab = (t: 'send' | 'receive') =>
    setParams(
      (p) => {
        if (t === 'receive') p.set('tab', 'receive');
        else p.delete('tab');
        return p;
      },
      { replace: true },
    );

  // Close goes back where this was opened from.
  const closeTo = group ? `/groups/${group.id}` : '/groups';
  const title = group ? `Share ${group.name}` : 'Get a group from a friend';
  const scanning = tab === 'receive' && !reviewing;

  return (
    <div className={`page-content sharing-scroll ${scanning ? 'receive-scan' : ''}`}>
      <div className="sharing-page">
        {!reviewing && (
          <>
            {/* Phones: a title bar with close. Desktop: breadcrumb and Done. */}
            <div className="sharing-topbar">
              <span className="sharing-topbar-title">{title}</span>
              <Link to={closeTo} className="sharing-close" aria-label="Close">
                <CloseIcon />
              </Link>
            </div>
            <header className="sharing-header">
              <span className="sharing-crumb">
                <Link to="/groups">Groups</Link> /{group && <> <Link to={`/groups/${group.id}`}>{group.name}</Link> /</>}
              </span>
              <h1 className="sharing-title">{title}</h1>
              <Link to={closeTo} className="btn btn-secondary sharing-done">Done</Link>
            </header>

            {group && (
              <div className="hub-tabs" role="tablist" aria-label="Send or get changes">
                <button role="tab" aria-selected={tab === 'send'} className={tab === 'send' ? 'active' : ''} onClick={() => setTab('send')}>
                  Send
                </button>
                <button role="tab" aria-selected={tab === 'receive'} className={tab === 'receive' ? 'active' : ''} onClick={() => setTab('receive')}>
                  Get their changes
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'receive' || !group ? (
          <ReceivePanel closeTo={closeTo} onReviewChange={onReviewChange} />
        ) : (
          <SendPanel key={group.id} groupId={group.id} />
        )}
      </div>
    </div>
  );
}
