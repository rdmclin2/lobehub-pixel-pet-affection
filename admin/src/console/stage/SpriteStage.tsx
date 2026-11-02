import { Avatar, createStaticStyles, cx } from '@lobehub/ui';
import { useEffect, useRef, useState } from 'react';

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

// one decoded sheet per URL, shared by every stage that shows it
const sheets = new Map<string, Promise<HTMLImageElement>>();
const loadSheet = (url: string) => {
  let p = sheets.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        sheets.delete(url);
        reject(new Error(`could not load ${url}`));
      };
      img.src = url;
    });
    sheets.set(url, p);
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
export const SpriteStage = ({ preview, name, accent, height, action = 'idle', animate = true, silhouette, className }: SpriteStageProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    setFailed(false);
    if (!preview || preview.type !== 'sprite' || !preview.frame) return;
    const c = canvas.current;
    if (!c) return;
    const { width, height: fh } = preview.frame;
    const acts = preview.actions ?? {};
    const a = acts[action] ?? acts.idle ?? { col: 0, fps: 1, frames: 1, row: 0 };
    const play = animate && visible && a.frames > 1 && !reducedMotion();
    let raf = 0;
    let alive = true;
    loadSheet(preview.url).then(
      (img) => {
        if (!alive) return;
        c.width = width;
        c.height = fh;
        const g = c.getContext('2d');
        if (!g) return;
        g.imageSmoothingEnabled = !preview.pixelated;
        let last = -1;
        const draw = (i: number) => {
          if (i === last) return;
          last = i;
          g.clearRect(0, 0, width, fh);
          g.drawImage(img, (a.col + i) * width, a.row * fh, width, fh, 0, 0, width, fh);
        };
        draw(0);
        if (!play) return;
        const t0 = performance.now();
        const tick = (t: number) => {
          draw(Math.floor(((t - t0) / 1000) * a.fps) % a.frames);
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [preview, action, animate, visible]);

  const ratio = preview?.type === 'sprite' && preview.frame ? preview.frame.width / preview.frame.height : 1;
  const width = Math.round(height * ratio);
  const cls = cx(styles.media, preview?.pixelated && styles.pixel);
  // a mid-grey shape reads on light and dark surfaces alike
  const shade = silhouette ? { filter: 'brightness(0) invert(0.5)', opacity: 0.55 } : undefined;
  let inner;
  if (!preview || failed) inner = <Avatar avatar={name.slice(0, 1)} background={accent} shape="square" size={Math.round(height * 0.6)} />;
  else if (preview.type === 'sprite') inner = <canvas aria-label={name} className={cls} ref={canvas} role="img" style={shade} />;
  else if (preview.type === 'video')
    inner = <video aria-label={name} autoPlay={animate && !reducedMotion()} className={cls} loop muted onError={() => setFailed(true)} playsInline preload="metadata" src={animate ? preview.url : `${preview.url}#t=0.1`} style={shade} />;
  else inner = <img alt={name} className={cls} onError={() => setFailed(true)} src={preview.url} style={shade} />;
  return (
    <div className={cx(styles.root, className)} data-action={action} data-preview={preview?.type ?? 'none'} ref={box} style={{ height, width }}>
      {inner}
    </div>
  );
};
