/**
 * Appearance: follows the OS (Electron forwards `nativeTheme` to `prefers-color-scheme`) unless the owner
 * pinned one in 外观主题 (settings.ui.theme). `?theme=light|dark` pins it too (previews, screenshots).
 * lobe-ui reads `<html data-theme>` (D-08); styles never branch on it.
 */
import { setLobeTheme, type LobeAppearance } from '@lobehub/ui';

type ThemeChoice = 'auto' | 'light' | 'dark';

const pinned = (): LobeAppearance | null => {
  const v = new URLSearchParams(location.search).get('theme');
  return v === 'light' || v === 'dark' ? v : null;
};

let choice: ThemeChoice = 'auto';
const mq = () => window.matchMedia('(prefers-color-scheme: dark)');
const apply = () => setLobeTheme({ appearance: pinned() ?? (choice === 'auto' ? (mq().matches ? 'dark' : 'light') : choice) });

export const initAppearance = (): (() => void) => {
  const m = mq();
  apply();
  m.addEventListener('change', apply);
  return () => m.removeEventListener('change', apply);
};

/** The owner's choice from settings.ui.theme. */
export const applyTheme = (theme: string) => {
  choice = theme === 'light' || theme === 'dark' ? theme : 'auto';
  apply();
};
