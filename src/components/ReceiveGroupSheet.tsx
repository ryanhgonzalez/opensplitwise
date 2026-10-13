import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import {
  NEW_PERSON,
  defaultChoice,
  matchPeople,
  mergeBundle,
  needsSelfChoice,
  type GroupBundle,
  type PeopleChoice,
  type SyncState,
} from '../lib/groupSync';
import { FrameCollector, decompressBundle, parseBundle } from '../lib/groupShare';
import { loadPhoto, savePhotos } from '../lib/receiptPhotos';
import '../styles/sheet.css';
import './GroupShare.css';

interface ReceiveGroupSheetProps {
  open: boolean;
  onClose: () => void;
}

type Step = 'choose' | 'scan' | 'review';

/** Scans per second while the camera is open. */
const SCAN_INTERVAL_MS = 120;

const syncStateOf = (s: ReturnType<typeof useStore.getState>): SyncState => ({
  currentUserId: s.currentUserId,
  users: s.users,
  groups: s.groups,
  expenses: s.expenses,
  settlements: s.settlements,
  activities: s.activities,
  tombstones: s.tombstones,
  userAliases: s.userAliases,
  groupSyncedAt: s.groupSyncedAt,
});

/**
 * Receives a group from someone's phone (scanning their code, or a file they
 * sent), lets the person say who's who, previews the changes, then merges.
 */
