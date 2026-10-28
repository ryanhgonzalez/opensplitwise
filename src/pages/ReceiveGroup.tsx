import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { FrameCollector, decompressBundle, parseBundle } from '../lib/groupShare';
import { loadPhoto, savePhotos } from '../lib/receiptPhotos';
import { CloseIcon, PartsBar } from './sharingParts';
import './Sharing.css';

/** Scans per second while the camera is open. */
const SCAN_INTERVAL_MS = 120;

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
 * Receives a group from someone's phone: scanning their code (the camera
 * starts straight away) or a file they sent. Then shows what would change,
 * asks about anyone it can't match, and merges.
 */
export function ReceivePanel({
  closeTo,
  onReviewChange,
}: {
  /** Where Close goes without merging. */
  closeTo: string;
  /** Told when the review starts and ends, so the page can make room for it. */
  onReviewChange?: (reviewing: boolean) => void;
}) {
  const navigate = useNavigate();
  const applyGroupBundle = useStore((s) => s.applyGroupBundle);
  const users = useStore((s) => s.users);
  const groups = useStore((s) => s.groups);
  const currentUserId = useStore((s) => s.currentUserId);

  const [bundle, setBundle] = useState<GroupBundle | null>(null);
  /** How it arrived: the number of code parts, or 0 for a file. */
  const [viaParts, setViaParts] = useState(0);
  const [choice, setChoice] = useState<PeopleChoice>({});
  /** None of the group's people is the person here: add them to it on merge. */
  const [addMe, setAddMe] = useState(false);
  const [arrived, setArrived] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraTry, setCameraTry] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const review = (b: GroupBundle, parts: number) => {
    const state = dataSnapshot(useStore.getState());
    setBundle(b);
    setViaParts(parts);
    setChoice(defaultChoice(matchPeople(state, b)));
    setAddMe(false);
  };

  const openFile = async (file: File) => {
    setError(null);
    try {
      review(parseBundle(await file.text()), 0);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── Scan: from opening the page until a whole code has arrived ──
  const scanning = !bundle;
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const collector = new FrameCollector();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    setCameraError(null);

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        setCameraError('The camera couldn’t be opened. Allow camera access for this app, or ask them to send a file.');
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
            setArrived(collector.arrived);
            if (collector.complete) {
              stopped = true;
              stream?.getTracks().forEach((t) => t.stop());
              try {
                review(await decompressBundle(collector.payload()), collector.total);
              } catch (err) {
                setError((err as Error).message);
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
  }, [scanning, cameraTry]);

  useEffect(() => {
    onReviewChange?.(!!bundle);
  }, [bundle, onReviewChange]);

  // ── Review ──
  const state = useMemo(() => (bundle ? dataSnapshot(useStore.getState()) : null), [bundle]);
  const matches = useMemo(() => (bundle && state ? matchPeople(state, bundle) : []), [bundle, state]);
  const askSelf = !!state && needsSelfChoice(state, matches);
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
    () => (bundle && state ? mergeBundle(state, bundle, choice, undefined, undefined, { addMe }).summary : null),
    [bundle, state, choice, addMe],
  );
  const problem =
    askSelf && !selfIncoming && !addMe
      ? 'Choose which of these people you are, or tick “I’m not in this group”.'
      : chosenTwice.length
        ? `Two people are matched to ${chosenTwice.join(', ')}.`
        : null;

  const merge = async () => {
    if (!bundle || problem) return;
    const result = applyGroupBundle(bundle, choice, { addMe });
    // Photos that came with the file: for expenses taken from them, and any
    // this phone has no photo for. A newer photo here is never overwritten.
    if (bundle.receipts) {
      const take = new Set(result.receivedIds);
      for (const id of Object.keys(bundle.receipts)) {
        if (!take.has(id) && !(await loadPhoto(id).catch(() => undefined))) take.add(id);
      }
      await savePhotos(bundle.receipts, take).catch(() => {});
    }
    navigate(`/groups/${bundle.group.id}`, { replace: true });
  };

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
      if (f) openFile(f);
    },
  };

  const fileInput = (
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
  );

  // ─────────────────────────────── Scan ───────────────────────────────
  if (!bundle || !summary) {
    const total = arrived.length;
    const got = arrived.filter(Boolean).length;
    return (
      <div className={`receive-panel ${dragging ? 'dragging' : ''}`} {...dropProps}>
          <div className="receive-layout">
            <div className="receive-camera">
              <video ref={videoRef} className="receive-video" playsInline muted />
              {cameraError ? (
                <div className="receive-camera-msg">
                  <p>{cameraError}</p>
                  <button className="btn btn-secondary btn-sm" onClick={() => setCameraTry((n) => n + 1)}>
                    Try again
                  </button>
                </div>
              ) : (
                <div className="receive-guide" aria-hidden />
              )}
            </div>

            <div className="receive-side">
              {error && <p className="gs-error">{error}</p>}
              {!cameraError && (
                <div className="receive-progress">
                  <PartsBar parts={arrived} label="Parts received" />
                  <div className="receive-progress-head" aria-live="polite">
                    <span className="receive-progress-title">
                      {total ? `Got ${got} of ${total} parts` : 'Point the camera at their code'}
                    </span>
                  </div>
                  <span className="receive-progress-text">
                    {total
                      ? 'Keep their code inside the frame. Parts arrive in any order; the missing ones come round again in a moment.'
                      : 'Keep it inside the frame until all the parts are in.'}
                  </span>
                </div>
              )}

              <ol className="sharing-steps receive-steps">
                <li>
                  On their phone, open the group and tap <strong>Share</strong>.
                </li>
                <li>Hold it up to your camera until every part is in.</li>
              </ol>

              <div className="receive-file">
                <span className="receive-file-title">They sent you a file instead?</span>
                <span className="sharing-wide text-sm text-secondary">Or drop it anywhere on this page.</span>
                <button className="btn receive-file-btn" onClick={() => fileRef.current?.click()}>
                  Open a file
                </button>
                {fileInput}
              </div>
            </div>
          </div>
      </div>
    );
  }

  // ─────────────────────────────── Review ───────────────────────────────
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
    <>
        <div className="sharing-topbar">
          <span className="sharing-topbar-title sharing-topbar-muted">
            {viaParts ? `Received · all ${viaParts} ${viaParts === 1 ? 'part' : 'parts'}` : 'Received a file'}
          </span>
          <Link to={closeTo} className="sharing-close" aria-label="Close without merging">
            <CloseIcon />
          </Link>
        </div>
        <header className="sharing-header">
          <span className="sharing-crumb">
            <Link to="/groups">Groups</Link> /
          </span>
          <h1 className="sharing-title">Review changes</h1>
          <span className="sharing-header-sub">
            {viaParts ? `Received all ${viaParts} parts` : 'Opened a file'}
            {sender ? ` from ${sender}` : ''} · nothing changes until you merge
          </span>
        </header>

        <div className="review-layout">
          <div className="review-col">
            <div className="review-group">
              <GroupTile group={localGroup} size={44} />
              <span>
                <span className="review-group-name">{bundle.group.name}</span>
                <span className="text-sm text-secondary">
                  {sender ? `From ${sender} · ` : ''}
                  {summary.isNewGroup ? 'new on this device' : 'you already have this group'}
                </span>
              </span>
            </div>

            <section aria-labelledby="review-changes">
              <h2 id="review-changes" className="cap review-label">What changes on this device</h2>
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
                <span className="review-note-title">Edited on both devices</span>
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
                  {askSelf
                    ? 'Which one are you?'
                    : toCheck.length === 1
                      ? 'One person to check'
                      : `${toCheck.length} people to check`}
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
                        aria-label={`Who is ${m.incoming.name} on this device`}
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
              {problem && <p className="gs-error">{problem}</p>}
              <button className="btn btn-primary review-merge" onClick={merge} disabled={!!problem}>
                {summary.isNewGroup ? 'Add group' : `Merge into ${summary.groupName}`}
              </button>
              <Link to={closeTo} className="btn btn-secondary review-cancel">Cancel</Link>
              <span className="review-actions-note">Nothing changes until you merge.</span>
            </div>
          </div>
        </div>
    </>
  );
}
