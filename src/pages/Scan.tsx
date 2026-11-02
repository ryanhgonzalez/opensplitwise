import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { dataSnapshot, useStore } from '../store';
import { buildBundle, buildReply, type GroupBundle } from '../lib/groupSync';
import { sendBundleFile } from '../lib/groupShare';
import { changesText, senderName, undoReceived, useReceive, type Received } from '../lib/receive';
import { useQrScanner } from '../lib/useQrScanner';
import { canKeepAwake, useWakeLock } from '../lib/useWakeLock';
import { showToast } from '../lib/toast';
import MergeReview from './MergeReview';
import { CameraView, CyclingCode, GotRow, ScanProgress, SwapFrame, SwapIcon, SwapNote } from './swapParts';
import './Swap.css';

/**
 * Scan: take in someone's group from their code, whether or not this phone
 * has it yet. Then show them back a code with what their phone is missing,
 * so one scan each way swaps everything. A file they sent opens here too.
 */
export default function Scan() {
  const location = useLocation();
  // Close goes back where Scan was opened from.
  const closeTo = (location.state as { from?: string } | null)?.from ?? '/';
  const [received, setReceived] = useState<Received | null>(null);
  const { review, error, takePayload, takeFile, finishReview, cancelReview } = useReceive(setReceived);
  const scanner = useQrScanner(!received && !review, takePayload);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (review) {
    return <MergeReview bundle={review.bundle} parts={review.parts} onMerged={finishReview} onCancel={cancelReview} />;
  }
  if (received) return <ScanResult received={received} closeTo={closeTo} />;

  // A file can be dropped anywhere on the page (computers).
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) void takeFile(f);
    },
  };

  return (
    <SwapFrame title="Scan a code" closeTo={closeTo}>
      <div className="swap-layout" {...dropProps}>
        <div className="swap-main">
          <CameraView scanner={scanner} dragging={dragging} />
        </div>
        <div className="swap-side">
          {error && <p className="swap-error">{error}</p>}
          {!scanner.cameraError && (
            <ScanProgress
              arrived={scanner.arrived}
              waitingTitle="Point the camera at their code"
              waitingText="They open the group on their phone and tap Swap."
            />
          )}
          <SwapNote icon="people">Works for any group: one you have, or a new one</SwapNote>
          <div className="swap-footer">
            <span className="swap-footer-text">They sent you a file?</span>
            <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
              Open a file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void takeFile(f);
              }}
            />
          </div>
        </div>
      </div>
    </SwapFrame>
  );
}

/** After the merge: what came in, and the code to show back. */
function ScanResult({ received, closeTo }: { received: Received; closeTo: string }) {
  const navigate = useNavigate();
  const { bundle, summary, parts } = received;
  const groupId = bundle.group.id;
  const groupName = useStore((s) => s.groups.find((g) => g.id === groupId)?.name) ?? bundle.group.name;
  const name = senderName(received);

  // What their phone is missing, from this phone as the merge left it. None
  // for a code that was itself an answer: that phone has everything already.
  const [reply] = useState<GroupBundle | null>(() =>
    bundle.reply ? null : buildReply(dataSnapshot(useStore.getState()), bundle, summary.peopleIds, summary),
  );
  const showCode = parts > 0 && !!reply;
  useWakeLock(showCode);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const done = () => navigate(`/groups/${groupId}`, { replace: true });
  const undo = () => {
    undoReceived(received);
    showToast({ message: 'Undone. Your phone is as it was.' });
    navigate(closeTo, { replace: true });
  };
  const sendBack = async () => {
    const full = buildBundle(dataSnapshot(useStore.getState()), groupId);
    if (!full) return;
    setSending(true);
    try {
      if (await sendBundleFile(full)) setSent(true);
    } finally {
      setSending(false);
    }
  };

  const people = bundle.group.members.length;
  const got = summary.isNewGroup
    ? {
        title: `Got ${groupName} from ${name}`,
        sub: `${bundle.expenses.length} ${bundle.expenses.length === 1 ? 'expense' : 'expenses'} · ${people} ${people === 1 ? 'person' : 'people'}`,
      }
    : { title: `Got ${name}’s changes`, sub: `${changesText(summary)} · ${groupName}` };

  return (
    <SwapFrame title={showCode ? `Swap with ${name}` : 'Scan a code'} crumb={{ name: groupName, to: `/groups/${groupId}` }} closeTo={`/groups/${groupId}`}>
      <GotRow title={got.title} sub={got.sub} onUndo={undo} />

      {showCode ? (
        <div className="swap-layout">
          <div className="swap-main">
            <h2 className="cap swap-label">Now show {name} yours</h2>
            <CyclingCode bundle={reply} label={`Your code for ${name}`} onePart={`only what ${name} doesn’t have`} />
          </div>
          <div className="swap-side">
            <p className="swap-lead">
              On {name}’s phone, tap <strong>Scan theirs back</strong>.
            </p>
            {canKeepAwake() && <SwapNote icon="awake">Your screen stays on while the code is up</SwapNote>}
            <div className="swap-actions">
              <button className="btn btn-secondary swap-wide" onClick={done}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="swap-empty">
          {parts === 0 && reply ? (
            <>
              <span className="swap-empty-title">Send yours back?</span>
              <span className="swap-empty-text">
                Your phone has changes {name} doesn’t. Send them back as a file and {name} opens it from Scan.
              </span>
              <button className="btn btn-secondary" onClick={sendBack} disabled={sending}>
                {sending ? 'Preparing…' : 'Send yours back'}
              </button>
              {sent && <span className="swap-meta">Sent.</span>}
            </>
          ) : (
            !bundle.reply && (
              <>
                <span className="swap-empty-mark" aria-hidden>
                  <SwapIcon size={26} />
                </span>
                <span className="swap-empty-title">Nothing to send back</span>
                <span className="swap-empty-text">{name} already has everything on your phone, so there’s no code to show.</span>
              </>
            )
          )}
          <div className="swap-actions">
            <button className="btn btn-primary swap-wide" onClick={done}>
              Done
            </button>
          </div>
        </div>
      )}
    </SwapFrame>
  );
}
