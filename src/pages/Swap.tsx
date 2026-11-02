import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { dataSnapshot, useStore } from '../store';
import { buildBundle, bundleContents, type GroupBundle } from '../lib/groupSync';
import { sendBundleFile } from '../lib/groupShare';
import { formatBytes, photosFor } from '../lib/receiptPhotos';
import { outstandingByGroup } from '../lib/calculations';
import { groupCurrency } from '../lib/currency';
import { directOther } from '../lib/directGroups';
import { changesText, senderName, undoReceived, useReceive, type Received } from '../lib/receive';
import { useQrScanner } from '../lib/useQrScanner';
import { canKeepAwake, useWakeLock } from '../lib/useWakeLock';
import { showToast } from '../lib/toast';
import { formatCurrency, formatRelativeDay } from '../utils';
import MergeReview from './MergeReview';
import { CameraView, CyclingCode, GotRow, ScanIcon, ScanProgress, SwapFrame, SwapNote } from './swapParts';
import './Swap.css';

/**
 * Swap a group with someone: show your code, which they scan with Scan; their
 * phone then shows back what yours is missing, and you scan that. Several
 * people can scan your code at once, and you scan each of theirs in turn.
 */
export default function Swap() {
  const [params] = useSearchParams();
  const id = params.get('group') ?? '';
  const exists = useStore((s) => s.groups.some((g) => g.id === id));
  if (!exists) return <Navigate to="/scan" replace />;
  return <SwapGroup key={id} groupId={id} />;
}

type Step = 'code' | 'scan' | 'done';

