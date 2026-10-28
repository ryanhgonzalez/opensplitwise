import { useEffect, useRef, useState } from 'react';
import { dataSnapshot, useStore } from '../store';
import GroupTile from '../components/GroupTile';
import { buildBundle, type GroupBundle } from '../lib/groupSync';
import { compressBundle, sendBundleFile, toFrames } from '../lib/groupShare';
import { formatBytes, photosFor } from '../lib/receiptPhotos';
import { PartsBar } from './sharingParts';
import './Sharing.css';

/** How long each frame of the code stays on screen. */
const FRAME_MS = 300;

/** The code's size: as large as fits a phone, larger on a computer screen. */
const qrSize = () => (window.matchMedia('(min-width: 1024px)').matches ? 400 : Math.min(320, window.innerWidth - 56));

/**
 * Sends a group to someone's phone: as a cycling QR code they scan in the app
 * (together, no internet needed), or as a file through the share sheet.
 */
export function SendPanel({ groupId: id }: { groupId: string }) {
  const group = useStore((s) => s.groups.find((g) => g.id === id));

  const [bundle, setBundle] = useState<GroupBundle | null>(null);
  const [frames, setFrames] = useState<Uint8Array[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Photos only travel in the file, and only if asked: they can make it many times larger.
  const [includePhotos, setIncludePhotos] = useState(false);
  const [sending, setSending] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Pack the group as it is when the page opens.
  useEffect(() => {
    let live = true;
    const b = buildBundle(dataSnapshot(useStore.getState()), id);
    setBundle(b);
    if (b) {
      compressBundle(b)
        .then((payload) => live && setFrames(toFrames(payload)))
        .catch((err: Error) => live && setError(err.message));
    }
    return () => {
      live = false;
    };
  }, [id]);

  // Cycle through the frames.
  useEffect(() => {
    if (frames.length < 2) return;
    const timer = setInterval(() => setFrameIndex((i) => (i + 1) % frames.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [frames]);

  // Draw the current frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frames[frameIndex % Math.max(frames.length, 1)];
    if (!canvas || !frame) return;
    let live = true;
    import('qrcode').then((QR) => {
      if (!live) return;
      QR.toCanvas(canvas, [{ data: frame, mode: 'byte' }], {
        errorCorrectionLevel: 'L',
        margin: 2,
        width: qrSize(),
        color: { dark: '#000000', light: '#ffffff' },
      }).catch((err: Error) => setError(err.message));
    });
    return () => {
      live = false;
    };
  }, [frames, frameIndex]);

  if (!group) return null;

  const withPhotos = bundle?.expenses.filter((e) => e.receipt) ?? [];
  const photoBytes = withPhotos.reduce((n, e) => n + (e.receipt?.bytes ?? 0), 0);
  const expenseCount = bundle?.expenses.length ?? 0;
  const peopleCount = group.members.length;

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
    <>
        <div className="share-layout">
          <div className="share-code">
            <div className="share-code-heading">
              <span className="share-group-name">{group.name}</span>
              <span className="text-secondary">Hold this up to their camera</span>
            </div>
            <div className="share-qr-wrap">
              <canvas ref={canvasRef} className="share-qr" aria-label="Group code, changing several times a second" />
            </div>
            <div className="share-parts">
              <PartsBar parts={frames.map((_, i) => i === frameIndex)} />
              <span className="num share-parts-text">
                {frames.length > 1
                  ? `Part ${frameIndex + 1} of ${frames.length} · changes on its own`
                  : frames.length
                    ? 'One part'
                    : 'Preparing…'}
              </span>
            </div>
          </div>

          <div className="share-side">
            <div className="share-side-group">
              <GroupTile group={group} size={44} />
              <span>
                <span className="share-side-name">{group.name}</span>
                <span className="text-sm text-secondary">
                  {expenseCount} {expenseCount === 1 ? 'expense' : 'expenses'} · {peopleCount}{' '}
                  {peopleCount === 1 ? 'person' : 'people'}
                </span>
              </span>
            </div>
            <span className="share-side-lead">Hold their phone up to this screen</span>

            {error && <p className="gs-error">{error}</p>}

            <ol className="sharing-steps">
              <li>
                On their phone, open this group and tap <strong>Share</strong>, then <strong>Get their changes</strong>.
                Don't have it yet? <strong>Add group</strong>, then <strong>Get one from a friend</strong>.
              </li>
              <li>Point the camera here until their phone says it's done.</li>
              <li className="sharing-step-wide">They check the changes and merge.</li>
            </ol>
            <span className="sharing-meta">
              <span className="sharing-narrow">
                {expenseCount} {expenseCount === 1 ? 'expense' : 'expenses'} · {peopleCount}{' '}
                {peopleCount === 1 ? 'person' : 'people'} ·{' '}
              </span>
              No internet needed. Turn your brightness up if it's slow to read. Sharing again later sends what's new.
            </span>

            <div className="share-file">
              <span className="share-file-title">Not together?</span>
              <span className="sharing-wide text-sm text-secondary">
                Send a file with AirDrop, Messages or email. They open it from Receive.
              </span>
              {withPhotos.length > 0 && (
                <label className="gs-photos">
                  <input type="checkbox" checked={includePhotos} onChange={(e) => setIncludePhotos(e.target.checked)} />
                  <span>
                    Include {withPhotos.length} receipt {withPhotos.length === 1 ? 'photo' : 'photos'} (+
                    {formatBytes(photoBytes)})
                  </span>
                </label>
              )}
              <button className="btn btn-secondary share-file-btn" onClick={sendFile} disabled={!bundle || sending}>
                {sending ? 'Preparing…' : 'Send as a file instead'}
              </button>
              {sent && <p className="sharing-meta">Sent. When they open it, your changes are merged into their copy.</p>}
            </div>
          </div>
        </div>
    </>
  );
}
