/**
 * Appearance follows the OS (Electron forwards `nativeTheme` to `prefers-color-scheme`).
 * `?theme=light|dark` pins it (previews, screenshots). Primary / neutral stay LobeHub defaults.
 * lobe-ui reads `<html data-theme>` (D-08); styles never branch on it.
 */
import { setLobeTheme, type LobeAppearance } from '@lobehub/ui';

const pinned = (): LobeAppearance | null => {
  const v = new URLSearchParams(location.search).get('theme');
  return v === 'light' || v === 'dark' ? v : null;
};

export const initAppearance = (): (() => void) => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => setLobeTheme({ appearance: pinned() ?? (mq.matches ? 'dark' : 'light') });
  apply();
  mq.addEventListener('change', apply);
  return () => mq.removeEventListener('change', apply);
};
