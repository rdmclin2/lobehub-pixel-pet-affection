/**
 * 房间小游戏 (docs/room.md): her room drawn as a picture with its furniture as hotspots, her sprite where the
 * activity happens, and what the activity changes in the room (the light, the monitor, the record, the TV, the
 * phone). The room's colours are the theme's art palette (`--room-*` from src/core/room.js), used inside the
 * picture only; everything around it is product UI.
 */
import { createStaticStyles, cssVar, cx, Icon, keyframes } from '@lobehub/ui';
import { BedDouble, Disc3, Gamepad2, Laptop, Moon, Music, Smartphone, Sparkles, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { Preview, RoomActivity, RoomBox, RoomTheme } from '../api';
import { SpriteStage } from './SpriteStage';

export const ACTIVITY_ICON: Record<string, LucideIcon> = { sleep: BedDouble, work: Laptop, phone: Smartphone, music: Disc3, game: Gamepad2 };

const spin = keyframes`
  to { transform: rotate(360deg); }
`;
const rise = keyframes`
  0% { opacity: 0; transform: translate(0, 0) scale(0.7); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--dx), -90px) scale(1.15); }
`;
const blink = keyframes`
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
`;
const type = keyframes`
  0% { transform: scaleX(0.15); }
  100% { transform: scaleX(1); }
`;
const breathe = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
`;

const styles = createStaticStyles(({ css }) => ({
  scene: css`
    position: relative;
    overflow: hidden;
    width: 100%;
    border-radius: ${cssVar.borderRadiusLG};
    background: var(--room-accent);
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  bg: css`
    pointer-events: none;
    user-select: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
  // 睡觉: the room goes dark blue, a moon and stars come out
  night: css`
    pointer-events: none;
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--room-primary) 42%, transparent);
    opacity: 0;
    transition: opacity 600ms ease-out;

    &[data-on='true'] {
      opacity: 1;
    }
  `,
  sky: css`
    pointer-events: none;
    position: absolute;
    inset-block-start: 10%;
    inset-inline-start: 41%;
    color: var(--room-trim);
    opacity: 0;
    transition: opacity 600ms ease-out;

    &[data-on='true'] {
      opacity: 1;
    }
  `,
  glow: css`
    pointer-events: none;
    position: absolute;
    border-radius: 4px;
    opacity: 0;
    transition: opacity 300ms ease-out;

    &[data-on='true'] {
      opacity: 1;
      animation: ${blink} 1.6s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      &[data-on='true'] {
        animation: none;
      }
    }
  `,
  monitor: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 12%;
    justify-content: center;

    padding-inline: 10%;

    background: color-mix(in srgb, var(--room-base) 82%, var(--room-accent));
    box-shadow: 0 0 18px 6px color-mix(in srgb, var(--room-accent) 70%, transparent);
  `,
  codeLine: css`
    transform-origin: left center;
    height: 9%;
    border-radius: 2px;
    background: var(--room-primary);
    animation: ${type} 1.2s steps(6) infinite alternate;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  tv: css`
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--room-accent) 80%, transparent), transparent 60%),
      color-mix(in srgb, var(--room-trim) 55%, var(--room-base));
    box-shadow: 0 0 22px 8px color-mix(in srgb, var(--room-accent) 75%, transparent);
  `,
  record: css`
    pointer-events: none;
    position: absolute;
    border-radius: 50%;
    background: repeating-radial-gradient(circle, var(--room-primary) 0 2px, color-mix(in srgb, var(--room-primary) 70%, var(--room-accent)) 2px 4px);
    opacity: 0;
    transition: opacity 300ms ease-out;

    &::after {
      content: '';
      position: absolute;
      inset: 38%;
      border-radius: 50%;
      background: var(--room-accent);
    }

    &[data-on='true'] {
      opacity: 1;
      animation: ${spin} 1.8s linear infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      &[data-on='true'] {
        animation: none;
      }
    }
  `,
  phone: css`
    pointer-events: none;
    position: absolute;
    border: 2px solid var(--room-primary);
    border-radius: 3px;
    background: color-mix(in srgb, var(--room-accent) 40%, var(--room-base));
    box-shadow: 0 1px 2px color-mix(in srgb, var(--room-primary) 50%, transparent);
  `,
  phoneLit: css`
    background: var(--room-base);
    box-shadow: 0 0 10px 3px color-mix(in srgb, var(--room-accent) 80%, transparent);
  `,
  hotspot: css`
    cursor: pointer;

    position: absolute;

    padding: 0;
    border: 2px dashed transparent;
    border-radius: ${cssVar.borderRadiusLG};

    background: transparent;

    transition:
      border-color 150ms ease-out,
      background-color 150ms ease-out;

    &:hover,
    &:focus-visible {
      border-color: var(--room-base);
      background: color-mix(in srgb, var(--room-base) 18%, transparent);
      outline: none;
    }

    &[data-active='true'] {
      border-style: solid;
      border-color: var(--room-accent);
      background: color-mix(in srgb, var(--room-accent) 14%, transparent);
    }

    &:disabled {
      cursor: not-allowed;
    }
  `,
  chip: css`
    pointer-events: none;
    position: absolute;
    inset-block-end: 4px;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    display: inline-flex;
    gap: 4px;
    align-items: center;

    padding-block: 2px;
    padding-inline: 8px;
    border: 1px solid color-mix(in srgb, var(--room-primary) 30%, transparent);
    border-radius: 999px;

    font-size: ${cssVar.fontSizeSM};
    line-height: 20px;
    color: var(--room-primary);
    white-space: nowrap;

    background: color-mix(in srgb, var(--room-base) 92%, transparent);
    box-shadow: ${cssVar.boxShadowTertiary};

    [data-active='true'] > & {
      color: var(--room-base);
      background: var(--room-primary);
    }

    button:disabled > & {
      opacity: 0.6;
    }
  `,
  her: css`
    pointer-events: none;
    position: absolute;
    transform: translate(-50%, -100%);
    transition:
      inset-inline-start 500ms ease-out,
      inset-block-start 500ms ease-out;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  herLying: css`
    transform: translate(-50%, -50%) rotate(-90deg);
  `,
  breathe: css`
    animation: ${breathe} 3s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  // 睡觉: a lace-trimmed blanket over her, in the bed's colours
  blanket: css`
    pointer-events: none;
    position: absolute;
    border-block-start: 6px double var(--room-base);
    border-radius: 18px 18px 8px 8px;
    background:
      radial-gradient(circle at 25% 40%, color-mix(in srgb, var(--room-base) 70%, transparent) 0 3px, transparent 4px) 0 0 / 18px 18px,
      linear-gradient(180deg, color-mix(in srgb, var(--room-accent) 70%, var(--room-base)), color-mix(in srgb, var(--room-primary) 55%, var(--room-accent)));
    box-shadow: 0 2px 6px color-mix(in srgb, var(--room-primary) 45%, transparent);
  `,
  heldPhone: css`
    pointer-events: none;
    position: absolute;
    transform: translate(-50%, -50%) rotate(-8deg);
  `,
  fx: css`
    pointer-events: none;
    position: absolute;
    color: var(--room-base);
    filter: drop-shadow(0 1px 1px color-mix(in srgb, var(--room-primary) 80%, transparent));
    opacity: 0;
    animation: ${rise} 2.4s ease-out infinite;
    animation-delay: var(--delay);

    @media (prefers-reduced-motion: reduce) {
      opacity: 1;
      animation: none;
    }
  `,
  zzz: css`
    font-size: 22px;
    font-weight: 700;
    color: var(--room-base);
  `,
  bubble: css`
    pointer-events: none;
    position: absolute;
    transform: translate(-50%, -100%);

    max-width: 36%;
    padding-block: 6px;
    padding-inline: 12px;
    border: 1px solid color-mix(in srgb, var(--room-accent) 50%, transparent);
    border-radius: ${cssVar.borderRadiusLG};

    font-size: ${cssVar.fontSize};
    line-height: 1.5;
    color: ${cssVar.colorText};
    text-align: center;

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
}));

