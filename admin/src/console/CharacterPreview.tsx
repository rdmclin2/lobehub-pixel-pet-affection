import { Avatar, createStaticStyles } from '@lobehub/ui';
import { useEffect, useRef, useState } from 'react';

import type { Preview } from './api';

const styles = createStaticStyles(({ css, cssVar }) => ({
  box: css`
    overflow: hidden;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillTertiary};
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

/**
 * Her picture in the console: a sprite sheet's first frame (drawn to a canvas), a pack picture over pack://,
 * or the first frame of her idle clip. A broken one falls back to an initial on her accent colour.
 */
export const CharacterPreview = ({ preview, name, accent, size = 56 }: { accent?: string; name: string; preview: Preview | null; size?: number }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!preview || preview.type !== 'sprite' || !canvas.current || !preview.frame) return;
    const img = new Image();
    const c = canvas.current;
    img.onload = () => {
      const { width, height } = preview.frame!;
      c.width = width;
      c.height = height;
      const g = c.getContext('2d');
      if (!g) return;
      g.imageSmoothingEnabled = !preview.pixelated;
      g.clearRect(0, 0, width, height);
      g.drawImage(img, 0, 0, width, height, 0, 0, width, height);
    };
    img.onerror = () => setFailed(true);
    img.src = preview.url;
  }, [preview]);
  const cls = `${styles.media} ${preview?.pixelated ? styles.pixel : ''}`;
  let inner;
  if (!preview || failed) inner = <Avatar avatar={name.slice(0, 1)} background={accent} shape="square" size={size} />;
  else if (preview.type === 'sprite') inner = <canvas aria-label={name} className={cls} ref={canvas} role="img" />;
  else if (preview.type === 'video') inner = <video aria-label={name} className={cls} muted onError={() => setFailed(true)} preload="metadata" src={`${preview.url}#t=0.1`} />;
  else inner = <img alt={name} className={cls} onError={() => setFailed(true)} src={preview.url} />;
  return (
    <div className={styles.box} data-preview={preview?.type ?? 'none'} style={{ height: size, width: size }}>
      {inner}
    </div>
  );
};
