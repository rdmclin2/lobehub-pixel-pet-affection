/**
 * 玩法 → 和她一起 (T-2718): what used to live in the pet window — its 话题 panel and the ⋯ menu's 聊天记录,
 * 动作…, 回到右下角 and 退出. The pet window now has one ⚙ button that opens this window.
 */
import { Block, Button, Flexbox, Tag, Text, toast } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { ArrowLeft, Lock, LogOut, MessageCircle, MoveDownRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api, reasonText, type HistorySession, type HistorySummary, type TopicRow } from '../api';
import { ask } from '../fields';
import { ACTION_LABEL } from '../stage/CharacterStage';
import { useStore } from '../store';

const Header = ({ page }: { page: string }) => {
  const { schema } = useStore();
  const p = schema.pages[page];
  return <PageHeader description={p?.description} title={p?.title ?? page} />;
};

const NoPet = () => (
  <Surface>
    <Text type="secondary">还没有唤醒桌宠：先在桌宠窗口里选一位角色并唤醒她。</Text>
  </Surface>
);

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { day: '2-digit', hour: '2-digit', hour12: false, minute: '2-digit', month: '2-digit' }) : '--');

// ---- 话题 ---------------------------------------------------------------------------------------------------
export const TopicsPage = () => {
  const { view } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  // what was new when the page opened keeps its 新 tag while here; main forgets it right away (markSeen)
  const fresh = useRef<Set<string> | null>(null);
  const topics: TopicRow[] = view?.topics ?? [];
  if (view && fresh.current === null) fresh.current = new Set(topics.filter((t) => t.isNew).map((t) => t.id));
  useEffect(() => {
    if (fresh.current?.size) api().markSeen('topic').catch(() => {});
  }, []);
  if (!view?.pet)
    return (
      <>
        <Header page="topics" />
        <NoPet />
      </>
    );
  const groups: { items: TopicRow[]; name: string; stage: string }[] = [];
  for (const t of topics) {
    let g = groups.find((x) => x.stage === t.stage);
    if (!g) groups.push((g = { items: [], name: t.stageName, stage: t.stage }));
    g.items.push(t);
  }
  const open = topics.filter((t) => !t.locked).length;
  const talk = async (t: TopicRow) => {
    setBusy(t.id);
    toast.info(`${view.pet.name}在桌面上开始聊「${t.label}」了`);
    try {
      const r = await api().talkTopic(t.id);
      if (r && r.ok === false) toast.error(r.reason === 'locked' ? `「${t.label}」还没解锁：${r.condition ?? t.condition}` : reasonText(r));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Header page="topics" />
      <Text data-topics-summary type="secondary">
        {view.pet.name} · 已解锁 {open} / {topics.length} 个话题
      </Text>
      {groups.map((g) => (
        <Surface description={g.items[0].locked ? (g.items[0].condition ?? undefined) : undefined} key={g.stage} title={g.name}>
          <Flexbox data-topic-group={g.stage} gap={8}>
            {g.items.map((t) => (
              <Flexbox align="center" data-locked={t.locked} data-topic={t.id} gap={12} horizontal justify="space-between" key={t.id}>
                <Flexbox align="center" gap={6} horizontal style={{ minWidth: 0 }} wrap="wrap">
                  <Text strong={!t.locked} type={t.locked ? 'secondary' : undefined}>
                    {t.label}
                  </Text>
                  {t.rating === 'adult' && <Tag size="small">成人向</Tag>}
                  {fresh.current?.has(t.id) && (
                    <Tag color="error" size="small">
                      新
                    </Tag>
                  )}
                  <Text fontSize={12} type="secondary">
                    {t.locked ? t.condition : t.talkedToday ? '今天聊过了（不再加好感）' : ''}
                  </Text>
                </Flexbox>
                <Button disabled={t.locked || (!!busy && busy !== t.id)} icon={t.locked ? Lock : MessageCircle} loading={busy === t.id} onClick={() => talk(t)} size="small">
                  聊聊
                </Button>
              </Flexbox>
            ))}
          </Flexbox>
        </Surface>
      ))}
    </>
  );
};

// ---- 聊天记录 -----------------------------------------------------------------------------------------------
export const HistoryPage = () => {
  const { view } = useStore();
  const [list, setList] = useState<HistorySummary[] | null>(null);
  const [open, setOpen] = useState<HistorySession | null>(null);
  // a new message from the pet window (view changes) refreshes the list / the open conversation
  const turn = view?.pet ? `${view.pet.lastInteractionAt ?? ''}:${view.pet.speciesId}` : '';
  useEffect(() => {
    api().historyList().then((r) => setList(r.sessions ?? []), () => setList([]));
  }, [turn]);
  const show = async (id: string) => {
    const r = await api().historyGet(id);
    if (r.ok && r.session) setOpen(r.session);
    else toast.error(reasonText(r));
  };
  if (open)
    return (
      <>
        <PageHeader description={`${fmt(open.startedAt)} – ${fmt(open.endedAt)} · ${open.count} 条`} title={`聊天记录 · ${open.name}`} />
        <Flexbox gap={12}>
          <div>
            <Button data-history-back icon={ArrowLeft} onClick={() => setOpen(null)} size="small">
              返回列表
            </Button>
          </div>
          <Flexbox data-history-thread={open.id} gap={8}>
            {open.messages.map((m, i) => (
              <Block
                data-role={m.role}
                key={`${m.at}-${i}`}
                padding={12}
                style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}
                variant={m.role === 'user' ? 'filled' : 'outlined'}
              >
                <Text fontSize={12} type="secondary">
                  {m.role === 'user' ? '我' : open.name} · {fmt(m.at)}
                </Text>
                <Text data-history-text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} type={m.status ? 'secondary' : undefined}>
                  {m.status ? (m.status === 'canceled' ? '（这句被打断了，她没有回复）' : '（出错了，她没有回复）') : m.text || ''}
                </Text>
                {m.attachments && (m.attachments.images || m.attachments.files?.length) ? (
                  <Text fontSize={12} type="secondary">
                    {[m.attachments.images ? `📷 ${m.attachments.images} 张图片` : '', ...(m.attachments.files ?? []).map((f) => `📄 ${f}`)].filter(Boolean).join('  ')}
                  </Text>
                ) : null}
              </Block>
            ))}
          </Flexbox>
        </Flexbox>
      </>
    );
  return (
    <>
      <Header page="history" />
      <Surface description={list?.length ? `${list.length} 段你主动发起的聊天 · 最新的在最上面` : undefined} title="对话">
        {list === null ? (
          <Text type="secondary">读取中…</Text>
        ) : !list.length ? (
          <Flexbox data-history-empty gap={4}>
            <Text strong>还没有你主动发起的聊天</Text>
            <Text fontSize={12} type="secondary">
              在桌宠窗口点「聊天」和她说句话，这里就会记下来。她自己搭话、问候、被摸或被喂时说的话不算在内。
            </Text>
          </Flexbox>
        ) : (
          <Flexbox data-history-list gap={8}>
            {list.map((s) => (
              <Block clickable data-session={s.id} gap={4} key={s.id} onClick={() => show(s.id)} padding={12} variant="outlined">
                <Flexbox gap={8} horizontal>
                  <Text data-history-time fontSize={12} type="secondary">
                    {fmt(s.startedAt)}
                  </Text>
                  <Text data-history-who fontSize={12}>
                    {s.name}
                  </Text>
                  <Text data-history-count fontSize={12} style={{ marginInlineStart: 'auto' }} type="secondary">
                    {s.count} 条
                  </Text>
                </Flexbox>
                <Text data-history-preview ellipsis>
                  {s.preview || '（空消息）'}
                </Text>
              </Block>
            ))}
          </Flexbox>
        )}
      </Surface>
    </>
  );
};

