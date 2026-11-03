import { Avatar, createStaticStyles, cx } from '@lobehub/ui';
import { memo, useEffect, useRef, useState } from 'react';

import type { Preview } from '../api';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    position: relative;
    display: flex;
    flex: none;
    align-items: flex-end;
    justify-content: center;
  `,
  media: css`
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  `,
  pixel: css`
    image-rendering: pixelated;
  `,
}));

// A pack's sprite sheet is one big picture (the HD packs are 4 × 9 cells of 664 × 904 = 2656 × 8136 px,
// ~86 MB decoded). Drawing it straight onto a canvas makes Chromium decode the whole sheet synchronously on
// the main thread, again every time a stage mounts or its preview changes: one to two seconds per sheet, and
// the console froze on every click that re-rendered a stage. Instead the sheet is fetched as a Blob and
// decoded off the main thread (createImageBitmap), and each cell is cut out once, already scaled to the size
// it is shown at; the stages then only ever draw those small bitmaps.
//
// A wardrobe lists a dozen outfits, each its own sheet (T-2784): decoded all at once they took over a gigabyte
// and stalled the console. So at most DECODERS whole-sheet decodes run at once, a card only asks for its cell
// once it scrolls into view (`lazy`), and a sheet pushed out of the small cache is closed only after the cells
// still being cut from it are done.
type Cell = Promise<ImageBitmap>;
type Sheet = Promise<ImageBitmap>;
const MAX_SHEETS = 2; // decoded whole sheets kept while their cells are being cut (they are large)
const sheets = new Map<string, Sheet>();
const cells = new Map<string, Cell>();
const MAX_CELLS = 400;
const DECODERS = 3; // whole-sheet decodes at once (each is ~86 MB while it lasts)
let decoding = 0;
const waiting: (() => void)[] = [];
const slot = () => (decoding < DECODERS ? (decoding++, Promise.resolve()) : new Promise<void>((go) => waiting.push(go)));
const done = () => {
  const next = waiting.shift();
  if (next) next();
  else decoding--;
};
const cutting = new Map<Sheet, number>(); // cells being cut from a sheet right now
const retired = new Set<Sheet>(); // evicted while still being cut: closed when the last cut is done

const close = (q: Sheet) => q.then((bm) => bm.close(), () => {});
const release = (q: Sheet) => {
  const n = (cutting.get(q) ?? 1) - 1;
  if (n > 0) return void cutting.set(q, n);
  cutting.delete(q);
  if (retired.delete(q)) close(q);
};

const decodeSheet = (url: string) => {
  let p = sheets.get(url);
  if (p) {
    sheets.delete(url); // most recently used last
    sheets.set(url, p);
    return p;
  }
  p = slot()
    .then(() => fetch(url))
    .then((r) => {
      if (!r.ok) throw new Error(`could not load ${url}`);
      return r.blob();
    })
    .then((b) => createImageBitmap(b));
  p.then(done, done);
  p.catch(() => sheets.delete(url));
  sheets.set(url, p);
  while (sheets.size > MAX_SHEETS) {
    const [oldest, q] = sheets.entries().next().value as [string, Sheet];
    sheets.delete(oldest);
    if (cutting.has(q)) retired.add(q);
    else close(q);
  }
  return p;
};

/** One cell of a sheet, scaled to `h` device pixels high (cached: drawing it is cheap from then on). */
export const loadCell = (url: string, frame: { height: number; width: number }, row: number, col: number, h: number, pixelated: boolean): Cell => {
  const key = `${url}|${row},${col}|${h}|${pixelated ? 1 : 0}`;
  let p = cells.get(key);
  if (!p) {
    const w = Math.max(1, Math.round((h * frame.width) / frame.height));
    const sheet = decodeSheet(url);
    cutting.set(sheet, (cutting.get(sheet) ?? 0) + 1);
    p = sheet
      .then((bm) => createImageBitmap(bm, col * frame.width, row * frame.height, frame.width, frame.height, { resizeHeight: h, resizeQuality: pixelated ? 'pixelated' : 'high', resizeWidth: w }))
      .finally(() => release(sheet));
    p.catch(() => cells.delete(key));
    cells.set(key, p);
    // forget the oldest (not closed: a stage may still be drawing it; the GC frees it once nobody does)
    if (cells.size > MAX_CELLS) cells.delete(cells.keys().next().value as string);
  }
  return p;
};

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface SpriteStageProps {
  /** Action of a sprite sheet to play (`idle`, `happy`, `pat` …); unknown ones fall back to idle. */
  action?: string;
  accent?: string;
  /** false = hold the first frame (lists of many). */
  animate?: boolean;
  /** Load nothing until the stage first scrolls into view (long lists: a wardrobe of many sheets). */
  lazy?: boolean;
  className?: string;
  /** Height of the stage in px; the width follows the frame's aspect ratio (square box for pictures). */
  height: number;
  name: string;
  preview: Preview | null | undefined;
  /** Shown as a dark shape (a character not met yet). */
  silhouette?: boolean;
}

/**
 * A character drawn the way the pet window draws her: a sprite sheet played action by action on a canvas
 * (row, col, frames, fps from her pack), a pack picture, or her own clip. Stops when off screen or when the
 * system asks for reduced motion. A broken picture falls back to her initial on her accent colour.
 */
export const SpriteStage = memo(({ preview, name, accent, height, action = 'idle', animate = true, lazy = false, silhouette, className }: SpriteStageProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(true);
  // `lazy`: seen once = loaded, and it stays (scrolling away again only pauses it)
  const [seen, setSeen] = useState(!lazy || typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => {
        setVisible(e.isIntersecting);
        if (e.isIntersecting) setSeen(true);
      },
      { rootMargin: '160px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // `data-drawn` = the url whose first frame is on screen (set outside React: no re-render for it). The e2e
  // run waits on it to know a stage really shows her and not an empty box.
  const drawn = (url: string) => {
    if (box.current) box.current.dataset.drawn = url;
  };

  useEffect(() => {
    setFailed(false);
    // the same picture under a new preview object (a pack tried on, then worn) is still the one on screen
    if (box.current && box.current.dataset.drawn !== preview?.url) delete box.current.dataset.drawn;
  }, [preview]);

  useEffect(() => {
    if (!seen || !preview || preview.type !== 'sprite' || !preview.frame) return;
    const c = canvas.current;
    if (!c) return;
    const frame = preview.frame;
    const acts = preview.actions ?? {};
    const a = acts[action] ?? acts.idle ?? { col: 0, fps: 1, frames: 1, row: 0 };
    const play = animate && visible && a.frames > 1 && !reducedMotion();
    let timer = 0;
    let alive = true;
    // device pixels the stage shows her at: no point cutting cells larger than that
    const h = Math.max(1, Math.round(height * (window.devicePixelRatio || 1)));
    const pix = !!preview.pixelated;
    const n = play ? a.frames : 1;
    Promise.all(Array.from({ length: n }, (_, i) => loadCell(preview.url, frame, a.row, a.col + i, h, pix))).then(
      (frames) => {
        if (!alive) return;
        c.width = frames[0].width;
        c.height = frames[0].height;
        const g = c.getContext('2d');
        if (!g) return;
        let last = -1;
        const draw = (i: number) => {
          if (i === last) return;
          last = i;
          g.clearRect(0, 0, c.width, c.height);
          g.drawImage(frames[i], 0, 0);
        };
        draw(0);
        drawn(preview.url);
        if (!play) return;
        // her sheet plays at 2–8 fps: wake up only when the frame changes (a requestAnimationFrame loop
        // would run the page's whole frame lifecycle 60 times a second for it)
        let i = 0;
        const step = () => {
          i = (i + 1) % a.frames;
          draw(i);
          timer = window.setTimeout(step, 1000 / a.fps);
        };
        timer = window.setTimeout(step, 1000 / a.fps);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [preview, action, animate, visible, height, seen]);

  const ratio = preview?.type === 'sprite' && preview.frame ? preview.frame.width / preview.frame.height : 1;
  const width = Math.round(height * ratio);
  const cls = cx(styles.media, preview?.pixelated && styles.pixel);
  // a mid-grey shape reads on light and dark surfaces alike
  const shade = silhouette ? { filter: 'brightness(0) invert(0.5)', opacity: 0.55 } : undefined;
  let inner;
  if (!preview || failed) inner = <Avatar avatar={name.slice(0, 1)} background={accent} shape="square" size={Math.round(height * 0.6)} />;
  else if (preview.type === 'sprite') inner = <canvas aria-label={name} className={cls} ref={canvas} role="img" style={shade} />;
  else if (preview.type === 'video')
    inner = seen ? <video aria-label={name} autoPlay={animate && !reducedMotion()} className={cls} loop muted onError={() => setFailed(true)} onLoadedData={() => drawn(preview.url)} playsInline preload="metadata" src={animate ? preview.url : `${preview.url}#t=0.1`} style={shade} /> : null;
  else inner = <img alt={name} className={cls} decoding="async" loading={lazy ? 'lazy' : undefined} onError={() => setFailed(true)} onLoad={() => drawn(preview.url)} src={preview.url} style={shade} />;
  return (
    <div className={cx(styles.root, className)} data-action={action} data-failed={failed || undefined} data-preview={preview?.type ?? 'none'} data-silhouette={silhouette || undefined} data-src={preview?.url} ref={box} style={{ height, width }}>
      {inner}
    </div>
  );
});
SpriteStage.displayName = 'SpriteStage';
