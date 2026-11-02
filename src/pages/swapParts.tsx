import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GroupBundle } from '../lib/groupSync';
import { compressBundle, toFrames } from '../lib/groupShare';
import type { QrScanner } from '../lib/useQrScanner';

/** Small pieces shared by the Swap and Scan pages. */

/** How long each part of a code stays on screen. */
const FRAME_MS = 300;

/** The code's size: as large as fits a phone, larger on a computer screen. */
const qrSize = () => (window.matchMedia('(min-width: 1024px)').matches ? 360 : Math.min(300, window.innerWidth - 72));

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ScanIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SwapIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AwakeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M3.5 19c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5M15.5 5.2a3 3 0 0 1 0 5.6M17.5 13.8c1.8.7 3 2.6 3 5.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 8v4l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

const NOTE_ICONS = { awake: AwakeIcon, people: PeopleIcon, clock: ClockIcon };

/** A short line with an icon: "Your screen stays on while the code is up". */
export function SwapNote({ icon, children }: { icon: keyof typeof NOTE_ICONS; children: ReactNode }) {
  const Icon = NOTE_ICONS[icon];
  return (
    <span className="swap-note">
      <Icon />
      {children}
    </span>
  );
}

/**
 * One segment per part of the code. On the showing side the lit segment is
 * the part on screen; on the scanning side, the parts that have arrived.
 */
function PartsBar({ parts, label }: { parts: boolean[]; label?: string }) {
  if (parts.length === 0) return <div className="parts-bar parts-bar-empty" aria-hidden />;
  return (
    <div
      className={`parts-bar ${parts.length > 24 ? 'parts-bar-dense' : ''}`}
      style={{ gridTemplateColumns: `repeat(${parts.length}, minmax(0, 1fr))` }}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? parts.length : undefined}
      aria-valuenow={label ? parts.filter(Boolean).length : undefined}
      aria-hidden={label ? undefined : true}
    >
      {parts.map((on, i) => (
        <span key={i} className={on ? 'on' : ''} />
      ))}
    </div>
  );
}

/**
 * A group's code: the bundle, compressed and split into parts that take turns
 * on screen. Black on white in either theme, so cameras read it.
 */
