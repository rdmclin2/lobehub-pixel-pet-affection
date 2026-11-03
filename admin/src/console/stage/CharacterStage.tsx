import { Button, Checkbox, createStaticStyles, cssVar, DropdownMenu, Flexbox, Icon, keyframes, Text, Tooltip } from '@lobehub/ui';
import { ChevronDown, Heart, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, type Preview, type RosterRow } from '../api';
import { SpriteStage } from './SpriteStage';

/** The actions a sheet may have, in the order the stage offers them, with the words for them. */
export const ACTION_LABEL: Record<string, string> = {
  idle: '待机',
  happy: '开心',
  pat: '摸头',
  talk: '说话',
  think: '思考',
  play: '玩耍',
  look: '张望',
  walk: '散步',
  eat_cookie: '吃点心',
  sleep: '睡觉',
  sad: '委屈',
};

const floatUp = keyframes`
  0% { opacity: 0; transform: translate(-50%, 0) scale(0.6); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), -160px) scale(1.1); }
`;
const pop = keyframes`
  from { opacity: 0; transform: translate(-50%, 8px) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
`;

const styles = createStaticStyles(({ css }) => ({
  // her own colour is the light of the room: soft pools of it on the surface. Still, on purpose: an
  // endlessly drifting full-stage gradient layer kept the compositor redrawing the window every frame
  // (the console's idle GPU load doubled and clicks waited for it)
  stage: css`
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    justify-content: center;

    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  aura: css`
    pointer-events: none;
    position: absolute;
    z-index: -1;
    inset: -20%;
    background:
      radial-gradient(40% 45% at 30% 35%, color-mix(in srgb, var(--pet-accent) 34%, transparent), transparent 70%),
      radial-gradient(35% 40% at 75% 25%, color-mix(in srgb, var(--pet-accent) 20%, transparent), transparent 70%),
      radial-gradient(60% 40% at 50% 100%, color-mix(in srgb, var(--pet-accent) 26%, transparent), transparent 70%);
  `,
  floor: css`
    pointer-events: none;
    position: absolute;
    z-index: -1;
    inset-block-end: 6%;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    width: 46%;
    height: 8%;
    border-radius: 50%;

    background: color-mix(in srgb, var(--pet-accent) 30%, ${cssVar.colorFillSecondary});
    filter: blur(6px);
  `,
  hit: css`
    cursor: pointer;

    display: flex;
    align-items: flex-end;
    justify-content: center;

    margin-block-end: 4%;
    padding: 0;
    border: 0;
    border-radius: ${cssVar.borderRadiusLG};

    background: none;

    transition:
      transform 160ms ease-out,
      filter 160ms ease-out;

    /* B11 (STG-02): she answers a hover, so the tap is discoverable (M-06 缺提示 P) */
    &:hover {
      transform: translateY(-2px);
      filter: drop-shadow(0 6px 12px color-mix(in srgb, var(--pet-accent) 35%, transparent));
    }

    &:active {
      transform: scale(0.98);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 4px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;

      &:hover {
        transform: none;
      }
    }
  `,
  heart: css`
    pointer-events: none;
    position: absolute;
    inset-block-end: 40%;
    inset-inline-start: var(--x);

    color: var(--pet-accent);

    opacity: 0;

    animation: ${floatUp} 1.4s ease-out forwards;
    animation-delay: var(--delay);

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  bubble: css`
    pointer-events: none;
    position: absolute;
    inset-block-start: 8%;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    max-width: 80%;
    padding-block: 8px;
    padding-inline: 16px;
    border-radius: ${cssVar.borderRadiusLG};

    font-size: ${cssVar.fontSize};
    line-height: 1.5;
    color: ${cssVar.colorText};
    text-align: center;

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};

    animation: ${pop} 200ms ease-out;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  badge: css`
    position: absolute;
    inset-block-start: 12px;
    inset-inline-start: 12px;
  `,
  corner: css`
    position: absolute;
    inset-block-start: 12px;
    inset-inline-end: 12px;
  `,
}));

interface Burst {
  id: number;
  hearts: { delay: number; dx: number; size: number; x: number }[];
}

/**
 * B10 (STG-01, M-08「并列选项 > 7 个先分组」): the actions shown as chips; the rest are under 更多. The pet window
 * plays the same names (main ADMIN_CUES), so 「桌面上的她也做」 sends the chip there too.
 */
const COMMON_ACTIONS = ['idle', 'happy', 'pat', 'talk', 'think', 'play'];
const DESK_CUES = new Set(['look', 'happy', 'pat', 'sad', 'sleep', 'eat_cookie', 'think', 'talk', 'play', 'walk', 'idle']);
const PAT_TIP_SEEN = 'pet-admin:pat-tip-seen';

/** What she says when patted: her catchphrase, or a line about what she likes. */
const reactionLines = (c: RosterRow) => {
  const name = c.met?.name ?? c.nameZh;
  const lines = [c.catchphrase, ...(c.likes ?? []).slice(0, 3).map((x) => `下次一起${x.length <= 6 ? `聊聊${x}` : '玩'}吧～`), `${name}被你摸得眯起了眼睛`].filter(Boolean);
  return lines as string[];
};

export interface CharacterStageProps {
  /** Action chips under the stage (her sheet's actions). */
  actions?: boolean;
  badge?: ReactNode;
  c: RosterRow;
  corner?: ReactNode;
  height: number;
  /** A preview to show instead of hers (trying a pack on). */
  preview?: Preview | null;
  /** Tap to pat: hearts, a line, and (if she is the pet now) the pet on the desktop answers too. */
  interactive?: boolean;
}

/**
 * Her stage: her colour as the light around her, her sheet played action by action, and the one signature
 * motion of the console — a tap sends hearts up and she answers (A-06: it explains "she noticed you").
 */
export const CharacterStage = ({ c, height, preview, interactive = true, actions = false, badge, corner }: CharacterStageProps) => {
  const pv = preview === undefined ? c.preview : preview;
  const available = Object.keys(ACTION_LABEL).filter((k) => pv?.type === 'sprite' && pv.actions?.[k]);
  const [action, setAction] = useState('idle');
  const [react, setReact] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  // 「桌面上的她也做」: only the companion on the desktop can (c.current); off by default, the stage is a preview
  const [desk, setDesk] = useState(false);
  // B11: the first pat explains once what it did (she on the desktop answered too)
  const [tip, setTip] = useState<string | null>(null);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  useEffect(() => setAction('idle'), [pv]);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  const pat = () => {
    const id = ++seq.current;
    const hearts = Array.from({ length: 6 }, (_, i) => ({ delay: i * 90, dx: Math.round((Math.random() - 0.5) * 120), size: 14 + Math.round(Math.random() * 12), x: 35 + Math.round(Math.random() * 30) }));
    setBursts((b) => [...b.slice(-2), { hearts, id }]);
    later(() => setBursts((b) => b.filter((x) => x.id !== id)), 2200);
    const r = pv?.type === 'sprite' && pv.actions?.pat ? 'pat' : 'happy';
    setReact(r);
    const lines = reactionLines(c);
    setLine(lines[Math.floor(Math.random() * lines.length)] ?? null);
    later(() => setReact(null), 1800);
    later(() => setLine(null), 2600);
    // the pet on the desktop is her: she answers there too (no pet yet / busy → nothing to say about it)
    if (c.current) api().cue('happy').catch(() => {});
    try {
      if (!localStorage.getItem(PAT_TIP_SEEN)) {
        localStorage.setItem(PAT_TIP_SEEN, '1');
        setTip(c.current ? '她感觉到了：桌面上的她也会开心一下。随时点她都可以。' : '她感觉到了。她陪你的时候，桌面上的她也会跟着开心。');
        later(() => setTip(null), 6000);
      }
    } catch {
      /* no storage: no tip */
    }
  };

  const play = (k: string) => {
    // a chosen action wins over a running reaction
    setReact(null);
    setAction(k);
    if (desk && c.current && DESK_CUES.has(k)) api().cue(k).catch(() => {});
  };

  const shown = react ?? action;
  const art = <SpriteStage accent={c.accent} action={shown} animate height={Math.round(height * 0.82)} name={c.nameZh} preview={pv} />;
  return (
    <Flexbox gap={12}>
      <div className={styles.stage} data-stage={c.id} style={{ height, ['--pet-accent' as string]: c.accent }}>
        <div className={styles.aura} />
        <div className={styles.floor} />
        {interactive ? (
          <Tooltip title={`摸摸${c.met?.name ?? c.nameZh}`}>
            <button aria-label={`摸摸${c.met?.name ?? c.nameZh}`} className={styles.hit} data-pat={c.id} onClick={pat} type="button">
              {art}
            </button>
          </Tooltip>
        ) : (
          <div className={styles.hit}>{art}</div>
        )}
        {bursts.map((b) =>
          b.hearts.map((h, i) => (
            <span className={styles.heart} key={`${b.id}-${i}`} style={{ ['--delay' as string]: `${h.delay}ms`, ['--dx' as string]: `${h.dx}px`, ['--x' as string]: `${h.x}%` }}>
              <Icon fill="currentColor" icon={Heart} size={h.size} />
            </span>
          )),
        )}
        {line && (
          <div className={styles.bubble} data-reaction role="status">
            {line}
          </div>
        )}
        {badge && <div className={styles.badge}>{badge}</div>}
        {corner && <div className={styles.corner}>{corner}</div>}
      </div>
      {tip && (
        <Text data-pat-tip fontSize={12} role="status" type="secondary">
          {tip}
        </Text>
      )}
      {actions && available.length > 1 && (
        <Flexbox align="center" data-stage-actions gap={4} horizontal wrap="wrap">
          <Text fontSize={12} style={{ marginInlineEnd: 4 }} type="secondary">
            <Icon icon={Sparkles} size={12} /> 动作
          </Text>
          {available.filter((k) => COMMON_ACTIONS.includes(k)).map((k) => (
            <Button aria-pressed={action === k} data-action-chip={k} key={k} onClick={() => play(k)} size="small" type={action === k ? 'default' : 'text'}>
              {ACTION_LABEL[k]}
            </Button>
          ))}
          {available.some((k) => !COMMON_ACTIONS.includes(k)) && (
            <DropdownMenu items={available.filter((k) => !COMMON_ACTIONS.includes(k)).map((k) => ({ key: k, label: ACTION_LABEL[k], onClick: () => play(k) }))}>
              <Button data-action-more size="small" type={available.some((k) => !COMMON_ACTIONS.includes(k) && k === action) ? 'default' : 'text'}>
                {!COMMON_ACTIONS.includes(action) && ACTION_LABEL[action] ? ACTION_LABEL[action] : '更多'}
                <Icon icon={ChevronDown} size={12} />
              </Button>
            </DropdownMenu>
          )}
          {c.current && (
            <Checkbox checked={desk} data-desk-too onChange={(v) => setDesk(v)} style={{ marginInlineStart: 'auto' }}>
              <Text fontSize={12} type="secondary">
                桌面上的她也做
              </Text>
            </Checkbox>
          )}
        </Flexbox>
      )}
    </Flexbox>
  );
};

/** `--pet-accent` for anything tinted with her colour. */
export const accentStyle = (accent: string) => ({ ['--pet-accent' as string]: accent });
