import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { BUILD_DATE, REPO_URL, reportProblemUrl, versionLine } from '../lib/buildInfo';
import { formatBytes } from '../lib/receiptPhotos';
import { isOcrDownloaded, RECEIPT_OCR } from '../lib/receiptOcr';
import './Settings.css';
import './About.css';

const BUILT_WITH = [
  'React',
  'Zustand',
  'Framer Motion',
  'jsPDF',
  'Tesseract.js',
  'PaddleOCR models on ONNX Runtime',
  'OpenStreetMap',
  'jsQR',
  'node-qrcode',
  'IBM Plex fonts',
];

function OutArrow() {
  return (
    <svg className="settings-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 17L17 7M9 7H17V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OutLink({ href, label, sub }: { href: string; label: string; sub: string }) {
  return (
    <a className="settings-row about-link" href={href} target="_blank" rel="noopener noreferrer">
      <span className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-sub">{sub}</span>
      </span>
      <OutArrow />
    </a>
  );
}

/** How things stand on this device: storage, the receipt reader, offline use. */
function OnThisDevice() {
  const expenses = useStore((s) => s.expenses);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [ocrReady, setOcrReady] = useState<boolean | null>(null);

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(false));
    void isOcrDownloaded().then(setOcrReady);
  }, []);

  const photos = expenses.filter((e) => e.receipt);
  const photoBytes = photos.reduce((n, e) => n + (e.receipt?.bytes ?? 0), 0);
  const offlineReady = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;

  return (
    <section className="settings-section" aria-labelledby="about-device">
      <h2 id="about-device" className="settings-section-title">On this device</h2>
      <div className="settings-rows">
        <div className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-label">Storage</span>
            <span className="settings-row-sub">
              {persisted === null ? '' : persisted ? 'Protected · ' : 'Not protected yet · '}
              {expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}
              {photos.length > 0 && ` · ${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} (${formatBytes(photoBytes)})`}
            </span>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-label">Receipt reader</span>
            <span className="settings-row-sub">
              {ocrReady === null
                ? ''
                : ocrReady
                  ? `Downloaded · ${Math.round(RECEIPT_OCR.approxBytes / 1e6)} MB`
                  : 'Downloads the first time you scan a receipt'}
            </span>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row-text">
            <span className="settings-row-label">Works offline</span>
            <span className="settings-row-sub">{offlineReady ? 'Ready' : 'After the next visit'}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

export default function About() {
  const built = BUILD_DATE.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="page-content">
      <div className="settings-page">
        <div>
          <Link to="/settings" className="about-crumb">Settings /</Link>
          <h1 className="page-hero-title">About</h1>
        </div>

        <div className="about-hero">
          <img className="about-icon" src="/icon-192.png" alt="" width={56} height={56} />
          <span className="about-hero-text">
            <span className="about-name">OpenSplitwise</span>
            <span className="num about-version">
              {versionLine()} · built {built}
            </span>
          </span>
        </div>

        <p className="about-lede">
          A free, open-source way to split expenses with friends. No account, no ads, no tracking.
        </p>

        <section className="settings-section" aria-labelledby="about-data">
          <h2 id="about-data" className="settings-section-title">Your data</h2>
          <div className="settings-section-body about-copy">
            <p>
              Everything you enter stays on this device, in this browser. There's no server: groups move between
              phones by QR code or file, and backups are files you keep.
            </p>
            <p>Phone numbers and your pay names never leave this device, even when you share a group.</p>
            <p>
              The one exception is when you tap “Name this place” on an expense: that sends its location to
              OpenStreetMap to find the shops and restaurants nearby.
            </p>
            <p>Clearing this browser's data erases it all, so back up now and then.</p>
          </div>
        </section>

        <OnThisDevice />

        <section className="settings-section" aria-labelledby="about-links">
          <h2 id="about-links" className="settings-section-title">Links</h2>
          <div className="settings-rows">
            <OutLink href={REPO_URL} label="Source code" sub="On GitHub" />
            <OutLink href={reportProblemUrl()} label="Report a problem" sub="Opens a GitHub issue with this build filled in" />
            <OutLink href={`${REPO_URL}/blob/main/LICENSE`} label="License" sub="MIT" />
          </div>
        </section>

        <section className="settings-section" aria-labelledby="about-credits">
          <h2 id="about-credits" className="settings-section-title">Built with</h2>
          <div className="settings-section-body about-copy">
            <p>{BUILT_WITH.join(' · ')}</p>
          </div>
        </section>

        <footer className="about-footer">
          <p>Made by Ryan Gonzalez · © 2026</p>
          <p>Not affiliated with Splitwise.</p>
        </footer>
      </div>
    </div>
  );
}
