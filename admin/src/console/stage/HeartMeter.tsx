import { createStaticStyles, cssVar, Flexbox, Icon, Text } from '@lobehub/ui';
import { Heart, Lock } from 'lucide-react';

import type { RosterRow } from '../api';

const styles = createStaticStyles(({ css }) => ({
  track: css`
    position: relative;
    height: 10px;
    border-radius: 999px;
    background: ${cssVar.colorFillSecondary};
  `,
  fill: css`
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;

    border-radius: 999px;

    background: linear-gradient(90deg, color-mix(in srgb, var(--pet-accent) 55%, ${cssVar.colorBgContainer}), var(--pet-accent));
  `,
  head: css`
    position: absolute;
    inset-block-start: 50%;
    transform: translate(-50%, -50%);

    display: flex;
    align-items: center;
    justify-content: center;

    width: 24px;
    height: 24px;
    border-radius: 50%;

    color: var(--pet-accent);

    background: ${cssVar.colorBgContainer};
    box-shadow: ${cssVar.boxShadowTertiary};
  `,
  tick: css`
    position: absolute;
    inset-block-start: 50%;
    transform: translate(-50%, -50%);

    width: 2px;
    height: 10px;

    background: ${cssVar.colorBgContainer};
  `,
  marks: css`
    position: relative;
    height: 20px;
  `,
  mark: css`
    position: absolute;
    inset-block-start: 0;
    transform: translateX(-50%);

    display: flex;
    gap: 2px;
    align-items: center;

    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
    white-space: nowrap;

    &[data-reached='true'] {
      color: ${cssVar.colorText};
    }

    &:first-child {
      transform: none;
    }
  `,
}));

export interface HeartMeterProps {
  c: RosterRow;
  /** Stage names under the track. */
  marks?: boolean;
  /** One line only (cards). */
  compact?: boolean;
}

/**
 * How close you are, as a game would show it: a heart riding a track tinted with her colour, every
 * relationship stage a milestone on it, and how much is left to the next one.
 */
export const HeartMeter = ({ c, marks = true, compact = false }: HeartMeterProps) => {
  if (!c.met) {
    return (
      // STG-03 / B12: one word for it (roster-model STATE_WORD.unmet), no second lock over the silhouette
      <Text data-heart-unmet={c.id} fontSize={12} type="secondary">
        还没见面
      </Text>
    );
  }
  const p = c.met.progress ?? {};
  const max = p.max ?? 100;
  const value = p.value ?? c.met.affection;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const stages: { id: string; min: number; name: string }[] = p.stages ?? [];
  return (
    <Flexbox data-heart-meter={c.id} gap={compact ? 6 : 8} style={{ ['--pet-accent' as string]: c.accent }}>
      <Flexbox align="baseline" gap={8} horizontal justify="space-between">
        <Flexbox align="baseline" gap={6} horizontal>
          <Text fontSize={compact ? 13 : 16} strong>
            {c.met.stage}
          </Text>
          <Text fontSize={12} type="secondary">
            好感 {value} / {max}
          </Text>
        </Flexbox>
        {!compact && (
          <Text fontSize={12} type="secondary">
            {p.next ? `离「${p.nextName}」还差 ${p.need}` : '已经是最亲密的关系'}
          </Text>
        )}
      </Flexbox>
      <div aria-label={`好感 ${value} / ${max}`} aria-valuemax={max} aria-valuemin={0} aria-valuenow={value} className={styles.track} role="meter">
        <div className={styles.fill} style={{ width: `${pct}%` }} />
        {!compact && stages.slice(1).map((s) => <span className={styles.tick} key={s.id} style={{ insetInlineStart: `${(s.min / max) * 100}%` }} />)}
        <span className={styles.head} style={{ insetInlineStart: `${pct}%` }}>
          <Icon fill="currentColor" icon={Heart} size={14} />
        </span>
      </div>
      {marks && !compact && stages.length > 0 && (
        <div className={styles.marks}>
          {stages.map((s) => (
            <span className={styles.mark} data-reached={value >= s.min} key={s.id} style={{ insetInlineStart: `${(s.min / max) * 100}%` }}>
              {value < s.min && <Icon icon={Lock} size={10} />}
              {s.name}
            </span>
          ))}
        </div>
      )}
      {!compact && typeof p.today === 'number' && (
        <Text fontSize={12} type="secondary">
          今天 +{Math.round(p.today)}
          {p.dailyCap ? ` / 上限 ${p.dailyCap}` : ''}
        </Text>
      )}
    </Flexbox>
  );
};