// ---- 桌面上的她 ---------------------------------------------------------------------------------------------
/** The old ⋯ → 动作… list, in its order. */
const CUES = ['look', 'turn', 'walk', 'happy', 'pat', 'play', 'think', 'sad', 'evolve'];
const CUE_LABEL: Record<string, string> = { ...ACTION_LABEL, evolve: '闪亮登场', look: '东张西望', pat: '害羞', think: '想事情', turn: '转身', walk: '走两步' };

export const DeskPage = () => {
  const { view } = useStore();
  const [cue, setCue] = useState<string | null>(null);
  const pet = !!view?.pet;
  return (
    <>
      <Header page="desk" />
      <Surface description="她在桌面上马上做这个动作（她正在说话时会稍后再试）。" title="动作">
        <Flexbox data-cues gap={8} horizontal wrap="wrap">
          {CUES.map((c) => (
            <Button
              data-cue={c}
              disabled={!pet}
              key={c}
              loading={cue === c}
              onClick={async () => {
                setCue(c);
                try {
                  const r = await api().cue(c);
                  if (r.ok) toast.success(`她：${CUE_LABEL[c] ?? c}`);
                  else toast.error(reasonText(r));
                } finally {
                  setCue(null);
                }
              }}
              size="small"
            >
              {CUE_LABEL[c] ?? c}
            </Button>
          ))}
        </Flexbox>
      </Surface>
      <Surface description="她被拖走、扔飞或走远了：让她回到屏幕右下角。" title="位置">
        <div>
          <Button
            data-desk-home
            disabled={!pet}
            icon={MoveDownRight}
            onClick={async () => {
              const r = await api().home();
              if (r.ok) toast.success('她回到右下角了');
              else toast.error(reasonText(r));
            }}
          >
            回到右下角
          </Button>
        </div>
      </Surface>
      <Surface description="关掉桌宠和这个设置窗口。进度和设置都已保存，下次打开接着来。" title="退出">
        <div>
          <Button
            danger
            data-desk-quit
            icon={LogOut}
            onClick={async () => {
              if (!(await ask('退出桌宠？', '桌宠和设置窗口都会关闭。进度和设置都已保存。', '退出', true))) return;
              await api().quit();
            }}
          >
            退出
          </Button>
        </div>
      </Surface>
    </>
  );
};