export function CyclingCode({ bundle, label, onePart }: { bundle: GroupBundle; label: string; onePart?: string }) {
  const [frames, setFrames] = useState<Uint8Array[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    setFrames([]);
    setIndex(0);
    setError(null);
    compressBundle(bundle)
      .then((payload) => live && setFrames(toFrames(payload)))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [bundle]);

  useEffect(() => {
    if (frames.length < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % frames.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [frames]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frames[index % Math.max(frames.length, 1)];
    if (!canvas || !frame) return;
    let live = true;
    import('qrcode').then((QR) => {
      if (!live) return;
      // Every part the same size, so the code doesn't jump: the first is the fullest.
      const version = QR.create([{ data: frames[0], mode: 'byte' }], { errorCorrectionLevel: 'L' }).version;
      const squares = 4 * version + 17 + 2 * 2;
      // A whole number of screen pixels per square. Squares of uneven widths
      // (4 and 5 pixels, say) made some sizes of code unreadable.
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.max(1, Math.floor((qrSize() * dpr) / squares));
      QR.toCanvas(canvas, [{ data: frame, mode: 'byte' }], {
        errorCorrectionLevel: 'L',
        version,
        margin: 2,
        scale,
        color: { dark: '#000000', light: '#ffffff' },
      })
        .then(() => {
          if (!live) return;
          canvas.style.width = canvas.style.height = `${canvas.width / dpr}px`;
        })
        .catch((err: Error) => setError(err.message));
    });
    return () => {
      live = false;
    };
  }, [frames, index]);

  const text = error
    ? error
    : frames.length > 1
      ? `Part ${index + 1} of ${frames.length} · changes on its own`
      : frames.length
        ? `One part${onePart ? ` · ${onePart}` : ''}`
        : 'Preparing…';

  return (
    <div className="swap-code">
      <div className="swap-qr-wrap">
        <canvas ref={canvasRef} className="swap-qr" aria-label={label} />
      </div>
      <div className="swap-parts">
        <PartsBar parts={frames.map((_, i) => i === index)} />
        <span className={`num swap-parts-text ${error ? 'error' : ''}`}>{text}</span>
      </div>
    </div>
  );
}

/** The camera picture, with a frame to aim at, or why it couldn't open. */
export function CameraView({ scanner, dragging }: { scanner: QrScanner; dragging?: boolean }) {
  return (
    <div className={`swap-camera ${dragging ? 'dragging' : ''}`}>
      <video ref={scanner.videoRef} className="swap-video" playsInline muted />
      {scanner.cameraError ? (
        <div className="swap-camera-msg">
          <p>{scanner.cameraError}</p>
          <button className="btn btn-secondary btn-sm" onClick={scanner.retry}>
            Try again
          </button>
        </div>
      ) : (
        <div className="swap-guide" aria-hidden />
      )}
    </div>
  );
}

/** How the scan is going: parts in, or what to do before the first. */
export function ScanProgress({ arrived, waitingTitle, waitingText }: { arrived: boolean[]; waitingTitle: string; waitingText: string }) {
  const total = arrived.length;
  const got = arrived.filter(Boolean).length;
  return (
    <div className="swap-progress">
      <PartsBar parts={arrived} label="Parts received" />
      <span className="swap-progress-title" aria-live="polite">
        {total ? `Got ${got} of ${total} ${total === 1 ? 'part' : 'parts'}` : waitingTitle}
      </span>
      <span className="swap-progress-text">
        {total ? 'Keep their code in the frame. Any missing parts come round again in a moment.' : waitingText}
      </span>
    </div>
  );
}

/**
 * The page around a swap screen. Phones: a title bar with a close button.
 * Computers: a breadcrumb, the title and Done.
 */
export function SwapFrame({
  title,
  crumb,
  sub,
  closeTo,
  onClose,
  children,
}: {
  title: string;
  /** The group it's about, for the breadcrumb. */
  crumb?: { name: string; to: string };
  sub?: ReactNode;
  closeTo: string;
  /** Instead of following closeTo (Undo-free cancel of a review, say). */
  onClose?: () => void;
  children: ReactNode;
}) {
  const close = onClose ? (
    <button className="swap-close" onClick={onClose} aria-label="Close">
      <CloseIcon />
    </button>
  ) : (
    <Link to={closeTo} className="swap-close" aria-label="Close">
      <CloseIcon />
    </Link>
  );
  return (
    <div className="page-content swap-scroll">
      <div className="swap-page">
        <div className="swap-topbar">
          <span className="swap-topbar-title">{title}</span>
          {close}
        </div>
        <header className="swap-header">
          <span className="swap-crumb">
            <Link to="/groups">Groups</Link> /{crumb && <> <Link to={crumb.to}>{crumb.name}</Link> /</>}
          </span>
          <h1 className="swap-title">{title}</h1>
          {onClose ? (
            <button className="btn btn-secondary swap-header-btn" onClick={onClose}>Cancel</button>
          ) : (
            <Link to={closeTo} className="btn btn-secondary swap-header-btn">Done</Link>
          )}
          {sub && <span className="swap-header-sub">{sub}</span>}
        </header>
        {children}
      </div>
    </div>
  );
}

/** "Got Ana's changes · 3 new · Lisbon trip", with Undo. */
export function GotRow({ title, sub, onUndo }: { title: string; sub: string; onUndo?: () => void }) {
  return (
    <div className="swap-got">
      <span className="swap-got-mark" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="swap-got-text">
        <span className="swap-got-title">{title}</span>
        <span className="swap-got-sub">{sub}</span>
      </span>
      {onUndo && (
        <button className="swap-undo" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}
