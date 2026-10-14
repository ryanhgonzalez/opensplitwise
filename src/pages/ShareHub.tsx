import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore, selectCurrentUser } from '../store';
import GroupTile from '../components/GroupTile';
import { SendPanel } from './ShareGroup';
import { ReceivePanel } from './ReceiveGroup';
import { CloseIcon } from './sharingParts';
import './Sharing.css';

type Tab = 'send' | 'receive';

/**
 * Share & receive: one place to swap a group with someone, by its moving
 * code or a file. Send picks a group (or comes from one, with ?group=);
 * Receive opens the camera. Both live in the address, so Back works.
 */
export default function ShareHub() {
  const [params, setParams] = useSearchParams();
  const currentUser = useStore(selectCurrentUser)!;
  const groups = useStore((s) => s.groups);
  const myGroups = groups.filter((g) => g.members.some((m) => m.userId === currentUser.id));

  const tab: Tab = params.get('tab') === 'receive' ? 'receive' : 'send';
  const chosen = params.get('group');
  const group = chosen ? groups.find((g) => g.id === chosen) : undefined;
  // With just one group there's nothing to pick.
  const sendGroup = group ?? (myGroups.length === 1 ? myGroups[0] : undefined);
  const [reviewing, setReviewing] = useState(false);
  const onReviewChange = useCallback((r: boolean) => setReviewing(r), []);

  // A group that's gone (deleted, or a stale link): back to choosing.
  useEffect(() => {
    if (chosen && !group) setParams((p) => { p.delete('group'); return p; }, { replace: true });
  }, [chosen, group, setParams]);

  const set = (changes: Record<string, string | null>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) p.delete(k);
          else p.set(k, v);
        }
        return p;
      },
      { replace: true },
    );

  // Close goes back where this was opened from: the group, or Groups.
  const closeTo = group ? `/groups/${group.id}` : '/groups';
  const scanning = tab === 'receive' && !reviewing;

  return (
    <div className={`page-content sharing-scroll ${scanning ? 'receive-scan' : ''}`}>
      <div className="sharing-page">
        {!reviewing && (
          <>
            {/* Phones: a title bar with close. Desktop: breadcrumb and Done. */}
            <div className="sharing-topbar">
              <span className="sharing-topbar-title">Share &amp; receive</span>
              <Link to={closeTo} className="sharing-close" aria-label="Close">
                <CloseIcon />
              </Link>
            </div>
            <header className="sharing-header">
              <span className="sharing-crumb">
                <Link to="/groups">Groups</Link> /{group && <> <Link to={`/groups/${group.id}`}>{group.name}</Link> /</>}
              </span>
              <h1 className="sharing-title">Share &amp; receive</h1>
              <Link to={closeTo} className="btn btn-secondary sharing-done">Done</Link>
            </header>

            <div className="hub-tabs" role="tablist" aria-label="Share or receive">
              <button role="tab" aria-selected={tab === 'send'} className={tab === 'send' ? 'active' : ''} onClick={() => set({ tab: null })}>
                Send a group
              </button>
              <button role="tab" aria-selected={tab === 'receive'} className={tab === 'receive' ? 'active' : ''} onClick={() => set({ tab: 'receive' })}>
                Receive
              </button>
            </div>
          </>
        )}

        {tab === 'receive' ? (
          <ReceivePanel closeTo={closeTo} onReviewChange={onReviewChange} />
        ) : sendGroup ? (
          <SendPanel
            key={sendGroup.id}
            groupId={sendGroup.id}
            onChangeGroup={myGroups.length > 1 ? () => set({ group: null }) : undefined}
          />
        ) : (
          <section className="hub-pick" aria-labelledby="hub-pick-title">
            <h2 id="hub-pick-title" className="hub-pick-title">Which group?</h2>
            {myGroups.length === 0 ? (
              <p className="text-secondary">
                You don't have any groups yet. Create one, or get one from a friend with <strong>Receive</strong>.
              </p>
            ) : (
              <div className="ruled">
                {myGroups.map((g) => (
                  <button key={g.id} className="hub-group" onClick={() => set({ group: g.id })}>
                    <GroupTile group={g} size={36} />
                    <span className="hub-group-info">
                      <span className="hub-group-name">{g.name}</span>
                      <span className="text-xs text-secondary">
                        {g.members.length} {g.members.length === 1 ? 'person' : 'people'}
                      </span>
                    </span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className="hub-chevron">
                      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
