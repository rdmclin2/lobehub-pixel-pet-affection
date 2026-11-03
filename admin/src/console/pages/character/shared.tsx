/**
 * 角色模块共用的小件：类型标签、模型名、切换 / 初次见面、下载与商店卡片。图鉴、详情、角色包页和商店
 * （pages/Store.tsx）都从这里取。由 Characters.tsx 拆出（实施包 B，行为不变）。
 */
import { Button, createStaticStyles, cssVar, Flexbox, Input, Modal, Progress, Tag, Text, toast } from '@lobehub/ui';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, reasonText, type CatalogRow, type DownloadProgress, type RosterRow } from '../../api';
import { STATE_WORD } from '../../roster-model';
import { SpriteStage } from '../../stage/SpriteStage';
import { useStore } from '../../store';

export const KIND_COLOR: Record<string, string> = { sprites: 'geekblue', pictures: 'cyan', rig: 'purple', live2d: 'magenta', vrm: 'volcano', video: 'gold' };

export const KindTag = ({ kind, label, adult }: { adult?: boolean; kind: string | null; label: string }) => (
  <Flexbox gap={4} horizontal>
    <Tag color={kind ? KIND_COLOR[kind] : undefined}>{label}</Tag>
    {adult && <Tag color="error">18+</Tag>}
  </Flexbox>
);

/** A model as the pet window names it: LobeHub-hosted ones by name, her vendor's own-key ones marked. */
export const modelLabel = (c: RosterRow, key: string | null | undefined): string => {
  if (!key) return '默认';
  const o = c.model?.options.find((x) => x.key === key);
  if (!o) return key;
  return o.hosted ? String(o.label ?? o.key) : `${o.label ?? o.key}（自己的 ${c.vendor} Key）`;
};

export const KIND_NAME: Record<string, string> = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };

/** 切换 / 初次见面 (meeting someone new asks her name first, then creates her agent). */
export const useSwitch = () => {
  const { merge } = useStore();
  const [naming, setNaming] = useState<RosterRow | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (c: RosterRow, nm?: string) => {
    setBusy(c.id);
    try {
      const r = await api().switchCharacter(c.id, nm);
      if (r && r.view) merge({ view: r.view });
      if (r && r.ok) toast.success(`已切换到 ${c.name ?? c.nameZh}`);
      else toast.error({ description: reasonText(r), title: `没能切换到 ${c.name ?? c.nameZh}` });
    } finally {
      setBusy(null);
    }
  };
  const start = (c: RosterRow) => {
    if (c.met) return run(c);
    setName('');
    setNaming(c);
  };
  const modal = (
    <Modal
      cancelText="取消"
      okButtonProps={{ disabled: !name.trim() || [...name.trim()].length > 12 }}
      okText="初次见面"
      onCancel={() => setNaming(null)}
      onOk={() => {
        const c = naming!;
        setNaming(null);
        run(c, name.trim());
      }}
      open={!!naming}
      title={naming ? `给 ${naming.nameZh} 起个名字` : ''}
    >
      <Flexbox gap={8}>
        <Text type="secondary">会在 LobeHub 里为她新建一个 agent。名字最多 12 个字。</Text>
        <Input aria-label="她的名字" autoFocus data-meet-name maxLength={12} onChange={(e) => setName(e.target.value)} placeholder="她的名字" value={name} />
      </Flexbox>
    </Modal>
  );
  return { busy, modal, start };
};

/**
 * 一位角色的唯一动作（B07 / B12）：正在陪你 → 状态标签（没有按钮）；已遇见 → 「切换」；还没见面 → 「初次见面」。
 * 两种按钮同一个样式，只有文案随状态变（CHAR-07：不再一会儿虚线一会儿实线）。
 */
export const SwitchButton = ({ c, sw, label }: { c: RosterRow; label?: string; sw: ReturnType<typeof useSwitch> }) =>
  c.current ? (
    <Tag color="success" data-current={c.id}>
      {STATE_WORD.current}
    </Tag>
  ) : (
    <Button
      data-switch={c.id}
      loading={sw.busy === c.id}
      onClick={(e) => {
        // the card around it is a link to her page: the button acts, the card does not navigate
        e.preventDefault();
        e.stopPropagation();
        sw.start(c);
      }}
      size="small"
    >
      {label ?? (c.met ? '切换' : '初次见面')}
    </Button>
  );

export const gstyles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
    gap: 16px;
  `,
  card: css`
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    transition:
      transform 200ms ease-out,
      box-shadow 200ms ease-out;

    &:hover {
      transform: translateY(-2px);
      box-shadow: ${cssVar.boxShadowSecondary};
    }

    &[data-current='true'] {
      border-color: color-mix(in srgb, var(--pet-accent) 60%, transparent);
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;

      &:hover {
        transform: none;
      }
    }
  `,
  art: css`
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    justify-content: center;

    height: 200px;

    background:
      radial-gradient(70% 60% at 50% 35%, color-mix(in srgb, var(--pet-accent) 30%, transparent), transparent 75%),
      color-mix(in srgb, var(--pet-accent) 8%, ${cssVar.colorFillQuaternary});

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  locked: css`
    position: absolute;
    inset-block-start: 50%;
    inset-inline-start: 50%;
    transform: translate(-50%, -50%);

    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;

    color: ${cssVar.colorTextSecondary};
  `,
  ribbon: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
  `,
  kind: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 8px;
  `,
}));

