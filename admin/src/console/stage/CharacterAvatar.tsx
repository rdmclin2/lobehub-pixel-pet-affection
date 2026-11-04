import { createStaticStyles, cssVar, cx } from '@lobehub/ui';
import { memo, useState } from 'react';

import type { Preview } from '../api';
import { SpriteStage } from './SpriteStage';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    overflow: hidden;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    border-radius: 50%;

    background: ${cssVar.colorFillTertiary};
  `,
  img: css`
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
  // not met yet: a greyed face (her drawn avatar has its own background, so the black silhouette of a sprite
  // would only be a dark disc)
  stranger: css`
    opacity: 0.45;
    filter: grayscale(1);
  `,
}));

/**
 * A character's face for lists and chat bubbles (T-2839): her drawn avatar (`avatar`, core/roster.js) when she has
 * one, else a still of her look shrunk into the circle (an imported VRM / Live2D picture is usually a bust already).
 */
export const CharacterAvatar = memo(
  ({ avatar, className, name, preview, silhouette = false, size = 40 }: { avatar?: string | null; className?: string; name: string; preview: Preview | null; silhouette?: boolean; size?: number }) => {
    const [failed, setFailed] = useState<string | null>(null);
    const face = avatar && failed !== avatar ? avatar : null;
    return (
      <span className={cx(styles.root, className)} data-avatar={face ? 'face' : 'look'} style={{ height: size, width: size }}>
        {face ? (
          <img alt={name} className={cx(styles.img, silhouette && styles.stranger)} decoding="async" draggable={false} onError={() => setFailed(face)} src={face} />
        ) : (
          <SpriteStage animate={false} height={size} name={name} preview={preview} silhouette={silhouette} />
        )}
      </span>
    );
  },
);
CharacterAvatar.displayName = 'CharacterAvatar';

/** The owner's face: the LobeHub account's avatar (a data: URL from main). `onFail`: it cannot be shown (the page then
 * goes back to the generic person icon, with its own background). */
export const UserAvatar = memo(({ name, onFail, size = 32, src }: { name: string; onFail: () => void; size?: number; src: string }) => (
  <span className={styles.root} data-user-avatar style={{ height: size, width: size }}>
    <img alt={name} className={styles.img} decoding="async" draggable={false} onError={onFail} src={src} />
  </span>
));
UserAvatar.displayName = 'UserAvatar';
