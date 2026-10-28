/** Which build this is, for the About page and bug reports. */
export const APP_VERSION = __APP_VERSION__;
export const BUILD_COMMIT = __BUILD_COMMIT__;
export const BUILD_DATE = new Date(__BUILD_DATE__);

export const REPO_URL = 'https://github.com/ryanhgonzalez/opensplitwise';

/** "v1.0.0 · 96d24fa" */
export const versionLine = () => [`v${APP_VERSION}`, BUILD_COMMIT].filter(Boolean).join(' · ');

/** A new GitHub issue with the build already filled in. */
export function reportProblemUrl(): string {
  const body = [
    '**What happened?**',
    '',
    '',
    '**What did you expect?**',
    '',
    '',
    '---',
    `Build: ${versionLine()} (${BUILD_DATE.toISOString().slice(0, 10)})`,
    `Device: ${typeof navigator === 'undefined' ? '' : navigator.userAgent}`,
  ].join('\n');
  return `${REPO_URL}/issues/new?${new URLSearchParams({ body })}`;
}
