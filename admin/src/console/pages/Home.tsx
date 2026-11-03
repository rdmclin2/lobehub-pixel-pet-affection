/** 小屋 (overview): her on her stage, how close you are, and today's companionship at a glance. */
import { Block, Button, createStaticStyles, cssVar, Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { Bot, ChevronRight, HeartHandshake, Mic, MessageCircleHeart, Shirt, UsersRound, Volume2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { RosterRow } from '../api';
import { NoPet } from '../common';
import { detailHref, groupRoster } from '../roster-model';
import { CharacterStage } from '../stage/CharacterStage';
import { HeartMeter } from '../stage/HeartMeter';
import { SpriteStage } from '../stage/SpriteStage';
import { useStore } from '../store';

const styles = createStaticStyles(({ css }) => ({
  hero: css`
    display: grid;
    grid-template-columns: minmax(280px, 5fr) 6fr;
    gap: 32px;
    align-items: center;

    @media (width <= 900px) {
      grid-template-columns: 1fr;
    }
  `,
  quote: css`
    margin: 0;
    padding-block: 8px;
    padding-inline: 16px;
    border-radius: ${cssVar.borderRadiusLG};

    font-size: ${cssVar.fontSizeLG};
    line-height: 1.6;
    color: ${cssVar.colorText};

    background: color-mix(in srgb, var(--pet-accent) 10%, ${cssVar.colorFillQuaternary});
  `,
  chips: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
    gap: 12px;
  `,
  chipIcon: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 36px;
    height: 36px;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorTextTertiary};

    background: ${cssVar.colorFillTertiary};

    &[data-on='true'] {
      color: var(--pet-accent);
      background: color-mix(in srgb, var(--pet-accent) 14%, transparent);
    }
  `,
  friends: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 12px;
  `,
  friendArt: css`
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    justify-content: center;

    height: 96px;
    border-radius: ${cssVar.borderRadius};

    background: color-mix(in srgb, var(--pet-accent) 12%, ${cssVar.colorFillQuaternary});
  `,
  link: css`
    color: inherit;
    text-decoration: none;
  `,
}));

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
};

/**
 * A10 (HOME-03): one card per kind of companionship, saying what it is set to (「朗读：Fish Audio」) — no 开 / 关 tag
 * dressed like a switch (P-05: switches only where they act); the icon is tinted while it is on.
 */
const Chip = ({ icon, label, on, hint, href }: { hint: string; href: string; icon: LucideIcon; label: string; on: boolean }) => (
  <a className={styles.link} data-chip={href} href={href}>
    <Block clickable gap={12} horizontal padding={12} style={{ alignItems: 'center' }} variant="outlined">
      <div className={styles.chipIcon} data-on={on}>
        <Icon icon={icon} size={18} />
      </div>
      <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
        <Text strong>{label}</Text>
        <Text data-chip-status ellipsis fontSize={12} type="secondary">
          {hint}
        </Text>
      </Flexbox>
    </Block>
  </a>
);

/** A09 (HOME-02): one card per character you have met (her best-known look), not every look. */
const Friend = ({ c, looks }: { c: RosterRow; looks: number }) => (
  <a className={styles.link} data-friend={c.id} href={detailHref(c.id)} style={{ ['--pet-accent' as string]: c.accent }}>
    <Block clickable gap={8} padding={8} variant="outlined">
      <div className={styles.friendArt}>
        <SpriteStage animate={false} height={88} name={c.nameZh} preview={c.preview} />
      </div>
      <Flexbox gap={4} paddingInline={4}>
        <Flexbox align="center" gap={4} horizontal justify="space-between">
          <Text ellipsis strong>
            {c.met?.name ?? c.nameZh}
          </Text>
          {looks > 1 && (
            <Text fontSize={12} type="secondary">
              {looks} 套形象
            </Text>
          )}
        </Flexbox>
        <HeartMeter c={c} compact />
      </Flexbox>
    </Block>
  </a>
);

const FRIENDS_MAX = 4;

export const OverviewPage = ({ navigate }: { navigate: (p: string) => void }) => {
  const { roster, settings, view } = useStore();
  const cur = roster.find((c) => c.current);
  // A09 (HOME-02, P-01 第一屏优先级): only the characters you have met, by character, at most four; the rest in 图鉴
  const met = groupRoster(roster).filter((g) => g.state === 'met');
  const friends = met.slice(0, FRIENDS_MAX).map((g) => ({ c: g.looks.find((x) => x.met) ?? g.looks[0], looks: g.looks.length }));
  const engine: Record<string, string> = { auto: '跟随角色', elevenlabs: 'ElevenLabs', fish: 'Fish Audio', local: '本地语音服务', minimax: 'MiniMax', system: '系统语音' };
  const visitors = Array.isArray(settings.visitors) ? settings.visitors.length : 0;
  const name = cur ? (cur.met?.name ?? cur.nameZh) : '';
  return (
    <>
      {cur ? (
        <div className={styles.hero} data-home-hero style={{ ['--pet-accent' as string]: cur.accent }}>
          <CharacterStage actions badge={<Tag color="success">正在陪你</Tag>} c={cur} height={400} />
          <Flexbox gap={16}>
            <Flexbox gap={4}>
              <Text type="secondary">
                {greeting()}，{name}一直在桌面上陪着你
              </Text>
              <Text as="h1" fontSize={32} strong style={{ lineHeight: 1.25, margin: 0 }}>
                {cur.displayName}
              </Text>
              <Text type="secondary">{cur.title}</Text>
            </Flexbox>
            {cur.catchphrase && <blockquote className={styles.quote}>「{cur.catchphrase}」</blockquote>}
            <HeartMeter c={cur} />
            <Flexbox gap={8} horizontal wrap="wrap">
              {/* A08 (HOME-01, W-07): each button goes to its own tab of her page — no two to the same place */}
              <Button data-go-detail icon={HeartHandshake} onClick={() => navigate(`/characters/${cur.id}/affection`)} type="primary">
                她的好感
              </Button>
              <Button data-go-looks icon={Shirt} onClick={() => navigate(`/characters/${cur.id}/looks`)}>
                换装扮
              </Button>
              <Button data-go-model icon={Bot} onClick={() => navigate(`/characters/${cur.id}/model`)}>
                调模型
              </Button>
              <Button data-go-roster onClick={() => navigate('/characters')}>
                换一位陪你
              </Button>
            </Flexbox>
            <Text fontSize={12} type="secondary">
              点她一下：她会回应你，桌面上的她也一样。
            </Text>
          </Flexbox>
        </div>
      ) : (
        // A11 (HOME-04): the same 未唤醒 state everywhere, with the way forward
        <NoPet what="她的样子、你们的关系" />
      )}

      <Flexbox gap={12} style={{ marginBlockStart: 16 }}>
        <Text as="h2" fontSize={18} strong style={{ margin: 0 }}>
          今天的陪伴
        </Text>
        <div className={styles.chips}>
          {/* A10 (HOME-03): 对外接口 is a developer setting, not companionship — it lives in 设置 → 隐私与安全 only */}
          <Chip
            hint={settings.prefs?.muted ? '静音中' : settings.prefs?.voice ? `朗读：${engine[settings.tts?.provider ?? 'auto'] ?? settings.tts?.provider}` : '没有读出来，只显示文字'}
            href="#/tts"
            icon={Volume2}
            label="朗读"
            on={!!settings.prefs?.voice && !settings.prefs?.muted}
          />
          <Chip hint={settings.asr?.enabled ? (settings.asr?.engine === 'local' ? '用本地识别服务' : '用 LobeHub 云端识别') : '没开：按住 🎤 不会录音'} href="#/asr" icon={Mic} label="语音输入" on={!!settings.asr?.enabled} />
          <Chip hint={settings.proactive?.enabled ? `每 ${settings.proactive?.speakCooldownMin} 分钟至多一次` : '只在你找她时说话'} href="#/proactive" icon={MessageCircleHeart} label="主动搭话" on={!!settings.proactive?.enabled} />
          <Chip hint={visitors ? `${visitors} 位伙伴在桌面上` : '还没有请伙伴来'} href="#/visitors" icon={UsersRound} label="同屏伙伴" on={visitors > 0} />
        </div>
      </Flexbox>

      {friends.length > 0 && (
        <Flexbox gap={12} style={{ marginBlockStart: 16 }}>
          <Flexbox align="center" horizontal justify="space-between">
            <Text as="h2" fontSize={18} strong style={{ margin: 0 }}>
              遇见过的伙伴
            </Text>
            <Button data-go-roster-all href="#/characters" icon={ChevronRight} iconPosition="end" size="small" type="text">
              {met.length > FRIENDS_MAX ? `去图鉴看全部 ${met.length} 位` : '去图鉴'}
            </Button>
          </Flexbox>
          <div className={styles.friends}>
            {friends.map((f) => (
              <Friend c={f.c} key={f.c.id} looks={f.looks} />
            ))}
          </div>
        </Flexbox>
      )}
      {!view && cur && <NoPet compact what="桌宠还没唤醒：上面的状态会在唤醒后同步。" />}
    </>
  );
};
