/**
 * 窗外的天色 (docs/room.md §5): what is outside her window at this hour and in this weather, drawn over the room
 * picture in its own pixels (theme.sky). The glass is the picture again under the full colour grade of the hour
 * × the weather (the same grade as 像素小院, core/game-sky.js gradeMatrix); over it the sun or the moon, the
 * stars, clouds, rain, snow, fog and lightning. The room itself gets part of the grade (core/room-sky.js inside:
 * `filter: url(#<id>-in)` on the picture, her and the bed) and its lamps glow at night. Room art, not product
 * UI: colours are the painted sky's, not interface tokens.
 */
import { createStaticStyles, keyframes } from '@lobehub/ui';

import GameSky, { type Grade } from '../../../../src/core/game-sky.js';
import RoomSky from '../../../../src/core/room-sky.js';
import type { RoomTheme } from '../api';

const drift = keyframes`
  from { transform: translateX(-190px); }
  to { transform: translateX(190px); }
`;
const fall = keyframes`
  from { transform: translate(0, 0); }
  to { transform: translate(-24px, 80px); }
`;
const flake = keyframes`
  from { transform: translate(0, 0); }
  to { transform: translate(-20px, 120px); }
`;
const twinkle = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;
const flash = keyframes`
  0%, 88%, 100% { opacity: 0; }
  89% { opacity: 0.9; }
  90% { opacity: 0.15; }
  91.5% { opacity: 0.75; }
  94% { opacity: 0; }
`;

const styles = createStaticStyles(({ css }) => ({
  layer: css`
    pointer-events: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  `,
  cloud: css`
    animation: ${drift} var(--dur) linear infinite;
    animation-delay: var(--delay);

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  rain: css`
    animation: ${fall} 0.45s linear infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  snow: css`
    animation: ${flake} 4s linear infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  star: css`
    animation: ${twinkle} 2.6s ease-in-out infinite;
    animation-delay: var(--delay);

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  flash: css`
    opacity: 0;
    animation: ${flash} 7s linear infinite;

    @media (prefers-reduced-motion: reduce) {
      display: none;
    }
  `,
  lamp: css`
    mix-blend-mode: screen;
  `,
}));

const matrix = (g: { lift: number; mul: number[]; sat: number }) =>
  GameSky.gradeMatrix(g)
    .map((v) => v.toFixed(4))
    .join(' ');
const rgb = (base: number[], mul: number[]) => `rgb(${base.map((v, i) => Math.round(Math.max(0, Math.min(255, v * mul[i])))).join(' ')})`;

// clouds across the glass: their middle (picture px), size and how long one crossing takes
// (the glass is 236 px wide and a cloud drifts 380 px, so five spread over their crossings keep a few in sight)
const CLOUDS = [
  { dur: 46, phase: 0.1, s: 1.4, x: 0, y: 262 },
  { dur: 58, phase: 0.55, s: 1.1, x: 40, y: 318 },
  { dur: 52, phase: 0.3, s: 1.6, x: -30, y: 392 },
  { dur: 64, phase: 0.8, s: 1.2, x: 20, y: 236 },
  { dur: 50, phase: 0.95, s: 1.3, x: -10, y: 350 },
];
const STARS = [
  [776, 268],
  [812, 236],
  [858, 254],
  [902, 226],
  [944, 270],
  [790, 330],
  [928, 318],
  [866, 302],
];

// the sky's colours as CSS variables (theme data, not product tokens)
const skyVars = (c: NonNullable<RoomTheme['sky']>['colors']) => ({
  ['--sky-moon' as string]: c.moon,
  ['--sky-rain' as string]: c.rain,
  ['--sky-snow-edge' as string]: c.snowEdge,
  ['--sky-star' as string]: c.star,
  ['--sky-sun' as string]: c.sun,
  ['--sky-sun-low' as string]: c.sunLow,
});

