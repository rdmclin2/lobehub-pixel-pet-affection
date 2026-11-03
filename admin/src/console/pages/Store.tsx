/**
 * 商店 (docs/characters.md 「内置与下载」): what can be downloaded. One tab per kind of thing — 角色 now; 声音包
 * and more can be added as tabs later. Downloaded characters stay listed here as 已下载 (→ her page) and show
 * up in 角色图鉴, which lists only the characters on this machine.
 *
 * 实施包 C（docs/admin-audit/02-plan.md §5.4）：
 * - C12 / STORE-01：只有一个类别时不渲染标签栏（W-07「切换后画面不变的控件 → 删」）；出现第二个类别时标签栏自动出现。
 * - C13 / STORE-03：筛选写进 `#/store?show=remote|installed`（P-02「状态进 URL」，返回 / 刷新保持）；页头读 `PAGES.store`（W-03）。
 * - C14 / STORE-02：下载完成只给一条 toast，带「去见她」→ 她的页面（M-03 #1 系统状态可见）。
 */
import { Alert, Flexbox, Segmented, Text, toast } from '@lobehub/ui';
import { PageHeader, PageTabs } from '@lobehub/ui/dashboard';
import { useState, type ReactNode } from 'react';

import { replaceHash, useHashQuery } from '../../useHashPath';
import { api, reasonText, type CatalogRow } from '../api';
import { NoPet } from '../common';
import { detailHref } from '../roster-model';
import { useStore } from '../store';
import { CatalogCard, KIND_NAME, useDownloads } from './Characters';

type Show = 'all' | 'remote' | 'installed';
const SHOWS: Show[] = ['all', 'remote', 'installed'];

/** The catalog grid with a download that ends in one toast offering 「去见她」 (C14). */
const Shelf = ({ items }: { items: CatalogRow[] }) => {
  const { map } = useDownloads();
  const start = async (d: CatalogRow) => {
    const r = await api().downloadCharacter(d.id);
    if (r && r.ok) {
      const id = r.id ?? d.id;
      toast.success({
        actions: [{ label: '去见她', onClick: () => (location.hash = detailHref(id, 'looks')), props: { 'data-store-meet': id } as any }],
        description: '她已经在角色图鉴里，初次见面后就能切换到她。',
        id: `download-${d.id}`,
        title: `「${d.name}」下载好了`,
      });
    } else if (r && r.reason !== 'canceled') toast.error({ description: r.text ?? reasonText(r), title: `没能下载「${d.name}」` });
  };
  return (
    <div data-catalog-grid style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(208px, 1fr))' }}>
      {items.map((d) => (
        <CatalogCard d={d} key={d.id} onDownload={() => start(d)} p={map[d.id]} />
      ))}
    </div>
  );
};

const CharactersShelf = () => {
  const { catalog: cat, view } = useStore();
  const catalog = cat ?? [];
  const q = useHashQuery().get('show') as Show | null;
  const show: Show = q && SHOWS.includes(q) ? q : 'all';
  const setShow = (v: Show) => replaceHash(v === 'all' ? '/store' : `/store?show=${v}`);
  const remote = catalog.filter((d) => !d.installed).length;
  const items = catalog.filter((d) => show === 'all' || (show === 'installed' ? d.installed : !d.installed));
  if (!catalog.length)
    return <Alert description="目前没有可以下载的角色。" title="商店里还没有角色" type="info" />;
  return (
    <Flexbox gap={16}>
      <Flexbox align="center" gap={8} horizontal justify="space-between" wrap="wrap">
        <div data-store-filter>
          <Segmented
            onChange={(v) => setShow(v as Show)}
            options={[
              { label: `全部 ${catalog.length}`, value: 'all' },
              { label: `未下载 ${remote}`, value: 'remote' },
              { label: `已下载 ${catalog.length - remote}`, value: 'installed' },
            ]}
            size="small"
            value={show}
          />
        </div>
        <Text fontSize={12} type="secondary">
          {[...new Set(catalog.map((d) => KIND_NAME[d.kind] ?? d.kind))].join(' · ')}
        </Text>
      </Flexbox>
      {!view && <NoPet compact what="下载的角色要唤醒桌宠后才能在角色图鉴里结识和切换" />}
      {items.length ? (
        <Shelf items={items} />
      ) : (
        <Text data-store-filter-empty type="secondary">
          {show === 'remote' ? '已经全部下载了。' : '还没有下载过角色。'}
        </Text>
      )}
    </Flexbox>
  );
};

type ShelfKey = 'characters';

export const StorePage = () => {
  const { schema } = useStore();
  const p = schema.pages.store;
  // one entry per kind of thing on sale; add 声音包 etc. here — the tab bar appears once there are two (C12)
  const shelves: { content: ReactNode; label: string; value: ShelfKey }[] = [{ content: <CharactersShelf />, label: '角色', value: 'characters' }];
  const [tab, setTab] = useState<ShelfKey>('characters');
  return (
    <>
      <PageHeader description={p?.description} title={p?.title ?? '商店'} />
      {shelves.length > 1 ? <PageTabs label="商店分类" onChange={setTab} tabs={shelves} value={tab} /> : shelves[0].content}
    </>
  );
};