export default function ReceiveGroupSheet({ open, onClose }: ReceiveGroupSheetProps) {
  const navigate = useNavigate();
  const applyGroupBundle = useStore((s) => s.applyGroupBundle);
  const users = useStore((s) => s.users);
  const currentUserId = useStore((s) => s.currentUserId);

  const [step, setStep] = useState<Step>('choose');
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<GroupBundle | null>(null);
  const [choice, setChoice] = useState<PeopleChoice>({});
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const reset = () => {
    setStep('choose');
    setError(null);
    setBundle(null);
    setChoice({});
    setProgress({ received: 0, total: 0 });
  };

  const close = () => {
    reset();
    onClose();
  };

  const review = (b: GroupBundle) => {
    const state = syncStateOf(useStore.getState());
    setBundle(b);
    setChoice(defaultChoice(matchPeople(state, b)));
    setStep('review');
  };

  // ── Open file ──
  const openFile = async (file: File) => {
    setError(null);
    try {
      review(parseBundle(await file.text()));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── Scan ──
  useEffect(() => {
    if (!open || step !== 'scan') return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const collector = new FrameCollector();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        setError('The camera couldn’t be opened. Allow camera access for this app, or ask them to send a file.');
        setStep('choose');
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      const jsQR = (await import('jsqr')).default;

      const tick = async () => {
        if (stopped) return;
        if (video.videoWidth) {
          // Reading a smaller copy is faster; the code fills most of the frame anyway.
          const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code && collector.add(Uint8Array.from(code.binaryData))) {
            setProgress({ received: collector.received, total: collector.total });
            if (collector.complete) {
              stopped = true;
              stream?.getTracks().forEach((t) => t.stop());
              try {
                review(await decompressBundle(collector.payload()));
              } catch (err) {
                setError((err as Error).message);
                setStep('choose');
              }
              return;
            }
          }
        }
        timer = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      tick();
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open, step]);

  // ── Review ──
  const state = useMemo(() => (bundle ? syncStateOf(useStore.getState()) : null), [bundle]);
  const matches = useMemo(() => (bundle && state ? matchPeople(state, bundle) : []), [bundle, state]);
  const askSelf = !!state && needsSelfChoice(state, matches);
  // Only people the app isn't sure about need a decision.
  const toDecide = matches.filter((m) => m.reason === 'same-name' || m.reason === 'none');
  const selfIncoming = Object.entries(choice).find(([, local]) => local === currentUserId)?.[0];

  const chosenTwice = useMemo(() => {
    const seen = new Map<string, number>();
    for (const local of Object.values(choice)) if (local !== NEW_PERSON) seen.set(local, (seen.get(local) ?? 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => users.find((u) => u.id === id)?.name ?? id);
  }, [choice, users]);

  const summary = useMemo(
    () => (bundle && state ? mergeBundle(state, bundle, choice).summary : null),
    [bundle, state, choice],
  );
  const problem = askSelf && !selfIncoming
    ? 'Choose which of these people is you.'
    : chosenTwice.length
      ? `Two people are matched to ${chosenTwice.join(', ')}.`
      : null;

  const merge = async () => {
    if (!bundle || problem) return;
    const result = applyGroupBundle(bundle, choice);
    // Photos that came with the file: for expenses taken from them, and any
    // this phone has no photo for. A newer photo here is never overwritten.
    if (bundle.receipts) {
      const take = new Set(result.receivedIds);
      for (const id of Object.keys(bundle.receipts)) {
        if (!take.has(id) && !(await loadPhoto(id).catch(() => undefined))) take.add(id);
      }
      await savePhotos(bundle.receipts, take).catch(() => {});
    }
    const id = bundle.group.id;
    close();
    navigate(`/groups/${id}`);
  };

  const sender = bundle?.users.find((u) => u.id === bundle.senderId)?.name;
  const otherLocals = users;

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
          <motion.div
            className="sheet-panel"
            role="dialog"
            aria-label="Receive a group"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">{step === 'review' && bundle ? bundle.group.name : 'Receive a group'}</span>
              <button className="sheet-close" onClick={close} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="sheet-body">
              {error && <p className="gs-error">{error}</p>}

              {step === 'choose' && (
                <div className="gs-choose">
                  <p className="gs-lead">
                    Get a group from someone's phone. If you already have it, their changes are merged into yours.
                  </p>
                  <button className="btn btn-primary gs-big" onClick={() => { setError(null); setStep('scan'); }}>
                    Scan code
                  </button>
                  <span className="gs-sub">On their phone: open the group, tap Share, Show code.</span>
                  <button className="btn btn-secondary gs-big" onClick={() => fileRef.current?.click()}>
                    Open file
                  </button>
                  <span className="gs-sub">A file they sent you (…opensplitwise-group.json).</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) openFile(f);
                    }}
                  />
                </div>
              )}

              {step === 'scan' && (
                <div className="gs-scan">
                  <div className="gs-video-wrap">
                    <video ref={videoRef} className="gs-video" playsInline muted />
                    <div className="gs-frame-guide" aria-hidden />
                  </div>
                  <div className="gs-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.received}>
                    <span style={{ width: `${progress.total ? (progress.received / progress.total) * 100 : 0}%` }} />
                  </div>
                  <p className="gs-meta num" aria-live="polite">
                    {progress.total ? `Received ${progress.received} of ${progress.total} parts` : 'Point the camera at their code…'}
                  </p>
                  <button className="btn btn-secondary" onClick={() => setStep('choose')}>Cancel</button>
                </div>
              )}

              {step === 'review' && bundle && summary && (
                <div className="gs-review">
                  <p className="gs-lead">
                    From {sender ?? 'someone'}.{' '}
                    {summary.isNewGroup ? 'This group is new on this phone.' : 'You already have this group; their changes will be merged in.'}
                  </p>

                  {(askSelf || toDecide.length > 0) && (
                    <section className="gs-people">
                      <h3 className="field-label">Who's who</h3>
                      {askSelf && <p className="gs-sub">Choose which of these people is you.</p>}
                      {matches
                        .filter((m) => askSelf || m.reason === 'same-name' || m.reason === 'none')
                        .map((m) => (
                          <label key={m.incoming.id} className="gs-person">
                            <span className="gs-person-name">{m.incoming.name}</span>
                            <select
                              className="field-input gs-person-select"
                              value={choice[m.incoming.id] ?? NEW_PERSON}
                              onChange={(e) => setChoice((c) => ({ ...c, [m.incoming.id]: e.target.value }))}
                            >
                              <option value={currentUserId}>This is me</option>
                              {otherLocals
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
                    </section>
                  )}

                  <section className="gs-summary">
                    <h3 className="field-label">What changes</h3>
                    <p className="num">
                      {[
                        summary.added && `${summary.added} new`,
                        summary.updated && `${summary.updated} changed`,
                        summary.deleted && `${summary.deleted} deleted`,
                        summary.newPeople && `${summary.newPeople} new ${summary.newPeople === 1 ? 'person' : 'people'}`,
                        summary.membersAdded.length && `${summary.membersAdded.join(', ')} added`,
                        summary.membersRemoved.length && `${summary.membersRemoved.join(', ')} removed`,
                        bundle.receipts &&
                          Object.keys(bundle.receipts).length &&
                          `${Object.keys(bundle.receipts).length} receipt ${Object.keys(bundle.receipts).length === 1 ? 'photo' : 'photos'}`,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Nothing new: your copy is up to date.'}
                    </p>
                    {summary.conflicts.length > 0 && (
                      <div className="gs-conflicts">
                        <span className="gs-sub">Edited on both phones; the newer edit is kept:</span>
                        <ul>
                          {summary.conflicts.map((c) => (
                            <li key={c.description}>
                              {c.description} · {c.kept === 'theirs' ? 'their edit' : 'your edit'}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>

                  {problem && <p className="gs-error">{problem}</p>}
                  <button className="btn btn-primary gs-big" onClick={merge} disabled={!!problem}>
                    {summary.isNewGroup ? 'Add group' : `Merge into ${summary.groupName}`}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
