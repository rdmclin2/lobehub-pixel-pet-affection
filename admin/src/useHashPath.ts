import { useEffect, useState } from 'react';

/** Hash routing (`#/design/colors`) so `loadFile(index.html, { hash })` can open a page directly. */
export const useHashPath = (fallback: string): [string, (path: string) => void] => {
  const read = () => location.hash.replace(/^#/, '') || fallback;
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => setPath(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [path, (next) => { location.hash = next; }];
};