function SwapGroup({ groupId }: { groupId: string }) {
  const group = useStore((s) => s.groups.find((g) => g.id === groupId))!;
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.currentUserId);

  const [step, setStep] = useState<Step>('code');
  const [bundle, setBundle] = useState<GroupBundle | null>(null);
  /** Every code shown here (by when it was made) and what it held, to tell when a reply leaves both phones the same. */
  const shown = useRef(new Map<number, string>());
  const [result, setResult] = useState<{ received: Received; inSync: boolean } | null>(null);

  // Photos only travel in the file, and only if asked: they can make it many times larger.
  const [includePhotos, setIncludePhotos] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // A fresh code each time it's shown: this phone may have taken in someone's since.
  useEffect(() => {
    if (step !== 'code') return;
    const b = buildBundle(dataSnapshot(useStore.getState()), groupId);
    if (b) shown.current.set(b.sentAt.getTime(), bundleContents(b));
    setBundle(b);
  }, [step, groupId]);

  const onReceived = useCallback(
    (received: Received) => {
      // In sync when theirs answers a code of ours that held what this phone
      // had just before the merge: then each phone has the other's.
      const to = received.bundle.reply?.answers.getTime();
      const before = received.bundle.group.id === groupId ? buildBundle(received.before, groupId) : null;
      const inSync = to !== undefined && !!before && shown.current.get(to) === bundleContents(before);
      setResult({ received, inSync });
      setStep('done');
    },
    [groupId],
  );
  const { review, error, takePayload, finishReview, cancelReview } = useReceive(onReceived);
  const scanner = useQrScanner(step === 'scan' && !review, takePayload);
  useWakeLock(step === 'code');

  const otherId = group.direct ? directOther(group, me) : undefined;
  const otherName = otherId ? users.find((u) => u.id === otherId)?.name.split(' ')[0] : undefined;
  const title = otherName ? `Swap with ${otherName}` : `Swap ${group.name}`;
  const heading = otherName ? `You & ${otherName}` : group.name;
  const closeTo = `/groups/${groupId}`;
  const crumb = { name: group.name, to: closeTo };

  if (review) {
    return <MergeReview bundle={review.bundle} parts={review.parts} onMerged={finishReview} onCancel={cancelReview} />;
  }

  if (step === 'done' && result) {
    return (
      <SwapFrame title={title} crumb={crumb} closeTo={closeTo}>
        <SwapDone
          result={result}
          groupId={groupId}
          heading={heading}
          onShowCode={() => {
            setResult(null);
            setStep('code');
          }}
          onUndo={() => {
            undoReceived(result.received);
            showToast({ message: 'Undone. Your phone is as it was.' });
            setResult(null);
            setStep('code');
          }}
        />
      </SwapFrame>
    );
  }

  if (step === 'scan') {
    return (
      <SwapFrame title={title} crumb={crumb} closeTo={closeTo}>
        <div className="swap-layout">
          <div className="swap-main">
            <div className="swap-heading">
              <span className="swap-heading-name">Now scan their code</span>
              <span className="swap-heading-sub">Point your camera at their screen</span>
            </div>
            <CameraView scanner={scanner} />
          </div>
          <div className="swap-side">
            {error && <p className="swap-error">{error}</p>}
            {!scanner.cameraError && (
              <ScanProgress
                arrived={scanner.arrived}
                waitingTitle="Waiting for their code"
                waitingText="It only holds what you don’t have yet, so it’s usually a single part."
              />
            )}
            <div className="swap-footer swap-footer-stack">
              <button className="btn btn-secondary swap-wide" onClick={() => setStep('code')}>
                Show my code again
              </button>
              <span className="swap-caption">For anyone else who still needs yours.</span>
            </div>
          </div>
        </div>
      </SwapFrame>
    );
  }

  const withPhotos = bundle?.expenses.filter((e) => e.receipt) ?? [];
  const photoBytes = withPhotos.reduce((n, e) => n + (e.receipt?.bytes ?? 0), 0);
  const sendFile = async () => {
    if (!bundle) return;
    setSending(true);
    try {
      const receipts = includePhotos && withPhotos.length ? await photosFor(withPhotos.map((e) => e.id)) : undefined;
      if (await sendBundleFile({ ...bundle, receipts })) setSent(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <SwapFrame title={title} crumb={crumb} closeTo={closeTo}>
      <div className="swap-layout">
        <div className="swap-main">
          <div className="swap-heading">
            <span className="swap-heading-name">{heading}</span>
            <span className="swap-heading-sub">
              On their phone, tap <strong>Scan</strong> and point it here
            </span>
          </div>
          {bundle && <CyclingCode bundle={bundle} label="Your code for this group, changing several times a second" />}
        </div>

        <div className="swap-side">
          <span className="swap-side-lead">
            On their phone, tap <strong>Scan</strong> and point it here
          </span>
          <div className="swap-notes">
            {canKeepAwake() && <SwapNote icon="awake">Your screen stays on while the code is up</SwapNote>}
            <SwapNote icon="people">Several people can scan it at the same time</SwapNote>
          </div>
          <div className="swap-actions">
            <button className="btn btn-primary swap-wide" onClick={() => setStep('scan')}>
              <ScanIcon />
              Scan theirs back
            </button>
            <span className="swap-caption">Once they’ve scanned yours, their phone shows a code with their changes.</span>
          </div>

          <div className="swap-footer">
            <span className="swap-footer-text">Not together?</span>
            <button className="btn btn-secondary" onClick={sendFile} disabled={!bundle || sending}>
              {sending ? 'Preparing…' : 'Send as a file instead'}
            </button>
            {withPhotos.length > 0 && (
              <label className="swap-photos">
                <input type="checkbox" checked={includePhotos} onChange={(e) => setIncludePhotos(e.target.checked)} />
                <span>
                  Include {withPhotos.length} receipt {withPhotos.length === 1 ? 'photo' : 'photos'} (+{formatBytes(photoBytes)})
                </span>
              </label>
            )}
            {sent && <p className="swap-meta">Sent. When they open it from Scan, your changes are merged into their copy.</p>}
          </div>
        </div>
      </div>
    </SwapFrame>
  );
}

/** After scanning theirs back: in sync, or what's still to do. */
function SwapDone({
  result,
  groupId,
  heading,
  onShowCode,
  onUndo,
}: {
  result: { received: Received; inSync: boolean };
  groupId: string;
  heading: string;
  onShowCode: () => void;
  onUndo: () => void;
}) {
  const navigate = useNavigate();
  const { received, inSync } = result;
  const { bundle, summary } = received;
  const name = senderName(received);
  const me = useStore((s) => s.currentUserId);
  const users = useStore((s) => s.users);
  const group = useStore((s) => s.groups.find((g) => g.id === bundle.group.id));
  const expenses = useStore((s) => s.expenses);
  const payments = useStore((s) => s.settlements);
  const activities = useStore((s) => s.activities);

  // Theirs was another group: say so, and offer it.
  if (bundle.group.id !== groupId || !group) {
    return (
      <>
        <GotRow title={`Got ${bundle.group.name} from ${name}`} sub={changesText(summary)} onUndo={onUndo} />
        <div className="swap-actions swap-done-actions">
          <button className="btn btn-primary swap-wide" onClick={() => navigate(`/groups/${bundle.group.id}`, { replace: true })}>
            Open {bundle.group.name}
          </button>
          <button className="btn btn-secondary swap-wide" onClick={onShowCode}>
            Back to my code
          </button>
        </div>
      </>
    );
  }

  if (!inSync) {
    return (
      <>
        <GotRow title={`Got ${name}’s changes`} sub={`${changesText(summary)} · ${heading}`} onUndo={onUndo} />
        <div className="swap-empty">
          <span className="swap-empty-text">
            {bundle.reply
              ? `${name} scanned an earlier code of yours, so ${name} doesn’t have your latest changes yet.`
              : `${name} hasn’t got your changes yet.`}
          </span>
          <div className="swap-actions">
            <button className="btn btn-primary swap-wide" onClick={onShowCode}>
              Show {name} my code
            </button>
            <button className="btn btn-secondary swap-wide" onClick={() => navigate(`/groups/${groupId}`)}>
              Done
            </button>
          </div>
        </div>
      </>
    );
  }

  // Where you two stand in this group now: the same on both phones.
  const them = summary.peopleIds[bundle.senderId] ?? bundle.senderId;
  const cur = groupCurrency(group);
  const owed = (debtor: string, creditor: string) =>
    outstandingByGroup(expenses, payments, debtor, creditor, cur, [group]).find((b) => b.groupId === groupId)?.outstanding ?? 0;
  const net = owed(them, me) - owed(me, them);
  const even = Math.abs(net) < 0.005;

  // Someone else in the group, the one swapped with longest ago (or never).
  const lastFrom = new Map<string, Date>();
  for (const a of activities) {
    if (a.type !== 'group_synced' || a.groupId !== groupId) continue;
    const had = lastFrom.get(a.actorId);
    if (!had || a.date > had) lastFrom.set(a.actorId, a.date);
  }
  const next = group.members
    .map((m) => m.userId)
    .filter((id) => id !== me && id !== them)
    .map((id) => ({ id, at: lastFrom.get(id) }))
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))[0];
  const nextName = next && users.find((u) => u.id === next.id)?.name.split(' ')[0];

  return (
    <div className="swap-done">
      <span className="swap-done-mark" aria-hidden>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="swap-done-text">
        <h2 className="swap-done-title">You and {name} are in sync</h2>
        <p className="swap-done-sub">Both phones now have the same {heading}.</p>
      </div>

      <div className="swap-rows">
        <div className="swap-row">
          <span className="swap-row-label">From {name}</span>
          <span className="swap-row-value">{changesText(summary)}</span>
        </div>
        <div className="swap-row">
          <span className="swap-row-label">To {name}</span>
          <span className="swap-row-value">{changesText(bundle.reply!)}</span>
        </div>
        <div className="swap-row">
          <span className="swap-row-stack">
            <span className="swap-row-label">{even ? `You and ${name}` : net > 0 ? `${name} owes you` : `You owe ${name}`}</span>
            <span className="swap-row-sub">The same on their phone now</span>
          </span>
          <span className={even ? 'swap-row-value' : `num swap-row-money ${net > 0 ? 'pos' : 'neg'}`}>
            {even ? 'Even' : formatCurrency(Math.abs(net), cur)}
          </span>
        </div>
      </div>

      {nextName && (
        <SwapNote icon="clock">
          {next.at ? `${nextName} last swapped ${formatRelativeDay(next.at)}` : `${nextName} hasn’t swapped with you yet`}
        </SwapNote>
      )}

      <div className="swap-actions swap-done-actions">
        <button className="btn btn-primary swap-wide" onClick={() => navigate(`/groups/${groupId}`)}>
          Done
        </button>
        <button className="btn btn-secondary swap-wide" onClick={onShowCode}>
          Swap with someone else
        </button>
        <button className="swap-undo swap-undo-quiet" onClick={onUndo}>
          Undo what came from {name}
        </button>
      </div>
    </div>
  );
}