const box = (b: RoomBox) => ({ height: `${b.h}%`, insetBlockStart: `${b.y}%`, insetInlineStart: `${b.x}%`, width: `${b.w}%` });

/** The room's art palette as CSS variables (data, not product tokens). */
export const roomVars = (t: RoomTheme) => ({
  ['--room-accent' as string]: t.palette.accent,
  ['--room-base' as string]: t.palette.base,
  ['--room-primary' as string]: t.palette.primary,
  ['--room-trim' as string]: t.palette.trim,
});

export interface RoomSceneProps {
  activities: RoomActivity[];
  /** the running activity, or null (she stands on the rug) */
  current: string | null;
  /** kinds that cannot start now (too tired), with why */
  disabled?: Record<string, string>;
  line: string | null;
  name: string;
  onHotspot: (kind: string) => void;
  preview: Preview | null | undefined;
  /** read-only (not met yet): hotspots do nothing */
  readOnly?: boolean;
  theme: RoomTheme;
}

export const RoomScene = ({ theme, activities, current, line, name, preview, onHotspot, disabled = {}, readOnly }: RoomSceneProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setH(Math.round(e.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const art = theme.art!;
  const spots = theme.spots ?? {};
  const spot = spots[current ?? 'idle'] ?? spots.idle ?? { h: 46, x: 50, y: 90 };
  const props = theme.props ?? {};
  const act = activities.find((a) => a.id === current) ?? null;
  const herH = Math.max(40, Math.round((h * spot.h) / 100));
  // the sheet's frame ratio: where her hand is, and the blanket's size when she lies down
  const ratio = preview?.type === 'sprite' && preview.frame ? preview.frame.width / preview.frame.height : 0.73;
  const herW = Math.round(herH * ratio);
  const fx = (icon: LucideIcon | 'zzz', n: number, size: number, at: { x: number; y: number }) =>
    Array.from({ length: n }, (_, i) => (
      <span className={styles.fx} data-room-fx={current} key={i} style={{ insetBlockStart: `${at.y}%`, insetInlineStart: `${at.x + i * 2.5}%`, ['--delay' as string]: `${i * 0.7}s`, ['--dx' as string]: `${(i % 2 ? 1 : -1) * (10 + i * 6)}px` }}>
        {icon === 'zzz' ? <span className={styles.zzz}>Z</span> : <Icon fill="currentColor" icon={icon} size={size} />}
      </span>
    ));
  const headY = spot.lying ? spot.y - 16 : spot.y - spot.h - 2;
  const headX = spot.lying ? spot.x + 10 : spot.x;
  return (
    <div className={styles.scene} data-room-scene={theme.id} data-room-activity={current ?? 'idle'} ref={ref} style={{ ...roomVars(theme), aspectRatio: `${art.width} / ${art.height}` }}>
      <img alt={`${theme.name}：${theme.motifs.join('、')}`} className={styles.bg} draggable={false} src={`../renderer/${art.background}`} />
      {props.monitor && (
        <div className={cx(styles.glow, styles.monitor)} data-on={current === 'work'} data-room-prop="monitor" style={box(props.monitor)}>
          {[0.8, 0.55, 0.7].map((w, i) => (
            <div className={styles.codeLine} key={i} style={{ animationDelay: `${i * 0.3}s`, width: `${w * 100}%` }} />
          ))}
        </div>
      )}
      {props.tv && <div className={cx(styles.glow, styles.tv)} data-on={current === 'game'} data-room-prop="tv" style={box(props.tv)} />}
      {props.record && <div className={styles.record} data-on={current === 'music'} data-room-prop="record" style={box(props.record)} />}
      {props.phone && current !== 'phone' && <div className={styles.phone} data-room-prop="phone" style={box(props.phone)} />}
      <div className={styles.night} data-on={current === 'sleep'} data-room-prop="night" />
      <div className={styles.sky} data-on={current === 'sleep'}>
        <Icon fill="currentColor" icon={Moon} size={28} />
        <Icon fill="currentColor" icon={Star} size={12} style={{ marginInlineStart: 12 }} />
      </div>
      {activities.map((a) => {
        const hs = theme.hotspots?.[a.hotspot];
        if (!hs) return null;
        const why = disabled[a.id];
        return (
          <button
            aria-label={`${a.label}（${hs.label}）${why ? `：${why}` : ''}`}
            aria-pressed={current === a.id}
            className={styles.hotspot}
            data-active={current === a.id}
            data-hotspot={a.id}
            disabled={readOnly || (!!why && current !== a.id)}
            key={a.id}
            onClick={() => onHotspot(a.id)}
            style={box(hs)}
            title={why ?? `${hs.label}：${current === a.id ? `正在${a.label}，再点一下结束` : a.verb}`}
            type="button"
          >
            <span className={styles.chip}>
              <Icon icon={ACTIVITY_ICON[a.id] ?? Sparkles} size={12} />
              {current === a.id ? `${a.label}中` : a.label}
            </span>
          </button>
        );
      })}
      <div className={cx(styles.her, spot.lying && styles.herLying)} data-room-her={current ?? 'idle'} style={{ insetBlockStart: `${spot.y}%`, insetInlineStart: `${spot.x}%` }}>
        <div className={current === 'sleep' ? styles.breathe : undefined}>
          {h > 0 && <SpriteStage action={act?.action ?? 'idle'} height={herH} name={name} preview={preview} />}
        </div>
      </div>
      {current === 'sleep' && spot.lying && (
        <div className={styles.blanket} data-room-prop="blanket" style={{ height: herW * 0.42, insetBlockStart: `calc(${spot.y}% - ${herW * 0.2}px)`, insetInlineStart: `calc(${spot.x}% - ${herH * 0.12}px)`, width: herH * 0.58 }} />
      )}
      {current === 'phone' && (
        <div className={cx(styles.phone, styles.phoneLit, styles.heldPhone)} data-room-prop="held-phone" style={{ height: herH * 0.11, insetBlockStart: `calc(${spot.y}% - ${herH * 0.5}px)`, insetInlineStart: `calc(${spot.x}% + ${herH * 0.04}px)`, width: herH * 0.07 }} />
      )}
      {current === 'sleep' && fx('zzz', 3, 18, { x: spot.lying ? spot.x - 8 : headX + 1, y: spot.lying ? spot.y - 10 : headY - 4 })}
      {current === 'music' && fx(Music, 3, 18, { x: (props.record?.x ?? spot.x) + 1, y: (props.record?.y ?? 40) - 4 })}
      {current === 'game' && fx(Star, 3, 14, { x: (props.tv?.x ?? spot.x) - 1, y: (props.tv?.y ?? 30) + 4 })}
      {current === 'work' && fx(Sparkles, 2, 14, { x: (props.monitor?.x ?? spot.x) + 2, y: (props.monitor?.y ?? 30) })}
      {current === 'phone' && fx(Star, 2, 12, { x: spot.x + 2, y: spot.y - spot.h * 0.6 })}
      {line && (
        <div className={styles.bubble} data-room-line role="status" style={{ insetBlockStart: `${Math.max(14, headY)}%`, insetInlineStart: `${Math.min(80, Math.max(18, headX))}%` }}>
          {line}
        </div>
      )}
    </div>
  );
};
