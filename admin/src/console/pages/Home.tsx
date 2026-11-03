/** 小屋 (overview): her on her stage, how close you are, and today's companionship at a glance. */
import { Alert, Block, Button, createStaticStyles, cssVar, Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { ChevronRight, Lock, Mic, MessageCircleHeart, Shirt, UsersRound, Volume2, Webhook } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { RosterRow } from '../api';
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

const Chip = ({ icon, label, on, hint, href }: { hint: string; href: string; icon: LucideIcon; label: string; on: boolean }) => (
  <a className={styles.link} data-chip={href} href={href}>
    <Block clickable gap={12} horizontal padding={12} style={{ alignItems: 'center' }} variant="outlined">
      <div className={styles.chipIcon} data-on={on}>
        <Icon icon={icon} size={18} />
      </div>
      <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
        <Flexbox align="center" gap={6} horizontal>
          <Text strong>{label}</Text>
          <Tag color={on ? 'success' : undefined} size="small">
            {on ? '开' : '关'}
          </Tag>
        </Flexbox>
        <Text ellipsis fontSize={12} type="secondary">
          {hint}
        </Text>
      </Flexbox>
    </Block>
  </a>
);

const Friend = ({ c }: { c: RosterRow }) => (
  <a className={styles.link} data-friend={c.id} href={`#/characters/${c.id}`} style={{ ['--pet-accent' as string]: c.accent }}>
    <Block clickable gap={8} padding={8} variant="outlined">
      <div className={styles.friendArt}>
        <SpriteStage animate={false} height={88} name={c.nameZh} preview={c.preview} silhouette={!c.met} />
      </div>
      <Flexbox gap={4} paddingInline={4}>
        <Flexbox align="center" gap={4} horizontal justify="space-between">
          <Text ellipsis strong>
            {`${c.met?.name ?? c.nameZh}${c.label ? ` · ${c.label}` : ''}`}
          </Text>
          {!c.met && <Icon icon={Lock} size={12} />}
        </Flexbox>
        <HeartMeter c={c} compact />
      </Flexbox>
    </Block>
  </a>
);

export const OverviewPage = ({ navigate }: { navigate: (p: string) => void }) => {
  const { roster, settings, view, apiStatus } = useStore();
  const cur = roster.find((c) => c.current);
  const others = roster.filter((c) => !c.current);
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
              <Button data-go-detail icon={MessageCircleHeart} onClick={() => navigate(`/characters/${cur.id}`)} type="primary">
                去看看她
              </Button>
              <Button data-go-looks icon={Shirt} onClick={() => navigate(`/characters/${cur.id}`)}>
                换形象包
              </Button>
              <Button onClick={() => navigate('/characters')}>换一位陪你</Button>
            </Flexbox>
            <Text fontSize={12} type="secondary">
              点她一下：她会回应你，桌面上的她也一样。
            </Text>
          </Flexbox>
        </div>
      ) : (
        <Alert description="先在桌宠窗口里选一位角色并完成唤醒，她会出现在这里。" showIcon title="还没有唤醒桌宠" type="info" />
      )}

      <Flexbox gap={12} style={{ marginBlockStart: 16 }}>
        <Text as="h2" fontSize={18} strong style={{ margin: 0 }}>
          今天的陪伴
        </Text>
        <div className={styles.chips}>
          <Chip hint="把回复读出来" href="#/tts" icon={Volume2} label="朗读" on={!!settings.prefs?.voice} />
          <Chip hint={settings.asr?.engine === 'local' ? '本地识别服务' : 'LobeHub 云端识别'} href="#/asr" icon={Mic} label="语音输入" on={!!settings.asr?.enabled} />
          <Chip hint={settings.proactive?.enabled ? `每 ${settings.proactive?.speakCooldownMin} 分钟至多一次` : '只在你找她时说话'} href="#/proactive" icon={MessageCircleHeart} label="主动搭话" on={!!settings.proactive?.enabled} />
          <Chip hint={visitors ? `${visitors} 位伙伴在桌面上` : '让其他角色一起来玩'} href="#/visitors" icon={UsersRound} label="同屏伙伴" on={visitors > 0} />
          <Chip hint={apiStatus?.listening ? `127.0.0.1:${settings.api?.port}` : '脚本让她说话、做动作'} href="#/api" icon={Webhook} label="对外接口" on={!!settings.api?.enabled} />
        </div>
      </Flexbox>

      {others.length > 0 && (
        <Flexbox gap={12} style={{ marginBlockStart: 16 }}>
          <Flexbox align="center" horizontal justify="space-between">
            <Text as="h2" fontSize={18} strong style={{ margin: 0 }}>
              其他伙伴
            </Text>
            <Button href="#/characters" icon={ChevronRight} iconPosition="end" size="small" type="text">
              角色图鉴
            </Button>
          </Flexbox>
          <div className={styles.friends}>
            {others.map((c) => (
              <Friend c={c} key={c.id} />
            ))}
          </div>
        </Flexbox>
      )}
      {!view && cur && <Alert title="桌宠还没唤醒：开关的状态会在唤醒后同步。" type="info" />}
    </>
  );
};