export const KIND_ORDER = ['sprites', 'pictures', 'rig', 'live2d', 'vrm', 'video'];

/**
 * 下载角色 (src/core/catalog.js): only the five pixel characters ship with the app; every other look is
 * downloaded here first. Progress comes as `catalog-progress`; a finished one arrives as a character in the
 * roster (main pushes the new state), so the map only drives the bar and the 取消 button meanwhile.
 */
export const useDownloads = () => {
  const { downloads } = useStore();
  const [map, setMap] = useState<Record<string, DownloadProgress>>(() => Object.fromEntries((downloads ?? []).map((d) => [d.id, d])));
  useEffect(() => api().onCatalogProgress((p) => setMap((m) => ({ ...m, [p.id]: p }))), []);
  const start = async (d: { id: string; name: string }) => {
    setMap((m) => ({ ...m, [d.id]: { id: d.id, received: 0, state: 'downloading' } }));
    const r = await api().downloadCharacter(d.id);
    if (r && r.ok) toast.success(`「${d.name}」下载好了，可以切换到她`);
    else if (r && r.reason !== 'canceled') toast.error({ description: r.text ?? reasonText(r), title: `没能下载「${d.name}」` });
  };
  return { map, start };
};

export const downloading = (p?: DownloadProgress) => !!p && (p.state === 'downloading' || p.state === 'installing');

/** One character in 商店 → 角色: her picture from the index, size, and 下载 / progress / 取消, or 已下载 → 查看. */
export const CatalogCard = ({ d, p, onDownload }: { d: CatalogRow; onDownload: () => void; p?: DownloadProgress }) => {
  const busy = downloading(p);
  const pct = p && p.total ? Math.min(100, Math.round(((p.received ?? 0) / p.total) * 100)) : 0;
  return (
    <article className={gstyles.card} data-catalog={d.id} data-kind={d.kind}>
      <div className={gstyles.art}>
        <SpriteStage animate={false} height={184} name={d.name} preview={d.picture ? { pixelated: d.pixelated, type: 'image', url: `../renderer/${d.picture}` } : null} />
        <span className={gstyles.ribbon}>
          {d.installed ? (
            <Tag color="success" data-downloaded={d.id}>
              已下载
            </Tag>
          ) : (
            <Tag data-not-downloaded={d.id}>未下载</Tag>
          )}
        </span>
        <span className={gstyles.kind}>
          <KindTag adult={d.adult} kind={d.kind} label={KIND_NAME[d.kind] ?? d.kind} />
        </span>
      </div>
      <Flexbox flex={1} gap={8} padding={12}>
        <Flexbox gap={2}>
          <Text ellipsis strong>
            {d.name}
          </Text>
          <Text ellipsis fontSize={12} type="secondary">
            {d.description}
          </Text>
        </Flexbox>
        <Text data-catalog-meta={d.id} ellipsis fontSize={12} type="secondary">
          {[d.sizeLabel, d.outfits ? `${d.outfits} 套服饰` : '', d.license].filter(Boolean).join(' · ')}
        </Text>
        {busy && (
          <Flexbox data-download-progress={d.id} gap={4}>
            <Progress percent={pct} showInfo={false} size="small" />
            <Text fontSize={12} type="secondary">
              {p?.state === 'installing' ? '正在安装…' : `已下载 ${pct}%`}
            </Text>
          </Flexbox>
        )}
        <Flexbox align="center" gap={8} horizontal justify="flex-end" style={{ marginBlockStart: 'auto' }}>
          {d.installed ? (
            <Button data-store-open={d.id} href={`#/characters/${d.id}`} size="small">
              查看
            </Button>
          ) : busy ? (
            <Button data-download-cancel={d.id} disabled={p?.state === 'installing'} onClick={() => api().cancelDownload(d.id)} size="small">
              取消
            </Button>
          ) : (
            <Button data-download={d.id} icon={Download} onClick={onDownload} size="small">
              下载
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    </article>
  );
};

/** 商店 → 角色: the catalog as cards (pages/Store.tsx), the same card style as the 图鉴. */
export const CatalogGrid = ({ items }: { items: CatalogRow[] }) => {
  const dl = useDownloads();
  return (
    <div className={gstyles.grid} data-catalog-grid>
      {items.map((d) => (
        <CatalogCard d={d} key={d.id} onDownload={() => dl.start(d)} p={dl.map[d.id]} />
      ))}
    </div>
  );
};
