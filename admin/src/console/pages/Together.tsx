/**
 * 玩法 → 和她互动 (T-2718): what used to live in the pet window — its 话题 panel and the ⋯ menu's 动作… and
 * 回到右下角. The pet window now has one ⚙ button that opens this window.
 * 实施包 C（docs/admin-audit/02-plan.md §5.4）：C01 / SH-02 / TOG-02 聊天记录并入聊天页（HistoryPage 下线，`#/history` 由
 * A00 重定向到 `#/chat`）；C10 / TOG-03「聊聊」按钮 loading，结果出来只给一条 toast；C11 / TOG-04「找回桌宠」只留这一处
 * （统一调 placePet），「退出」移到 关于与数据；未唤醒用共享 NoPet（A11 / TOG-05）。
 */
import { Button, Flexbox, Tag, Text, toast } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { Lock, MessageCircle, MoveDownRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api, reasonText, type TopicRow } from '../api';
import { NoPet } from '../common';
import { ACTION_LABEL } from '../stage/CharacterStage';
import { useStore } from '../store';

const Header = ({ page }: { page: string }) => {
  const { schema } = useStore();
  const p = schema.pages[page];
  return <PageHeader description={p?.description} title={p?.title ?? page} />;
};

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
        <NoPet what="话题" />
      </>
    );
  const groups: { items: TopicRow[]; name: string; stage: string }[] = [];
  for (const t of topics) {
    let g = groups.find((x) => x.stage === t.stage);
    if (!g) groups.push((g = { items: [], name: t.stageName, stage: t.stage }));
    g.items.push(t);
  }
  const open = topics.filter((t) => !t.locked).length;
  // C10 / TOG-03: the button shows 进行中 while she talks on the desktop; one toast once the result is in (K-05)
  const talk = async (t: TopicRow) => {
    setBusy(t.id);
    try {
      const r = await api().talkTopic(t.id);
      if (r && r.ok === false)
        toast.error({
          description: r.reason === 'locked' ? `还没解锁：${r.condition ?? t.condition}` : `${reasonText(r)}。等她说完再点一次。`,
          title: `没能聊「${t.label}」`,
        });
      else toast.success(`${view.pet.name}在桌面上聊了「${t.label}」`);
    } catch (e) {
      toast.error({ description: String((e as Error)?.message ?? e), title: `没能聊「${t.label}」` });
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

// ---- 桌面上的她 ---------------------------------------------------------------------------------------------
/** The old ⋯ → 动作… list, in its order. */
const CUES = ['look', 'turn', 'walk', 'happy', 'pat', 'play', 'think', 'sad', 'evolve'];
const CUE_LABEL: Record<string, string> = { ...ACTION_LABEL, evolve: '闪亮登场', look: '东张西望', pat: '害羞', think: '想事情', turn: '转身', walk: '走两步' };

export const DeskPage = () => {
  const { view } = useStore();
  const [cue, setCue] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const pet = !!view?.pet;
  if (!pet)
    return (
      <>
        <Header page="desk" />
        <NoPet what="让她做动作、找回她" />
      </>
    );
  return (
    <>
      <Header page="desk" />
      <Surface description="她在桌面上马上做这个动作（她正在说话时会稍后再试）。" title="动作">
        <Flexbox data-cues gap={8} horizontal wrap="wrap">
          {CUES.map((c) => (
            <Button
              data-cue={c}
              disabled={!!cue && cue !== c}
              key={c}
              loading={cue === c}
              onClick={async () => {
                setCue(c);
                try {
                  const r = await api().cue(c);
                  if (r.ok) toast.success(`她：${CUE_LABEL[c] ?? c}`);
                  else toast.error({ description: reasonText(r), title: `她没能${CUE_LABEL[c] ?? c}` });
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
      {/* C11 / TOG-04: the one 找回桌宠 (was here as 回到右下角 and on 桌宠行为 as 找回桌宠); 退出 is in 关于与数据 */}
      <Surface description="她被窗口挡住、跑到屏幕外、走远了，或者换了显示器找不到时：让她出现并回到主屏幕右下角。" title="找回桌宠">
        <div>
          <Button
            data-place-pet
            icon={MoveDownRight}
            loading={placing}
            onClick={async () => {
              setPlacing(true);
              try {
                const r = await api().placePet();
                if (r && r.ok) toast.success('她回到右下角了');
                else toast.error({ description: reasonText(r), title: '没能找回桌宠' });
              } finally {
                setPlacing(false);
              }
            }}
          >
            找回桌宠
          </Button>
        </div>
      </Surface>
    </>
  );
};
