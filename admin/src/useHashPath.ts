import { useEffect, useState } from 'react';

/**
 * Hash routing (`#/design/colors`) so `loadFile(index.html, { hash })` can open a page directly. A query after
 * the path (`#/characters?kind=live2d`, P-02「筛选进 URL」) is not part of the path: read it with `useHashQuery`.
 */
export const useHashPath = (fallback: string): [string, (path: string) => void] => {
  const read = () => location.hash.replace(/^#/, '').split('?')[0] || fallback;
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => setPath(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [path, (next) => { location.hash = next; }];
};

/** The query part of the hash (`?kind=live2d`), kept in step with it. */
export const useHashQuery = (): URLSearchParams => {
  const read = () => location.hash.split('?')[1] ?? '';
  const [q, setQ] = useState(read);
  useEffect(() => {
    const onChange = () => setQ(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return new URLSearchParams(q);
};

/**
 * Change the hash without a new history entry (a filter, a tab): 返回 still goes to the page before, and a
 * reload opens the same state. `hashchange` fires as usual.
 */
export const replaceHash = (next: string) => {
  const url = `${location.pathname}${location.search}#${next.replace(/^#/, '')}`;
  if (url === `${location.pathname}${location.search}${location.hash}`) return;
  const old = location.href;
  history.replaceState(history.state, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange', { newURL: location.href, oldURL: old }));
};
