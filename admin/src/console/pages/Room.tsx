/**
 * 小屋 → 她的房间 (docs/room.md): the room picker (one room per default character), her room with its five
 * activities, and what they do to her numbers. State lives in main (src/main/room-service.js); this page only
 * shows it and counts a round down.
 */
import { Alert, Block, Button, createStaticStyles, cssVar, Flexbox, Icon, Progress, Tag, Text, toast } from '@lobehub/ui';
import { Clock3, DoorOpen, Lock, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api, type RoomResult, type RoomSettled, type RoomState, type RoomTheme, type RosterRow } from '../api';
import { ACTIVITY_ICON, RoomScene, roomVars } from '../stage/RoomScene';
import { SpriteStage } from '../stage/SpriteStage';
import { useStore } from '../store';

const styles = createStaticStyles(({ css }) => ({
  picker: css`
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;

    @media (width <= 900px) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  `,
  pick: css`
    &[aria-selected='true'] {
      border-color: var(--room-primary);
      box-shadow: 0 0 0 1px var(--room-primary);
    }
  `,
  swatches: css`
    display: flex;
    gap: 4px;
  `,
  swatch: css`
    width: 12px;
    height: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 50%;
  `,
  layout: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: 16px;
    align-items: start;

    @media (width <= 1000px) {
      grid-template-columns: 1fr;
    }
  `,
  preview: css`
    position: relative;
    overflow: hidden;
    display: flex;
    gap: 24px;
    align-items: flex-end;

    aspect-ratio: 21 / 8;
    min-height: 300px;
    padding: 24px;
    border-radius: ${cssVar.borderRadiusLG};

    background:
      radial-gradient(60% 80% at 75% 30%, color-mix(in srgb, var(--room-accent) 45%, transparent), transparent 70%),
      linear-gradient(160deg, color-mix(in srgb, var(--room-base) 70%, var(--room-accent)), color-mix(in srgb, var(--room-primary) 55%, var(--room-base)));
  `,
  previewText: css`
    flex: 1;
    min-width: 0;
    padding: 16px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  acts: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `,
}));

const STAT_ORDER = ['energy', 'mood', 'focus', 'fullness'] as const;
const level = (v: number) => (v >= 60 ? 'success' : v >= 30 ? 'normal' : 'exception');
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** The pixel look of a room's character (her room shows her in her signature outfit), else any look of hers. */
const occupantOf = (roster: RosterRow[], theme: RoomTheme) => {
  const mine = roster.filter((c) => c.base === theme.character);
  const row = mine.find((c) => c.id === `${theme.character}-pixel`) ?? mine.find((c) => c.current) ?? mine[0] ?? null;
  const outfit = row?.outfits?.find((o) => o.id === (theme.outfit ?? 'daily'))?.preview;
  return { preview: outfit ?? row?.preview ?? null, row };
};

const deltaText = (s: RoomState, d: RoomSettled['deltas']) =>
  STAT_ORDER.filter((k) => d[k])
    .map((k) => `${s.stats.find((x) => x.id === k)?.label ?? k} ${signed(d[k]!)}`)
    .join('，');

/** 切换房间类型: one card per room, the open one first; a 即将开放 room can be looked at. */
const RoomPicker = ({ room, roster, onPick }: { onPick: (id: string) => void; room: RoomState; roster: RosterRow[] }) => (
  <div aria-label="房间类型" className={styles.picker} data-room-picker role="tablist">
    {room.themes.map((t) => {
      const { row, preview } = occupantOf(roster, t);
      const on = room.theme === t.id;
      return (
        <Block
          aria-selected={on}
          className={styles.pick}
          clickable
          data-room-theme={t.id}
          data-status={t.status}
          gap={8}
          horizontal
          key={t.id}
          onClick={() => onPick(t.id)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(t.id)}
          padding={8}
          role="tab"
          style={{ ...roomVars(t), alignItems: 'center' }}
          tabIndex={0}
          variant={on ? 'filled' : 'outlined'}
        >
          <SpriteStage animate={false} height={44} name={row?.nameZh ?? t.character} preview={preview} />
          <Flexbox flex={1} gap={4} style={{ minWidth: 0 }}>
            <Text ellipsis strong>
              {row?.nameZh ?? t.character}
            </Text>
            <Flexbox align="center" gap={6} horizontal>
              <div className={styles.swatches}>
                {(['primary', 'accent', 'base', 'trim'] as const).map((k) => (
                  <span className={styles.swatch} key={k} style={{ background: t.palette[k] }} />
                ))}
              </div>
              {t.status === 'open' ? (
                <Tag color="success" size="small">
                  可以玩
                </Tag>
              ) : (
                <Tag size="small">即将开放</Tag>
              )}
            </Flexbox>
          </Flexbox>
        </Block>
      );
    })}
  </div>
);

/** A room that is not open yet: its colours, who lives there and what it will have — never an empty box. */
const RoomPreview = ({ theme, roster, onBack, open }: { onBack: () => void; open: RoomTheme | undefined; roster: RosterRow[]; theme: RoomTheme }) => {
  const { row, preview } = occupantOf(roster, theme);
  return (
    <div className={styles.preview} data-room-preview={theme.id} style={roomVars(theme)}>
      <SpriteStage height={240} name={row?.nameZh ?? theme.character} preview={preview} silhouette={!row?.met} />
      <Flexbox className={styles.previewText} gap={8}>
        <Flexbox align="center" gap={8} horizontal>
          <Icon icon={Lock} size={16} />
          <Text fontSize={18} strong>
            {theme.name}
          </Text>
          <Tag color="warning">即将开放</Tag>
        </Flexbox>
        <Text type="secondary">{theme.blurb}</Text>
        <Flexbox gap={4} horizontal wrap="wrap">
          {theme.motifs.map((m) => (
            <Tag key={m}>{m}</Tag>
          ))}
        </Flexbox>
        <Text fontSize={12} type="secondary">
          这间房间还在布置中，开放后可以在这里陪{row?.nameZh ?? '她'}做同样的五件事。
        </Text>
        {open && (
          <Flexbox horizontal>
            <Button data-room-back icon={DoorOpen} onClick={onBack}>
              去{open.name}
            </Button>
          </Flexbox>
        )}
      </Flexbox>
    </div>
  );
};

export const RoomPage = () => {
  const { room: pushed, roster } = useStore();
  const [local, setLocal] = useState<RoomState | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settling = useRef(false);
  // the push from main is the source; a call's own answer shows at once (the push follows a moment later)
  const room = local ?? pushed ?? null;
  useEffect(() => setLocal(null), [pushed]);

  const theme = room?.themes.find((t) => t.id === room.theme);
  const view = room?.view ?? null;
  const running = view?.activity ?? null;
  const occupant = useMemo(() => (theme ? occupantOf(roster, theme) : null), [roster, theme]);
  const name = room?.owner.name ?? occupant?.row?.nameZh ?? '她';

  // a round counts down on screen; the full round settles in main (the same as 结束 once it is over)
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  const elapsed = running ? now - running.startedAt : 0;
  const progress = running ? Math.min(1, elapsed / running.roundMs) : 0;

  const done = (r: RoomResult, quiet = false) => {
    if (r.room) setLocal(r.room);
    if (!r.ok) {
      const why: Record<string, string> = { tired: `${name}太累了，先让她睡一觉`, soon: '这间房间还没开放', 'not-met': `还没遇见${name}` };
      toast.error(why[r.reason ?? ''] ?? '没有成功，再试一次');
      if (r.line) setLine(r.line);
      return;
    }
    if (r.settled && !quiet) {
      const act = room?.activities.find((a) => a.id === r.settled!.kind);
      const d = room ? deltaText(room, r.settled.deltas) : '';
      toast.success(`${act?.label ?? ''}${r.settled.complete ? '完成' : '结束'}${d ? `：${d}` : ''}`);
    }
    setLine(r.line ?? r.settled?.line ?? null);
  };

  useEffect(() => {
    if (!running || progress < 1 || settling.current) return;
    settling.current = true;
    api()
      .room.stop()
      .then((r) => done(r))
      .finally(() => {
        settling.current = false;
      });
  }, [progress, running]); // eslint-disable-line react-hooks/exhaustive-deps

  // while an activity runs she says one of its lines every few seconds
  useEffect(() => {
    if (!running || !theme) return;
    const lines = (theme.lines?.[running.kind] as { doing: string[] } | undefined)?.doing ?? room?.activities.find((a) => a.id === running.kind)?.lines.doing ?? [];
    if (!lines.length) return;
    let i = 0;
    const t = window.setInterval(() => setLine(lines[++i % lines.length]), 5000);
    return () => clearInterval(t);
  }, [running?.kind, running?.startedAt, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!room || !theme) return <Alert description="先在桌宠窗口里选一位角色并完成唤醒，她的房间就会出现在这里。" showIcon title="还没有唤醒桌宠" type="info" />;

  const pickTheme = (id: string) => {
    if (id === room.theme) return;
    setLine(null);
    api().room.setTheme(id).then((r) => done(r, true));
  };
  const startOrStop = (kind: string) => {
    if (running?.kind === kind) api().room.stop().then((r) => done(r));
    else api().room.start(kind).then((r) => done(r));
  };
  const tired = Object.fromEntries(room.activities.filter((a) => a.needs > 0 && (view?.stats.energy ?? 100) < a.needs).map((a) => [a.id, `${name}太累了，先睡一觉再${a.label}`]));
  const open = room.themes.find((t) => t.status === 'open');
  const act = room.activities.find((a) => a.id === running?.kind) ?? null;
  const idleLines = (theme.lines?.idle as string[] | undefined) ?? [];

  return (
    <Flexbox data-room={theme.id} gap={16}>
      <Flexbox gap={4}>
        <Text as="h1" fontSize={24} strong style={{ margin: 0 }}>
          她的房间
        </Text>
        <Text type="secondary">每位角色都有一间自己风格的房间。点房间里的家具，陪她做一件事。</Text>
      </Flexbox>
      <RoomPicker onPick={pickTheme} room={room} roster={roster} />

      {theme.status !== 'open' ? (
        <RoomPreview onBack={() => open && pickTheme(open.id)} open={open} roster={roster} theme={theme} />
      ) : (
        <div className={styles.layout}>
          <Flexbox gap={8}>
            <RoomScene activities={room.activities} current={running?.kind ?? null} disabled={tired} line={line ?? (running ? null : (idleLines[0] ?? null))} name={name} onHotspot={startOrStop} preview={occupant?.preview} readOnly={!room.owner.met} theme={theme} />
            <Flexbox align="center" gap={8} horizontal justify="space-between" wrap="wrap">
              <Text fontSize={12} type="secondary">
                {theme.name} · {theme.motifs.join(' · ')}
              </Text>
              <Text fontSize={12} type="secondary">
                点床、手机、书桌、唱片机或游戏机开始；再点一次结束
              </Text>
            </Flexbox>
          </Flexbox>

          <Flexbox gap={12}>
            {!room.owner.met && <Alert description={`在角色图鉴里换${occupant?.row?.nameZh ?? '她'}来陪你，就可以在这里陪她玩。`} showIcon title={`还没遇见${occupant?.row?.nameZh ?? '她'}`} type="info" />}
            <Block data-room-now gap={8} padding={12} variant="outlined">
              <Flexbox align="center" gap={8} horizontal justify="space-between">
                <Text strong>{act ? `正在${act.label}` : `${name}在房间里发呆`}</Text>
                {act && (
                  <Text data-room-timer type="secondary">
                    <Icon icon={Clock3} size={12} /> {fmt(elapsed)} / {fmt(running!.roundMs)}
                  </Text>
                )}
              </Flexbox>
              <Progress data-room-progress={Math.round(progress * 100)} percent={Math.round(progress * 100)} showInfo={false} size="small" />
              {act ? (
                <Button block data-room-stop icon={Square} onClick={() => api().room.stop().then((r) => done(r))}>
                  结束{act.label}
                </Button>
              ) : (
                <Text fontSize={12} type="secondary">
                  一轮 {Math.round(room.view ? room.view.roundMs / 1000 : 20)} 秒；做完一整轮效果最好，中途结束按做了多久算。
                </Text>
              )}
            </Block>

            <Block data-room-stats gap={8} padding={12} variant="outlined">
              <Text strong>{name}的状态</Text>
              {STAT_ORDER.map((k) => {
                const v = view?.stats[k] ?? 0;
                const d = view?.last?.deltas[k];
                return (
                  <Flexbox align="center" data-room-stat={k} data-value={v} gap={8} horizontal key={k}>
                    <Text style={{ flex: 'none', width: 32 }} type="secondary">
                      {room.stats.find((s) => s.id === k)?.label}
                    </Text>
                    <Progress percent={v} showInfo={false} size="small" status={level(v)} style={{ flex: 1 }} />
                    <Text style={{ flex: 'none', textAlign: 'end', width: 28 }}>{v}</Text>
                    <Text style={{ flex: 'none', textAlign: 'end', width: 28 }} type={d && d > 0 ? 'success' : d ? 'danger' : 'secondary'}>
                      {d ? signed(d) : ''}
                    </Text>
                  </Flexbox>
                );
              })}
              <Text fontSize={12} type="secondary">
                精力、心情、饱腹和桌面上的她是同一份；专注只在房间里变化。
              </Text>
            </Block>

            <Flexbox gap={8}>
              <Text strong>陪她做点什么</Text>
              <div className={styles.acts}>
                {room.activities.map((a) => (
                  <Button
                    data-room-act={a.id}
                    disabled={!room.owner.met || (!!tired[a.id] && running?.kind !== a.id)}
                    icon={ACTIVITY_ICON[a.id]}
                    key={a.id}
                    onClick={() => startOrStop(a.id)}
                    title={tired[a.id]}
                    type={running?.kind === a.id ? 'primary' : 'default'}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
              {view?.last && (
                <Text data-room-last fontSize={12} type="secondary">
                  上一件：{room.activities.find((a) => a.id === view.last!.kind)?.label}
                  {view.last.complete ? '（完成）' : `（做了 ${Math.round(view.last.fraction * 100)}%）`} {deltaText(room, view.last.deltas)}
                </Text>
              )}
            </Flexbox>
          </Flexbox>
        </div>
      )}
    </Flexbox>
  );
};
