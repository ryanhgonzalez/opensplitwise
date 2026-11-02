import { useEffect, useRef, useState, type RefObject } from 'react';
import { FrameCollector } from './groupShare';

/** How often the camera picture is read while scanning. */
const SCAN_INTERVAL_MS = 120;

export interface QrScanner {
  /** Put on the <video> that shows the camera. */
  videoRef: RefObject<HTMLVideoElement>;
  /** For each part of the code being read, whether it has arrived. Empty until one has. */
  arrived: boolean[];
  /** Why the camera couldn't open, if it couldn't. */
  cameraError: string | null;
  /** Asks for the camera again. */
  retry: () => void;
}

/**
 * Reads a group's code with the camera while `active`. Its parts arrive in any
 * order and come round again; once all are in, the camera stops, the phone
 * buzzes where it can, and `onComplete` gets the whole payload. If it answers
 * false (the code was no use), scanning starts again.
 */
export function useQrScanner(
  active: boolean,
  onComplete: (payload: Uint8Array, parts: number) => boolean | void | Promise<boolean | void>,
): QrScanner {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [arrived, setArrived] = useState<boolean[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The latest callback, without restarting the camera when it changes.
  const complete = useRef(onComplete);
  useEffect(() => {
    complete.current = onComplete;
  });

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const collector = new FrameCollector();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    setCameraError(null);
    setArrived([]);

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };

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
      const video = videoRef.current;
      if (!video) return stop();
      video.srcObject = stream;
      await video.play().catch(() => {});
      const jsQR = (await import('jsqr')).default;

      const tick = () => {
        if (stopped) return;
        if (video.videoWidth) {
          // A smaller copy reads faster; the code fills most of the picture anyway.
          const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code && collector.add(Uint8Array.from(code.binaryData))) {
            setArrived(collector.arrived);
            if (collector.complete) {
              stop();
              navigator.vibrate?.(40);
              void Promise.resolve(complete.current(collector.payload(), collector.total)).then((ok) => {
                if (ok === false) setAttempt((n) => n + 1);
              });
              return;
            }
          }
        }
        timer = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      tick();
    })();

    return stop;
  }, [active, attempt]);

  return { videoRef, arrived, cameraError, retry: () => setAttempt((n) => n + 1) };
}
