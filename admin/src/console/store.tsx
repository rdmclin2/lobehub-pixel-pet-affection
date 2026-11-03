import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';

import { applyTheme } from '../design/theme';
import { api, type AdminState, type BootData, type SetResult } from './api';

interface Store extends BootData {
  /** Replace the settings with what a setter returned (the broadcast follows a moment later). */
  merge: (patch: Partial<AdminState>) => void;
  /** Settings keys saved this session that only apply after a restart. */
  pendingRestart: string[];
}

const NONE: string[] = [];
/**
 * Holds the current Store outside React's context value, so a change does not re-render every consumer:
 * each `useStore()` re-renders only when a top-level field it read (`roster`, `settings`, `view` …) changed.
 */
interface Box {
  current: Store | null;
  listeners: Set<() => void>;
}
const Ctx = createContext<Box | null>(null);

/**
 * `next`, but reusing every part of `prev` that is deep-equal to it. Main sends the whole state on every
 * change (a heartbeat, a save, her mood), always as new objects: without this every roster row, preview and
 * settings section would look changed, so every page re-rendered whole and every stage re-drew. With it an
 * unchanged push returns `prev` itself (React skips the update) and memoised parts keep their props.
 */
export const share = <T,>(prev: T, next: T): T => {
  if (Object.is(prev, next)) return prev;
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null) return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(prev)) {
    const a = next as unknown as unknown[];
    const out = a.map((v, i) => share(prev[i], v));
    return out.length === prev.length && out.every((v, i) => v === prev[i]) ? prev : (out as unknown as T);
  }
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = Object.keys(n);
  let same = keys.length === Object.keys(p).length;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = share(p[k], n[k]);
    if (out[k] !== p[k] || !(k in p)) same = false;
  }
  return same ? prev : (out as T);
};

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
        a.onState((st) => setData((d) => (d ? share(d, { ...d, ...st }) : d))),
        a.onUpdateStatus((u) => setData((d) => (d ? share(d, { ...d, update: u }) : d))),
        a.onApiStatus((s) => setData((d) => (d ? share(d, { ...d, apiStatus: s }) : d))),
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

  const merge = useCallback((patch: Partial<AdminState>) => setData((d) => (d ? share(d, { ...d, ...patch }) : d)), []);
  const value = useMemo<Store | null>(() => data && { ...data, merge, pendingRestart: data.settings?.pendingRestart ?? NONE }, [data, merge]);
  const [box] = useState<Box>(() => ({ current: null, listeners: new Set() }));
  // children rendering in this same pass read the new value; the ones React skipped are told after commit
  box.current = value;
  useLayoutEffect(() => {
    box.listeners.forEach((l) => l());
  }, [box, value]);
  if (!value) return <>{fallback(error)}</>;
  return <Ctx.Provider value={box}>{children}</Ctx.Provider>;
};

/**
 * The store, for reading at render (destructure what you need: `const { roster, view } = useStore()`). The
 * fields read are remembered, and the component re-renders only when one of them is a different object
 * (structural sharing keeps unchanged ones identical), not on every change anywhere in the app state.
 */
export const useStore = (): Store => {
  const box = useContext(Ctx);
  if (!box || !box.current) throw new Error('useStore outside StoreProvider');
  const used = useRef(new Set<string>());
  const shown = useRef<Store>(box.current);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const check = () => {
      const next = box.current;
      if (!next) return;
      for (const k of used.current) if ((next as any)[k] !== (shown.current as any)[k]) return rerender();
    };
    box.listeners.add(check);
    check(); // a change between this render and subscribing
    return () => void box.listeners.delete(check);
  }, [box]);
  const s = box.current;
  // what is on screen = what the last *committed* render read. Recorded after commit, not during render: a
  // render React throws away (a batch it restarts, a flushSync from a toast) would otherwise mark a newer
  // state as shown, and the push that brought it — a pack worn, an outfit changed — never redrew the page
  useLayoutEffect(() => {
    shown.current = s;
    const next = box.current;
    if (next && next !== s) for (const k of used.current) if ((next as any)[k] !== (s as any)[k]) return rerender();
  });
  return useMemo(
    () =>
      new Proxy(s, {
        get(t, k) {
          if (typeof k === 'string') used.current.add(k);
          return (t as any)[k];
        },
      }),
    [s],
  );
};

/** Save one setting; on success the returned settings replace ours at once. */
export const useSave = () => {
  const { merge } = useStore();
  return useCallback(
    async (key: string, value: unknown): Promise<SetResult> => {
      const r = await api().set(key, value);
      if (r.settings) merge({ settings: r.settings });
      return r;
    },
    [merge],
  );
};
