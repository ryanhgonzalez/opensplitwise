import { useMemo, useState } from 'react';
import { dataSnapshot, useStore } from '../store';
import GroupTile from '../components/GroupTile';
import {
  NEW_PERSON,
  defaultChoice,
  matchPeople,
  mergeBundle,
  needsSelfChoice,
  type GroupBundle,
  type PeopleChoice,
} from '../lib/groupSync';
import { mergeNow, type Received } from '../lib/receive';
import { SwapFrame } from './swapParts';

const PERSON_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const RECEIPT_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/**
 * Before merging a group, when it needs the person here: saying which of its
 * people they are (the first time), checking someone the app can't place for
 * sure, or seeing expenses edited on both phones. Nothing changes until Merge.
 */
export default function MergeReview({
  bundle,
  parts,
  onMerged,
  onCancel,
}: {
  bundle: GroupBundle;
  /** How many code parts it came in; 0 for a file. */
  parts: number;
  onMerged: (r: Received) => void;
  onCancel: () => void;
}) {
  const users = useStore((s) => s.users);
  const groups = useStore((s) => s.groups);
  const currentUserId = useStore((s) => s.currentUserId);

  // The phone as it was when the code arrived.
  const state = useMemo(() => dataSnapshot(useStore.getState()), []);
  const matches = useMemo(() => matchPeople(state, bundle), [state, bundle]);
  const [choice, setChoice] = useState<PeopleChoice>(() => defaultChoice(matches));
  /** None of the group's people is the person here: add them to it on merge. */
  const [addMe, setAddMe] = useState(false);
  const [merging, setMerging] = useState(false);

  const askSelf = needsSelfChoice(state, matches);
  // Only people the app isn't sure about need a decision.
  const toCheck = matches.filter((m) => askSelf || m.reason === 'same-name' || m.reason === 'none');
  const matchedNames = matches
    .filter((m) => !toCheck.includes(m))
    .map((m) => (choice[m.incoming.id] === currentUserId ? 'you' : m.incoming.name));
  const selfIncoming = Object.entries(choice).find(([, local]) => local === currentUserId)?.[0];

  const chosenTwice = useMemo(() => {
    const seen = new Map<string, number>();
    for (const local of Object.values(choice)) if (local !== NEW_PERSON) seen.set(local, (seen.get(local) ?? 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => users.find((u) => u.id === id)?.name ?? id);
  }, [choice, users]);

  const summary = useMemo(
    () => mergeBundle(state, bundle, choice, undefined, undefined, { addMe }).summary,
    [bundle, state, choice, addMe],
  );
  const problem =
    askSelf && !selfIncoming && !addMe
      ? 'Choose which of these people you are, or tick “I’m not in this group”.'
      : chosenTwice.length
        ? `Two people are matched to ${chosenTwice.join(', ')}.`
        : null;

  const merge = async () => {
    if (problem || merging) return;
    setMerging(true);
    onMerged(await mergeNow(bundle, choice, { addMe }, parts));
  };

  const sender = bundle.users.find((u) => u.id === bundle.senderId)?.name;
  const localGroup = groups.find((g) => g.id === bundle.group.id) ?? bundle.group;
  const photoCount = bundle.receipts ? Object.keys(bundle.receipts).length : 0;
  const changes = [
    summary.added > 0 && { key: 'added', mark: `+${summary.added}`, cls: 'pos', text: 'new expenses and payments' },
    summary.updated > 0 && { key: 'updated', mark: String(summary.updated), cls: '', text: 'changed' },
    summary.deleted > 0 && { key: 'deleted', mark: `−${summary.deleted}`, cls: 'neg', text: 'deleted' },
    summary.newPeople > 0 && {
      key: 'people',
      icon: PERSON_ICON,
      text: `${summary.newPeople} new ${summary.newPeople === 1 ? 'person' : 'people'}`,
    },
    ...summary.membersAdded.map((name) => ({ key: `in-${name}`, icon: PERSON_ICON, text: `${name} joins the group` })),
    ...summary.membersRemoved.map((name) => ({ key: `out-${name}`, icon: PERSON_ICON, text: `${name} removed from the group` })),
    addMe && { key: 'me', icon: PERSON_ICON, text: 'You join the group' },
    photoCount > 0 && {
      key: 'photos',
      icon: RECEIPT_ICON,
      text: `${photoCount} receipt ${photoCount === 1 ? 'photo' : 'photos'}`,
    },
  ].filter(Boolean) as { key: string; mark?: string; cls?: string; icon?: React.ReactNode; text: string }[];

  return (
    <SwapFrame
      title="Review changes"
      closeTo="/groups"
      onClose={onCancel}
      sub={
        <>
          {parts ? `Received all ${parts} ${parts === 1 ? 'part' : 'parts'}` : 'Opened a file'}
          {sender ? ` from ${sender}` : ''} · nothing changes until you merge
        </>
      }
    >
      <div className="review-layout">
        <div className="review-col">
          <div className="review-group">
            <GroupTile group={localGroup} size={44} />
            <span>
              <span className="review-group-name">{bundle.group.name}</span>
              <span className="text-sm text-secondary">
                {sender ? `From ${sender} · ` : ''}
                {summary.isNewGroup ? 'new on this phone' : 'you already have this group'}
              </span>
            </span>
          </div>

          <section aria-labelledby="review-changes">
            <h2 id="review-changes" className="cap review-label">What changes on this phone</h2>
            <div className="review-changes">
              {changes.length === 0 ? (
                <p className="review-change">Nothing new: your copy is up to date.</p>
              ) : (
                changes.map((c) => (
                  <div key={c.key} className="review-change">
                    <span className={`num review-change-mark ${c.cls ?? ''}`}>{c.icon ?? c.mark}</span>
                    <span>{c.text}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="review-col">
          {summary.conflicts.length > 0 && (
            <div className="review-note">
              <span className="review-note-title">Edited on both phones</span>
              {summary.conflicts.map((c) => (
                <span key={c.description} className="text-sm">
                  {c.description}:{' '}
                  <span className="text-secondary">
                    {c.kept === 'theirs' ? 'their edit is newer, so it’s kept' : 'your edit is newer, so it’s kept'}
                  </span>
                </span>
              ))}
            </div>
          )}

          {toCheck.length > 0 && (
            <section aria-labelledby="review-people">
              <h2 id="review-people" className="cap review-label">
                {askSelf ? 'Which one are you?' : toCheck.length === 1 ? 'One person to check' : `${toCheck.length} people to check`}
              </h2>
              <div className="review-people">
                {toCheck.map((m) => (
                  <label key={m.incoming.id} className="review-person">
                    <span className="review-person-text">
                      <span className="review-person-name">{m.incoming.name}</span>
                      <span className="text-xs text-secondary">
                        {m.reason === 'same-name' ? 'Same name as someone you have' : 'New in this group'}
                      </span>
                    </span>
                    <select
                      className="field-input review-person-select"
                      aria-label={`Who is ${m.incoming.name} on this phone`}
                      value={choice[m.incoming.id] ?? NEW_PERSON}
                      onChange={(e) => {
                        const v = e.target.value;
                        setChoice((c) => ({ ...c, [m.incoming.id]: v }));
                        if (v === currentUserId) setAddMe(false);
                      }}
                    >
                      <option value={currentUserId}>This is me</option>
                      {users
                        .filter((u) => u.id !== currentUserId)
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            Same as my {u.name}
                          </option>
                        ))}
                      <option value={NEW_PERSON}>New person</option>
                    </select>
                  </label>
                ))}
              </div>
              {askSelf && (
                <label className="review-not-me">
                  <input
                    type="checkbox"
                    checked={addMe}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setAddMe(on);
                      // Nobody here is me after all.
                      if (on) {
                        setChoice((c) =>
                          Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === currentUserId ? NEW_PERSON : v])),
                        );
                      }
                    }}
                  />
                  <span className="review-not-me-text">
                    <span className="review-person-name">I'm not in this group</span>
                    <span className="text-xs text-secondary">Add me to it as a new member</span>
                  </span>
                </label>
              )}
              {matchedNames.length > 0 && (
                <span className="text-xs text-secondary">
                  {matchedNames.join(', ').replace(/, ([^,]*)$/, ' and $1')} {matchedNames.length === 1 ? 'is' : 'are'}{' '}
                  already matched.
                </span>
              )}
            </section>
          )}

          <div className="review-actions">
            {problem && <p className="swap-error">{problem}</p>}
            <button className="btn btn-primary review-merge" onClick={merge} disabled={!!problem || merging}>
              {summary.isNewGroup ? 'Add group' : `Merge into ${summary.groupName}`}
            </button>
            <button className="btn btn-secondary review-cancel" onClick={onCancel}>Cancel</button>
            <span className="review-actions-note">
              {askSelf ? 'Only asked the first time. After this, swaps merge straight away.' : 'Nothing changes until you merge.'}
            </span>
          </div>
        </div>
      </div>
    </SwapFrame>
  );
}
