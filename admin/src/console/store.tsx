import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { applyTheme } from '../design/theme';
import { api, type AdminState, type BootData, type SetResult } from './api';

interface Store extends BootData {
  /** Replace the settings with what a setter returned (the broadcast follows a moment later). */
  merge: (patch: Partial<AdminState>) => void;
  /** Settings keys saved this session that only apply after a restart. */
  pendingRestart: string[];
}

const Ctx = createContext<Store | null>(null);

/**
 * The console's one copy of the app state. Main is the only source (PetService): every change, made here
 * or in the pet window, comes back as `admin-state` and replaces this copy whole (docs §5.4).
 */
export const StoreProvider = ({ children, fallback }: { children: ReactNode; fallback: (error: string | null) => ReactNode }) => {
  const [data, setData] = useState<BootData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = () => {};
    try {
      const a = api();
      a.boot().then(setData, (e) => setError(String(e && e.message ? e.message : e)));
      const offs = [
        a.onState((st) => setData((d) => (d ? { ...d, ...st } : d))),
        a.onUpdateStatus((u) => setData((d) => (d ? { ...d, update: u } : d))),
        a.onApiStatus((s) => setData((d) => (d ? { ...d, apiStatus: s } : d))),
      ];
      off = () => offs.forEach((f) => f());
    } catch (e) {
      setError(String((e as Error).message));
    }
    return () => off();
  }, []);

  // 外观主题 (ui.theme): auto follows the OS, light / dark pin it
  const theme = data?.settings?.ui?.theme ?? 'auto';
  useEffect(() => applyTheme(theme), [theme]);

  const value = useMemo<Store | null>(
    () =>
      data && {
        ...data,
        merge: (patch) => setData((d) => (d ? { ...d, ...patch } : d)),
        pendingRestart: data.settings?.pendingRestart ?? [],
      },
    [data],
  );
  if (!value) return <>{fallback(error)}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useStore = (): Store => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
};

/** Save one setting; on success the returned settings replace ours at once. */
export const useSave = () => {
  const { merge } = useStore();
  return async (key: string, value: unknown): Promise<SetResult> => {
    const r = await api().set(key, value);
    if (r.settings) merge({ settings: r.settings });
    return r;
  };
};
