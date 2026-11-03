/**
 * 角色图鉴（实施包 B）：一位角色一张卡（B01 / CHAR-01），卡片四态（B09 / STORE-02 · STG-03），筛选进 URL、
 * 整张卡可点、同一位置只有一个动作按钮（B07 / CHAR-07）。数据：core/roster.js 的形象行，由 roster-model.ts
 * 收成角色。
 */
import { Alert, Button, createStaticStyles, cssVar, Empty, Flexbox, Segmented, Tag, Text } from '@lobehub/ui';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Download, Import, Store } from 'lucide-react';

import { api } from '../../api';
import { countLabel, detailHref, groupRoster, metCount, STATE_WORD, type CharacterGroup } from '../../roster-model';
import { HeartMeter } from '../../stage/HeartMeter';
import { SpriteStage } from '../../stage/SpriteStage';
import { useStore } from '../../store';
import { replaceHash, useHashQuery } from '../../../useHashPath';
import { downloading, gstyles, KIND_NAME, KIND_ORDER, KindTag, SwitchButton, useDownloads, useSwitch } from './shared';

const styles = createStaticStyles(({ css }) => ({
  // the whole card is her page (P-02: one way in per row); the one action button sits above the link
  card: css`
    cursor: pointer;

    &:focus-within {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  stretch: css`
    color: inherit;

    &::after {
      content: '';
      position: absolute;
      z-index: 1;
      inset: 0;
    }
  `,
  above: css`
    position: relative;
    z-index: 2;
  `,
}));

const FILTER_LABEL = (k: string) => (k === 'user' ? '导入的' : (KIND_NAME[k] ?? k));

/** One character: her lead look drawn, her state once, one action. */
const CharacterCard = ({ g, sw, pet }: { g: CharacterGroup; pet: boolean; sw: ReturnType<typeof useSwitch> }) => {
  const c = g.lead;
  const unowned = g.state === 'unowned' || !c;
  const href = c ? detailHref(c.id) : `#/store`;
  const art = c ? c.preview : g.remote[0]?.picture ? { pixelated: g.remote[0].pixelated, type: 'image' as const, url: `../renderer/${g.remote[0].picture}` } : null;
  const looks = g.looks.length;
  return (
    <article
      className={`${gstyles.card} ${styles.card}`}
      data-base={g.base}
      data-current={g.state === 'current'}
      data-kind={c?.kind ?? ''}
      data-looks={looks}
      data-row={c?.id ?? g.base}
      data-state={g.state}
      style={{ ['--pet-accent' as string]: g.accent || undefined }}
    >
      <div className={gstyles.art}>
        {/* 剪影只给「未拥有」：下载了、还没见面的她是彩色的（STORE-02） */}
        <SpriteStage animate height={184} name={g.name} preview={art} silhouette={unowned} />
        {(g.state === 'current' || unowned) && (
          <span className={gstyles.ribbon}>
            {g.state === 'current' ? (
              <Tag color="success" data-current={c!.id}>
                {STATE_WORD.current}
              </Tag>
            ) : (
              <Tag data-unowned={g.base}>{STATE_WORD.unowned}</Tag>
            )}
          </span>
        )}
        <span className={gstyles.kind}>
          {c && <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />}
        </span>
      </div>
      <Flexbox flex={1} gap={8} padding={12}>
        <Flexbox gap={2}>
          <Flexbox align="baseline" gap={8} horizontal justify="space-between">
            <a aria-label={`查看 ${g.name}`} className={styles.stretch} data-card-link={g.base} href={href}>
              <Text ellipsis strong>
                {c ? `${g.name}（${c.vendor}）` : g.name}
              </Text>
            </a>
            <Text data-looks-count={g.base} fontSize={12} style={{ flex: 'none' }} type="secondary">
              {looks ? `${looks} 套形象` : `${g.remote.length} 套可下载`}
            </Text>
          </Flexbox>
          <Text ellipsis fontSize={12} type="secondary">
            {c ? c.title : '在商店里下载她的形象后就能见面'}
          </Text>
        </Flexbox>
        {/* 状态只说一次：已遇见 → 好感条；还没见面 → 一行字；未拥有 → 只有剪影 + 标签（STG-03） */}
        {c && c.met ? (
          <HeartMeter c={c} compact />
        ) : c ? (
          <Text data-state-word={g.base} fontSize={12} type="secondary">
            {STATE_WORD.unmet}
          </Text>
        ) : null}
        <Flexbox align="center" className={styles.above} gap={8} horizontal justify="flex-end" style={{ marginBlockStart: 'auto', minHeight: 24 }}>
          {unowned ? (
            <Button data-unowned-store={g.base} href="#/store" icon={Store} size="small">
              去商店
            </Button>
          ) : pet && g.state !== 'current' ? (
            <SwitchButton c={c!} sw={sw} />
          ) : null}
        </Flexbox>
      </Flexbox>
    </article>
  );
};

/**
 * 角色图鉴：已遇见的彩色带好感，还没见面的彩色带「初次见面」，商店里才有的是剪影。卡片代表她的一套形象
 * （正在陪你的那套，否则第一套）；她的其他形象在详情 → 装扮 →「形象」里。
 */
export const CharactersPage = ({ navigate }: { navigate: (p: string) => void }) => {
  const { roster, view, catalog: cat } = useStore();
  const catalog = cat ?? [];
  const sw = useSwitch();
  const dl = useDownloads();
  const q = useHashQuery();
  // 按形象类型 → `?kind=`（P-02「筛选进 URL」）：进详情再返回、刷新都还在
  const kinds = KIND_ORDER.filter((k) => roster.some((c) => c.kind === k));
  const hasUser = roster.some((c) => c.source === 'user');
  const raw = q.get('kind') ?? 'all';
  const kind = raw === 'all' || kinds.includes(raw) || (raw === 'user' && hasUser) ? raw : 'all';
  const match = kind === 'all' ? undefined : (c: (typeof roster)[number]) => (kind === 'user' ? c.source === 'user' : c.kind === kind);
  const all = groupRoster(roster, catalog);
  const shown = (match ? groupRoster(roster, [], match).filter((g) => g.lead) : all).filter((g) => (match ? g.looks.some(match) : true));
  const bases = (k: string) => groupRoster(roster, [], (c) => (k === 'user' ? c.source === 'user' : c.kind === k)).filter((g) => g.looks.some((c) => (k === 'user' ? c.source === 'user' : c.kind === k))).length;
  const setKind = (v: string) => replaceHash(v === 'all' ? '/characters' : `/characters?kind=${v}`);
  const remote = catalog.filter((d) => !d.installed);
  const pending = view?.pendingDownload as { id: string; name: string; sizeLabel: string } | null | undefined;
  const pendingRow = pending ? catalog.find((d) => d.id === pending.id) : undefined;
  const owned = all.filter((g) => g.state !== 'unowned').length;
  return (
    <>
      <PageHeader
        action={
          <Button data-go-import icon={Import} onClick={() => navigate('/packs')}>
            导入角色
          </Button>
        }
        description={`已遇见 ${metCount(roster)} / ${owned} 位角色 · 共 ${roster.length} 套形象。一位角色可以有几套形象（像素、Live2D…），在她的页面里换；更多形象在商店里下载。`}
        title="角色图鉴"
      />
      {!view && (
        <Alert
          action={
            <Button onClick={() => api().showPet()} size="small">
              打开桌宠窗口
            </Button>
          }
          description="先在桌宠窗口里选一位角色并完成唤醒，之后就能在这里结识和切换她们。卡片照样可以浏览。"
          showIcon
          title="还没有唤醒桌宠"
          type="info"
        />
      )}
      {pending && (
        <Alert
          action={
            pendingRow && !downloading(dl.map[pending.id]) ? (
              <Button data-pending-download={pending.id} icon={Download} onClick={() => dl.start(pendingRow)} size="small" type="primary">
                下载（{pending.sizeLabel}）
              </Button>
            ) : undefined
          }
          data-pending={pending.id}
          description={`「${pending.name}」不再随应用自带，下载后她会自动换回这个形象；在那之前先用默认形象陪你，好感和聊天记录都不受影响。`}
          showIcon
          title={`「${pending.name}」需要下载`}
          type="info"
        />
      )}
      <Flexbox align="center" data-kind-filter gap={8} horizontal wrap="wrap">
        <Text fontSize={12} type="secondary">
          按形象类型
        </Text>
        <Segmented
          onChange={(v) => setKind(String(v))}
          options={[
            { label: `全部 ${owned}`, value: 'all' },
            ...kinds.map((k) => ({ label: `${FILTER_LABEL(k)} ${bases(k)}`, value: k })),
            ...(hasUser ? [{ label: `${FILTER_LABEL('user')} ${bases('user')}`, value: 'user' }] : []),
          ]}
          size="small"
          value={kind}
        />
        <Text data-roster-count fontSize={12} type="secondary">
          {countLabel(roster)}
        </Text>
      </Flexbox>
      {shown.length ? (
        <div className={gstyles.grid} data-roster data-roster-filter={kind}>
          {shown.map((g) => (
            <CharacterCard g={g} key={g.base} pet={!!view} sw={sw} />
          ))}
        </div>
      ) : (
        <Empty
          action={
            <Button data-clear-filter onClick={() => setKind('all')}>
              清除筛选
            </Button>
          }
          data-roster-empty
          description="换一个类型，或在商店里下载这种形象。"
          title={`没有${FILTER_LABEL(kind)}角色`}
        />
      )}
      {remote.length > 0 && (
        <Flexbox align="center" data-store-hint gap={8} horizontal justify="space-between" wrap="wrap">
          <Text fontSize={12} type="secondary">
            {`商店里还有 ${remote.length} 套形象可以下载。`}
          </Text>
          <Button data-go-store href="#/store" icon={Store} size="small">
            去商店
          </Button>
        </Flexbox>
      )}
      {sw.modal}
    </>
  );
};
