/** 玩法 / 设置: a hub of tiles, one per page below it, each with what that page is set to right now. */
import { Block, createStaticStyles, cssVar, Flexbox, Icon, Progress, Tag, Text } from '@lobehub/ui';
import { PageHeader } from '@lobehub/ui/dashboard';
import { ChevronRight } from 'lucide-react';

import { ICONS } from '../icons';
import { CharacterStage } from '../stage/CharacterStage';
import { useStore } from '../store';

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  `,
  big: css`
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  `,
  icon: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 40px;
    height: 40px;
    border-radius: ${cssVar.borderRadiusLG};

    color: var(--pet-accent);

    background: color-mix(in srgb, var(--pet-accent) 14%, ${cssVar.colorFillQuaternary});
  `,
  status: css`
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 24px;
    align-items: center;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    @media (width <= 760px) {
      grid-template-columns: 1fr;
    }
  `,
  link: css`
    color: inherit;
    text-decoration: none;
  `,
}));

const yes = (b: unknown) => (b ? '开' : '关');

/** One line on what a page is set to now (empty when there is nothing short to say). */
const useStatus = () => {
  const { settings, apiStatus, update, version, view, packs } = useStore();
  const p = settings.prefs ?? {};
  const visitors = Array.isArray(settings.visitors) ? settings.visitors.length : 0;
  const theme: Record<string, string> = { auto: '跟随系统', light: '亮色', dark: '暗色' };
  return (page: string): string =>
    ({
      behavior: `大小 ${Math.round((settings.petScale ?? 1) * 100)}% · 走动 ${yes(p.roam)} · 梗图 ${yes(p.memes)}`,
      proactive: settings.proactive?.enabled ? `主动搭话：每 ${settings.proactive.speakCooldownMin} 分钟至多一次` : '主动搭话：关',
      visitors: visitors ? `${visitors} 位伙伴在桌面上` : '还没有邀请伙伴',
      tts: `朗读 ${yes(p.voice)}${settings.tts?.engine ? ` · ${settings.tts.engine}` : ''}`,
      asr: `语音输入 ${yes(settings.asr?.enabled)}`,
      voicepacks: `${(settings.ttsStatus?.packs ?? []).length} 个语音包`,
      packs: `${packs.length} 个角色包（导入 ${packs.filter((x) => x.source === 'user').length} 个）`,
      appearance: theme[settings.ui?.theme ?? 'auto'] ?? '跟随系统',
      connection: view?.space ? (view.space.personal ? '个人空间' : view.space.name) : '还没唤醒',
      api: apiStatus?.listening ? `监听中 127.0.0.1:${apiStatus.port}` : `对外接口 ${yes(settings.api?.enabled)}`,
      safety: settings.adultContent ? '成人向内容：开' : '成人向内容：关',
      update: `v${version}${update?.status === 'ready' ? ' · 新版本已就绪' : ''}`,
      about: '数据目录、系统选项、素材署名',
      topics: view?.topics ? `已解锁 ${view.topics.filter((t: any) => !t.locked).length} / ${view.topics.length} 个${view.topics.some((t: any) => t.isNew) ? ' · 有新话题' : ''}` : '',
      history: '你主动发起的聊天',
      desk: '动作 · 回到右下角 · 退出',
      dances: !view?.pet ? '' : view.look?.kind === 'vrm' ? `她现在是 VRM 外观，可以跳舞 · 音乐音量 ${p.danceVolume ?? 60}%` : '她现在不是 VRM 外观，跳不了舞',
    })[page] ?? '';
};

const level = (v: number) => (v >= 60 ? 'success' : v >= 30 ? 'normal' : 'exception');

/** 玩法's head: how she is doing right now (mood, food, energy), next to her on a small stage. */
const PetStatus = () => {
  const { roster, view } = useStore();
  const cur = roster.find((c) => c.current);
  const pet = view?.pet;
  if (!cur || !pet) return null;
  const bars = [
    { key: 'mood', label: '心情', value: Math.round(pet.mood ?? 0) },
    { key: 'food', label: '饱腹', value: Math.round(100 - (pet.hunger ?? 0)) },
    { key: 'energy', label: '精力', value: Math.round(pet.energy ?? 0) },
  ];
  return (
    <div className={styles.status} data-pet-status>
      <CharacterStage c={cur} height={220} />
      <Flexbox gap={12}>
        <Flexbox align="center" gap={8} horizontal>
          <Text fontSize={18} strong>
            {cur.met?.name ?? cur.nameZh}现在
          </Text>
          <Tag color={pet.sleeping ? 'processing' : 'success'}>{pet.sleeping ? '睡着了' : '醒着'}</Tag>
        </Flexbox>
        {bars.map((b) => (
          <Flexbox align="center" data-stat={b.key} gap={12} horizontal key={b.key}>
            <Text style={{ flex: 'none', width: 40 }} type="secondary">
              {b.label}
            </Text>
            <Progress percent={b.value} showInfo={false} size="small" status={level(b.value)} style={{ flex: 1 }} />
            <Text style={{ flex: 'none', textAlign: 'end', width: 32 }}>{b.value}</Text>
          </Flexbox>
        ))}
        <Text fontSize={12} type="secondary">
          喂食、陪玩和哄睡在桌宠窗口里进行；下面这些决定她在桌面上怎么陪你。
        </Text>
      </Flexbox>
    </div>
  );
};

export const HubPage = ({ place }: { place: 'play' | 'settings' }) => {
  const { schema } = useStore();
  const status = useStatus();
  const page = schema.pages[place];
  const groups = schema.nav.filter((g) => g.section === place);
  return (
    <>
      <PageHeader description={page?.description} title={page?.title ?? place} />
      {place === 'play' && <PetStatus />}
      {groups.map((g) => (
        <Flexbox data-hub-group={g.key} gap={12} key={g.key} style={{ marginBlockEnd: 16 }}>
          {groups.length > 1 && (
            <Text as="h2" fontSize={16} strong style={{ margin: 0 }}>
              {g.label}
            </Text>
          )}
          <div className={`${styles.grid} ${place === 'play' ? styles.big : ''}`}>
            {g.items.map((i) => (
              <a className={styles.link} data-tile={i.page} href={`#/${i.page}`} key={i.page}>
                <Block clickable gap={12} horizontal padding={place === 'play' ? 20 : 16} style={{ alignItems: 'flex-start', height: '100%' }} variant="outlined">
                  <div className={styles.icon}>
                    <Icon icon={ICONS[i.icon]} size={20} />
                  </div>
                  <Flexbox flex={1} gap={4} style={{ minWidth: 0 }}>
                    <Flexbox align="center" horizontal justify="space-between">
                      <Text data-tile-title strong>
                        {schema.pages[i.page]?.title ?? i.label}
                      </Text>
                      <Icon icon={ChevronRight} size={16} />
                    </Flexbox>
                    <Text fontSize={12} type="secondary">
                      {schema.pages[i.page]?.description}
                    </Text>
                    {status(i.page) && (
                      <Text data-tile-status fontSize={12} style={{ marginBlockStart: 4 }}>
                        {status(i.page)}
                      </Text>
                    )}
                  </Flexbox>
                </Block>
              </a>
            ))}
          </div>
        </Flexbox>
      ))}
    </>
  );
};
