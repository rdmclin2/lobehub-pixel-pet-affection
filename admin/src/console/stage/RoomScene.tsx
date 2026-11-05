/**
 * 房间小游戏 (docs/room.md): her room drawn as a picture with its furniture as hotspots, her sprite where the
 * activity happens, and what the activity changes in the room (the light, the monitor, the record, the TV, the
 * phone). The room's colours are the theme's art palette (`--room-*` from src/core/room.js), used inside the
 * picture only; everything around it is product UI.
 */
import { createStaticStyles, cssVar, cx, Icon, keyframes } from '@lobehub/ui';
import { BedDouble, Disc3, Gamepad2, Laptop, Moon, Music, Smartphone, Sparkles, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

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
  0% { transform: scaleX(0); }
  85%, 100% { transform: scaleX(1); }
`;
const caret = keyframes`
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
`;
const scroll = keyframes`
  to { background-position-x: -24px; }
`;
const hop = keyframes`
  0%, 55%, 100% { transform: translateY(0); }
  25% { transform: translateY(-120%); }
`;
const coin = keyframes`
  from { inset-inline-start: 100%; }
  to { inset-inline-start: -12%; }
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
  // 工作: the monitor's screen as a page being written, one line after another (the round's progress)
  monitor: css`
    overflow: hidden;
    border-radius: 2px;
    background: var(--room-base);
    box-shadow: 0 0 14px 4px color-mix(in srgb, var(--room-accent) 70%, transparent);

    &[data-on='true'] {
      animation: none;
    }
  `,
  // the page inside the screen; insets in % of the screen (padding in % would follow the whole room's width)
  page: css`
    position: absolute;
    inset-block: 12%;
    inset-inline: 9%;

    display: flex;
    flex-direction: column;
    justify-content: space-between;
  `,
  pageHead: css`
    flex: none;
    width: 45%;
    height: 10%;
    border-radius: 1px;
    background: var(--room-accent);
  `,
  codeLine: css`
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;

    width: var(--w);
    height: 9%;
  `,
  ink: css`
    flex: 1;
    align-self: stretch;
    transform-origin: left center;
    border-radius: 1px;
    background: var(--room-primary);

    [data-typing='true'] > & {
      animation: ${type} 1.6s steps(8) infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      [data-typing='true'] > & {
        animation: none;
      }
    }
  `,
  caret: css`
    flex: none;
    align-self: stretch;
    width: 2px;
    background: var(--room-accent);
    animation: ${caret} 0.8s steps(1) infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  // 打游戏: a little side-scroller on the TV — the whale hops over coins, the bar on top is the level so far
  tv: css`
    overflow: hidden;
    background: linear-gradient(180deg, color-mix(in srgb, var(--room-accent) 55%, var(--room-base)), var(--room-base) 70%);
    box-shadow: 0 0 18px 6px color-mix(in srgb, var(--room-accent) 75%, transparent);

    &[data-on='true'] {
      animation: none;
    }
  `,
  hud: css`
    position: absolute;
    inset-block-start: 7%;
    inset-inline: 8%;

    overflow: hidden;

    height: 6%;
    border-radius: 2px;

    background: color-mix(in srgb, var(--room-primary) 25%, transparent);
  `,
  hudFill: css`
    height: 100%;
    background: var(--room-trim);
  `,
  ground: css`
    position: absolute;
    inset-block-end: 0;
    inset-inline: 0;

    height: 22%;

    background: repeating-linear-gradient(90deg, var(--room-primary) 0 12px, color-mix(in srgb, var(--room-primary) 75%, var(--room-accent)) 12px 24px);
    animation: ${scroll} 0.6s linear infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  hero: css`
    position: absolute;
    inset-block-end: 22%;
    inset-inline-start: 22%;

    width: 16%;
    height: 18%;
    border-radius: 50% 50% 40% 40%;

    background: var(--room-primary);
    box-shadow: inset 0 -3px 0 var(--room-base);

    animation: ${hop} 1.2s ease-in-out infinite;

    &::after {
      content: '';

      position: absolute;
      inset-block-start: 30%;
      inset-inline-end: 22%;

      width: 18%;
      height: 22%;
      border-radius: 50%;

      background: var(--room-base);
    }

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  coin: css`
    position: absolute;
    inset-block-end: 30%;

    width: 9%;
    aspect-ratio: 1;
    border: 1px solid var(--room-primary);
    border-radius: 50%;

    background: var(--room-trim);

    animation: ${coin} 2.4s linear infinite;
    animation-delay: var(--delay);

    @media (prefers-reduced-motion: reduce) {
      inset-inline-start: 60%;
      animation: none;
    }
  `,
  // 听音乐: the record lies flat on the player, so it is a squashed disc that turns (the sheen shows it)
  record: css`
    pointer-events: none;
    position: absolute;
    opacity: 0;
    transition: opacity 300ms ease-out;

    &[data-on='true'] {
      opacity: 1;
    }
  `,
  squash: css`
    position: absolute;
    inset-block-start: 50%;
    inset-inline-start: 0;
    width: 100%;
    aspect-ratio: 1;
  `,
  disc: css`
    position: absolute;
    inset: 0;
    border-radius: 50%;

    background:
      conic-gradient(from 0deg, transparent 0 20%, color-mix(in srgb, var(--room-base) 45%, transparent) 25%, transparent 30% 70%, color-mix(in srgb, var(--room-base) 45%, transparent) 75%, transparent 80%),
      repeating-radial-gradient(circle, var(--room-primary) 0 2px, color-mix(in srgb, var(--room-primary) 70%, var(--room-accent)) 2px 4px);

    &::after {
      content: '';
      position: absolute;
      inset: 38%;
      border-radius: 50%;
      background: var(--room-accent);
    }

    [data-on='true'] > * > & {
      animation: ${spin} 1.8s linear infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      [data-on='true'] > * > & {
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
  // the hotspots' labels: one layer above her, so she never hides one (the hotspot buttons stay under her)
  chip: css`
    pointer-events: none;
    position: absolute;
    transform: translate(-50%, calc(-100% - 4px));

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

    &[data-at='top'] {
      transform: translate(-50%, 4px);
    }

    &[data-active='true'] {
      color: var(--room-base);
      background: var(--room-primary);
    }

    &[data-disabled='true'] {
      color: color-mix(in srgb, var(--room-primary) 70%, transparent);
      background: color-mix(in srgb, var(--room-base) 80%, transparent);
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
  // 睡觉: tucked in — only her head and shoulders, the blanket and the foot of the bed are drawn over the rest
  tucked: css`
    pointer-events: none;
    position: absolute;
    transform: translateX(-50%);
    overflow: hidden;
  `,
  breathe: css`
    animation: ${breathe} 3s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  // 睡觉: the cover over the mattress (lace on its edge, a bow) and the foot of the bed in front of her
  bedLayer: css`
    pointer-events: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
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

/** 工作: how many lines of the page are written at `progress` of the round (the last one is being typed). */
export const WORK_LINES = 5;
export const typedLines = (progress: number) => Math.min(WORK_LINES, Math.floor(progress * WORK_LINES));
const LINE_W = [0.92, 0.7, 0.84, 0.58, 0.76];

// Her sheet's frame (dafeiyu-pixel: 664 × 904): the top of her hair, her chin and where her body is across the
// frame, as fractions. Used to tuck her in (only the head shows) and to keep her line above her head.
const HAIR_TOP = 0.19;
const CHIN = 0.42;
const TUCK_SHOWN = 0.45;

/** The room's art palette as CSS variables (data, not product tokens). */
export const roomVars = (t: RoomTheme) => ({
  ['--room-accent' as string]: t.palette.accent,
  ['--room-base' as string]: t.palette.base,
  ['--room-primary' as string]: t.palette.primary,
  ['--room-trim' as string]: t.palette.trim,
});

const points = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(' ');

/** 睡觉: the cover tucked over the mattress and the foot of the bed redrawn in front of her (picture pixels). */
const BedCover = ({ theme, src }: { src: string; theme: RoomTheme }) => {
  const id = useId().replaceAll(':', '');
  const bed = theme.bed!;
  const { width, height } = theme.art!;
  const [[x0, top], [x1]] = bed.blanket;
  const r = 9;
  const scallops = Array.from({ length: Math.floor((x1 - x0) / (r * 2)) }, (_, i) => x0 + r + i * r * 2);
  const [bx, by] = bed.bow ?? [(x0 + x1) / 2, top + 14];
  return (
    <svg aria-hidden className={styles.bedLayer} data-room-prop="blanket" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <clipPath id={`${id}-front`}>
          {bed.front.map((f, i) => (
            <polygon key={i} points={points(f)} />
          ))}
        </clipPath>
        <linearGradient id={`${id}-cover`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--room-base)" />
          <stop offset="0.35" stopColor="color-mix(in srgb, var(--room-accent) 35%, var(--room-base))" />
          <stop offset="1" stopColor="color-mix(in srgb, var(--room-accent) 60%, var(--room-base))" />
        </linearGradient>
        <radialGradient cx="0.5" cy="0.35" id={`${id}-rise`} r="0.6">
          <stop offset="0" stopColor="var(--room-base)" stopOpacity="0.7" />
          <stop offset="1" stopColor="var(--room-base)" stopOpacity="0" />
        </radialGradient>
        <pattern height="36" id={`${id}-dots`} patternUnits="userSpaceOnUse" width="36">
          <circle cx="9" cy="9" fill="var(--room-base)" opacity="0.8" r="3.5" />
          <circle cx="27" cy="27" fill="var(--room-base)" opacity="0.8" r="3.5" />
        </pattern>
      </defs>
      {/* in the room's night light like the bed around it (a little brighter: it is what she sleeps under) */}
      <g style={{ filter: 'brightness(0.84)' }}>
        <polygon data-room-cover fill={`url(#${id}-cover)`} points={points(bed.blanket)} />
        <polygon fill={`url(#${id}-dots)`} points={points(bed.blanket)} />
        {/* her under the cover: a soft rise from her shoulders towards the foot of the bed */}
        <ellipse cx={(x0 + x1) / 2 + 150} cy={top + 62} fill={`url(#${id}-rise)`} rx="70" ry="52" />
        {/* the turned-down lace edge */}
        <rect fill="var(--room-base)" height="22" width={x1 - x0} x={x0} y={top - 10} />
        {scallops.map((cx) => (
          <circle cx={cx} cy={top + 12} fill="var(--room-base)" key={cx} r={r} />
        ))}
        {scallops.map((cx) => (
          <circle cx={cx} cy={top + 1} fill="color-mix(in srgb, var(--room-accent) 55%, var(--room-base))" key={`e${cx}`} r="3" />
        ))}
        {/* the bow on the lace */}
        <g fill="var(--room-primary)" transform={`translate(${bx} ${by})`}>
          <path d="M0 0 C -22 -22 -48 -16 -46 0 C -48 16 -22 22 0 0 Z" />
          <path d="M0 0 C 22 -22 48 -16 46 0 C 48 16 22 22 0 0 Z" />
          <path d="M -4 4 L -16 34 L -6 30 L 0 38 Z" />
          <path d="M 4 4 L 16 34 L 6 30 L 0 38 Z" />
          <circle fill="var(--room-trim)" r="7" />
        </g>
      </g>
      {/* the foot posts and the footboard stay in front of her and the cover, in the same night light */}
      <g clipPath={`url(#${id}-front)`}>
        <image height={height} href={src} preserveAspectRatio="none" width={width} />
        <rect fill="var(--room-primary)" height={height} opacity="0.42" width={width} />
      </g>
    </svg>
  );
};

/** 工作: the page on the monitor — the lines written so far, the one being typed with a caret. */
const MonitorPage = ({ progress }: { progress: number }) => {
  const done = typedLines(progress);
  // every row keeps its place (an empty one is not written yet), so the page fills from the top down
  return (
    <div className={styles.page}>
      <div className={styles.pageHead} />
      {LINE_W.map((w, i) => (
        <div className={styles.codeLine} data-typing={i === done} key={i} style={{ ['--w' as string]: `${w * 100}%`, visibility: i <= done ? 'visible' : 'hidden' }}>
          <div className={styles.ink} />
          {i === done && <div className={styles.caret} />}
        </div>
      ))}
    </div>
  );
};

/** 打游戏: the game on the TV — the level bar (the round so far), the whale hopping, coins coming. */
const TvGame = ({ progress }: { progress: number }) => (
  <>
    <div className={styles.hud}>
      <div className={styles.hudFill} data-room-level={Math.round(progress * 100)} style={{ width: `${Math.max(4, progress * 100)}%` }} />
    </div>
    <div className={styles.coin} style={{ ['--delay' as string]: '0s' }} />
    <div className={styles.coin} style={{ ['--delay' as string]: '1.2s' }} />
    <div className={styles.hero} />
    <div className={styles.ground} />
  </>
);

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
  /** how far the running round is (0..1): the lines on the monitor, the level on the TV */
  progress?: number;
  /** read-only (not met yet): hotspots do nothing */
  readOnly?: boolean;
  theme: RoomTheme;
}

export const RoomScene = ({ theme, activities, current, line, name, preview, onHotspot, disabled = {}, readOnly, progress = 0 }: RoomSceneProps) => {
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
  const src = `../renderer/${art.background}`;
  const spots = theme.spots ?? {};
  const spot = spots[current ?? 'idle'] ?? spots.idle ?? { h: 46, x: 50, y: 90 };
  const props = theme.props ?? {};
  const act = activities.find((a) => a.id === current) ?? null;
  const herH = Math.max(40, Math.round((h * spot.h) / 100));
  const ratio = preview?.type === 'sprite' && preview.frame ? preview.frame.width / preview.frame.height : 0.73;
  const herW = Math.round(herH * ratio);
  const tucked = !!spot.tucked && current === 'sleep' && !!theme.bed;
  const fx = (icon: LucideIcon | 'zzz', n: number, size: number, at: { x: number; y: number }) =>
    Array.from({ length: n }, (_, i) => (
      <span className={styles.fx} data-room-fx={current} key={i} style={{ insetBlockStart: `${at.y}%`, insetInlineStart: `${at.x + i * 2.5}%`, ['--delay' as string]: `${i * 0.7}s`, ['--dx' as string]: `${(i % 2 ? 1 : -1) * (10 + i * 6)}px` }}>
        {icon === 'zzz' ? <span className={styles.zzz}>Z</span> : <Icon fill="currentColor" icon={icon} size={size} />}
      </span>
    ));
  // the top of her hair, % of the picture: tucked in, her chin is on the blanket's edge
  const headY = tucked ? spot.y - spot.h * (CHIN - HAIR_TOP) : spot.y - spot.h * (1 - HAIR_TOP);
  const bubbleAt = spot.bubble ?? { x: Math.min(80, Math.max(18, spot.x)), y: Math.max(14, headY - 1) };
  const rec = props.record;
  return (
    <div className={styles.scene} data-room-scene={theme.id} data-room-activity={current ?? 'idle'} ref={ref} style={{ ...roomVars(theme), aspectRatio: `${art.width} / ${art.height}` }}>
      <img alt={`${theme.name}：${theme.motifs.join('、')}`} className={styles.bg} draggable={false} src={src} />
      {props.monitor && (
        <div className={cx(styles.glow, styles.monitor)} data-on={current === 'work'} data-room-prop="monitor" data-room-typed={current === 'work' ? typedLines(progress) : undefined} style={box(props.monitor)}>
          {current === 'work' && <MonitorPage progress={progress} />}
        </div>
      )}
      {props.tv && (
        <div className={cx(styles.glow, styles.tv)} data-on={current === 'game'} data-room-prop="tv" style={box(props.tv)}>
          {current === 'game' && <TvGame progress={progress} />}
        </div>
      )}
      {rec && (
        <div className={styles.record} data-on={current === 'music'} data-room-prop="record" style={box(rec)}>
          <div className={styles.squash} style={{ transform: `translateY(-50%) scaleY(${((rec.h * art.height) / (rec.w * art.width)).toFixed(3)})` }}>
            <div className={styles.disc} />
          </div>
        </div>
      )}
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
          />
        );
      })}
      {tucked ? (
        <div className={styles.tucked} data-room-her="sleep" data-tucked style={{ height: Math.round(herH * TUCK_SHOWN), insetBlockStart: `calc(${spot.y}% - ${Math.round(herH * CHIN)}px)`, insetInlineStart: `${spot.x}%`, width: herW }}>
          <div className={styles.breathe}>{h > 0 && <SpriteStage action={act?.action ?? 'sleep'} height={herH} name={name} preview={preview} />}</div>
        </div>
      ) : (
        <div className={styles.her} data-room-her={current ?? 'idle'} style={{ insetBlockStart: `${spot.y}%`, insetInlineStart: `${spot.x}%` }}>
          <div className={current === 'sleep' ? styles.breathe : undefined}>{h > 0 && <SpriteStage action={act?.action ?? 'idle'} height={herH} name={name} preview={preview} />}</div>
        </div>
      )}
      {tucked && <BedCover src={src} theme={theme} />}
      {current === 'phone' && (
        <div className={cx(styles.phone, styles.phoneLit, styles.heldPhone)} data-room-prop="held-phone" style={{ height: herH * 0.11, insetBlockStart: `calc(${spot.y}% - ${herH * 0.5}px)`, insetInlineStart: `calc(${spot.x}% + ${herH * 0.04}px)`, width: herH * 0.07 }} />
      )}
      {activities.map((a) => {
        const hs = theme.hotspots?.[a.hotspot];
        if (!hs) return null;
        const why = disabled[a.id];
        const on = current === a.id;
        return (
          <span
            className={styles.chip}
            data-active={on}
            data-at={hs.chip ?? 'bottom'}
            data-disabled={!!why && !on}
            data-room-chip={a.id}
            key={a.id}
            style={{ insetBlockStart: `${hs.chip === 'top' ? hs.y : hs.y + hs.h}%`, insetInlineStart: `${hs.x + hs.w / 2}%` }}
          >
            <Icon icon={ACTIVITY_ICON[a.id] ?? Sparkles} size={12} />
            {on ? `${a.label}中` : why ? `${a.label} · 太累了` : a.label}
          </span>
        );
      })}
      {current === 'sleep' && fx('zzz', 3, 18, { x: spot.x + 3, y: headY - 2 })}
      {current === 'music' && fx(Music, 3, 18, { x: (props.record?.x ?? spot.x) + 1, y: (props.record?.y ?? 40) - 4 })}
      {current === 'game' && fx(Star, 3, 14, { x: (props.tv?.x ?? spot.x) + 1, y: (props.tv?.y ?? 30) + 2 })}
      {current === 'work' && fx(Sparkles, 2, 14, { x: (props.monitor?.x ?? spot.x) + 2, y: (props.monitor?.y ?? 30) })}
      {current === 'phone' && fx(Star, 2, 12, { x: spot.x + 2, y: spot.y - spot.h * 0.6 })}
      {line && (
        <div className={styles.bubble} data-room-line role="status" style={{ insetBlockStart: `${bubbleAt.y}%`, insetInlineStart: `${bubbleAt.x}%` }}>
          {line}
        </div>
      )}
    </div>
  );
};