const Cloud = ({ fill, s }: { fill: string; s: number }) => (
  <g fill={fill} transform={`scale(${s})`}>
    <ellipse cx="0" cy="8" rx="58" ry="18" />
    <circle cx="-26" cy="-2" r="22" />
    <circle cx="6" cy="-12" r="28" />
    <circle cx="34" cy="0" r="20" />
  </g>
);

export interface RoomWindowProps {
  grade: Grade;
  hour: number;
  /** the base of the filter ids: `<id>-in` (the room) and `<id>-out` (outside) */
  id: string;
  src: string;
  theme: RoomTheme;
}

export const RoomWindow = ({ theme, grade, hour, id, src }: RoomWindowProps) => {
  const sky = theme.sky!;
  const { width, height } = theme.art!;
  const { x0, x1, spring, bottom } = sky.window;
  const r = (x1 - x0) / 2;
  const top = spring - r;
  const w = grade.weather;
  const glass = `M ${x0} ${bottom} L ${x0} ${spring} A ${r} ${r} 0 0 1 ${x1} ${spring} L ${x1} ${bottom} Z`;
  const b = RoomSky.body(hour);
  const bx = x0 + 30 + b.u * (x1 - x0 - 60);
  const by = bottom - 110 - b.up * (bottom - 110 - top - 40);
  const veil = (1 - w.clouds * 0.75) * (1 - w.fog * 0.8);
  const bodyOn = Math.min(1, b.up * 5) * veil;
  const low = b.up < 0.35;
  const stars = RoomSky.stars(grade);
  const cloudFill = rgb([240 - 80 * w.rain, 243 - 76 * w.rain, 250 - 64 * w.rain], grade.mul);
  const ins = RoomSky.inside(grade);
  return (
    <svg
      aria-hidden
      className={styles.layer}
      data-room-prop="window"
      data-room-body={b.kind}
      data-room-glass-box={`${x0},${top},${x1},${bottom}`}
      data-room-lights={grade.lights.toFixed(2)}
      data-room-stars={stars.toFixed(2)}
      preserveAspectRatio="none"
      style={skyVars(sky.colors)}
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <filter colorInterpolationFilters="sRGB" id={`${id}-out`}>
          <feColorMatrix type="matrix" values={matrix(grade)} />
        </filter>
        <filter colorInterpolationFilters="sRGB" id={`${id}-in`}>
          <feColorMatrix type="matrix" values={matrix(ins)} />
        </filter>
        <clipPath id={`${id}-glass`}>
          <path d={glass} />
        </clipPath>
        {/* the window shows at about a third of the picture's size: strokes and flakes are drawn thick */}
        <pattern height="80" id={`${id}-rain`} patternUnits="userSpaceOnUse" width="24">
          <line stroke="var(--sky-rain)" strokeLinecap="round" strokeWidth="4" x1="22" x2="10" y1="2" y2="42" />
          <line stroke="var(--sky-rain)" strokeLinecap="round" strokeOpacity="0.75" strokeWidth="3" x1="9" x2="1" y1="50" y2="76" />
        </pattern>
        <pattern height="120" id={`${id}-snow`} patternUnits="userSpaceOnUse" width="80">
          <g fill="white" stroke="var(--sky-snow-edge)" strokeWidth="2">
            <rect height="12" width="12" x="8" y="10" />
            <rect height="9" width="9" x="50" y="34" />
            <rect height="10" width="10" x="26" y="72" />
            <rect height="8" width="8" x="64" y="96" />
          </g>
        </pattern>
        <radialGradient id={`${id}-lamp`}>
          <stop offset="0" stopColor="var(--room-trim)" stopOpacity="0.95" />
          <stop offset="0.35" stopColor="var(--room-trim)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--room-trim)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-sun`}>
          <stop offset="0" stopColor={low ? 'var(--sky-sun-low)' : 'var(--sky-sun)'} stopOpacity="0.8" />
          <stop offset="1" stopColor={low ? 'var(--sky-sun-low)' : 'var(--sky-sun)'} stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-crescent`}>
          <circle cx={bx} cy={by} fill="white" r="17" />
          <circle cx={bx + 8} cy={by - 5} fill="black" r="15" />
        </mask>
      </defs>

      <g clipPath={`url(#${id}-glass)`} data-room-glass>
        <image filter={`url(#${id}-out)`} height={height} href={src} preserveAspectRatio="none" width={width} />
        <g data-room-stars-layer opacity={stars}>
          {STARS.map(([x, y], i) => (
            <rect className={styles.star} fill="var(--sky-star)" height="4" key={i} style={{ ['--delay' as string]: `${i * 0.37}s` }} width="4" x={x} y={y} />
          ))}
        </g>
        {b.kind === 'sun' ? (
          <g data-room-sun opacity={bodyOn}>
            <circle cx={bx} cy={by} fill={`url(#${id}-sun)`} r="60" />
            <circle cx={bx} cy={by} fill={low ? 'var(--sky-sun-low)' : 'var(--sky-sun)'} r="18" />
          </g>
        ) : (
          <g data-room-moon opacity={bodyOn}>
            <circle cx={bx} cy={by} fill="var(--sky-moon)" opacity="0.18" r="40" />
            <circle cx={bx} cy={by} fill="var(--sky-moon)" mask={`url(#${id}-crescent)`} r="17" />
          </g>
        )}
        <g data-room-clouds opacity={w.clouds}>
          {CLOUDS.map((c, i) => (
            <g key={i} transform={`translate(${(x0 + x1) / 2 + c.x} ${c.y})`}>
              <g className={styles.cloud} style={{ ['--delay' as string]: `${-c.dur * c.phase}s`, ['--dur' as string]: `${c.dur}s` }}>
                <Cloud fill={cloudFill} s={c.s} />
              </g>
            </g>
          ))}
        </g>
        {w.rain > 0.01 && (
          <g data-room-rain opacity={Math.min(1, w.rain * 1.2)}>
            <rect className={styles.rain} fill={`url(#${id}-rain)`} height={bottom - top + 160} width={x1 - x0 + 120} x={x0 - 40} y={top - 120} />
          </g>
        )}
        {w.snow > 0.01 && (
          <g data-room-snow opacity={w.snow}>
            <rect className={styles.snow} fill={`url(#${id}-snow)`} height={bottom - top + 240} width={x1 - x0 + 120} x={x0 - 40} y={top - 160} />
          </g>
        )}
        {w.fog > 0.01 && <rect data-room-fog fill={rgb([236, 240, 246], grade.mul)} height={bottom - top} opacity={Math.min(0.85, w.fog * 1.3)} width={x1 - x0} x={x0} y={top} />}
        {w.flash > 0.01 && (
          <g opacity={w.flash}>
            <rect className={styles.flash} data-room-flash fill="white" height={bottom - top} width={x1 - x0} x={x0} y={top} />
          </g>
        )}
      </g>

      {/* the room's lamps: off by day, on at dusk and at night (and earlier in dark rain) */}
      <g data-room-lamps opacity={grade.lights * 0.9}>
        {sky.lamps.map((l, i) => (
          <circle className={styles.lamp} cx={l.x} cy={l.y} fill={`url(#${id}-lamp)`} key={i} r={l.r} />
        ))}
      </g>
      {/* lightning lights the room a little too */}
      {w.flash > 0.01 && (
        <g opacity={w.flash * 0.22}>
          <rect className={styles.flash} fill="white" height={height} width={width} />
        </g>
      )}
    </svg>
  );
};

/** The card's name for a moment: 「黄昏 18:30」 */
export const skyLabel = (hour: number) => `${GameSky.phaseName(GameSky.phaseOf(hour))} ${GameSky.formatHour(hour)}`;
