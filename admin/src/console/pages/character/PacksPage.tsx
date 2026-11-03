/**
 * 角色包（导入角色）（实施包 B · B08 / SH-01 · CHAR-08）：按角色分组——父行「大肥鱼 · 5 套形象」，展开是她的形象
 * （形象名、类型、来源、授权、操作）；代码 id 收进形象名的 Tooltip；标题用统一计数（roster-model）。删除 /
 * 删除下载在弹窗里执行（S-7）。路由 `#/packs` 不变；它挂在「角色」下面由 schema 决定（实施包 A，A04）。
 */
import { Button, Flexbox, Tag, Text, toast, Tooltip } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { Download, FolderOpen, Import, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Table } from '@lobehub/ui';

import { api, reasonText, type PackRow } from '../../api';
import { detailHref } from '../../roster-model';
import { useStore } from '../../store';
import { useAskAsync } from './DangerZone';
import { KindTag } from './shared';

/** 一行：父行是一位角色，子行是她的一套形象。 */
type Row = (PackRow & { group?: false }) | { children: PackRow[]; group: true; id: string; name: string; user: number };

export const PacksPage = () => {
  const { packs, merge } = useStore();
  const ask = useAskAsync();
  const [fresh, setFresh] = useState<string | null>(null);
  const run = async (p: Promise<any>, ok: string) => {
    const r = await p;
    if (r && r.view) merge({ view: r.view });
    if (r && r.ok) toast.success(ok);
    else if (r && r.reason !== 'canceled') toast.error({ description: (r.errors ?? []).slice(0, 3).join('；') || reasonText(r), title: '没能完成' });
    return r;
  };
  const [importing, setImporting] = useState(false);
  const importPack = async () => {
    setImporting(true);
    try {
      const r = await api().importPack();
      if (r && r.view) merge({ view: r.view });
      if (r && r.ok) {
        setFresh(r.pack?.id ?? null);
        toast.success({
          actions: r.characterId ? [{ label: '去看看她', onClick: () => (location.hash = detailHref(r.characterId, 'looks')) }] : undefined,
          description: '她已经在角色图鉴里，可以切换、换装。',
          title: `已导入「${r.pack?.name ?? '角色包'}」`,
        } as any);
      } else if (r && r.reason !== 'canceled') toast.error({ description: (r.errors ?? []).slice(0, 3).join('；') || reasonText(r), title: '没能导入' });
    } finally {
      setImporting(false);
    }
  };
  // 按原型分组，顺序跟着 packs（内置在前）
  const order: string[] = [];
  const by = new Map<string, PackRow[]>();
  for (const p of packs) {
    if (!by.has(p.species)) {
      by.set(p.species, []);
      order.push(p.species);
    }
    by.get(p.species)!.push(p);
  }
  const rows: Row[] = order.map((sp) => {
    const list = by.get(sp)!;
    return { children: list, group: true, id: `species:${sp}`, name: list[0].speciesName || sp, user: list.filter((p) => p.source === 'user').length };
  });
  const user = packs.filter((p) => p.source === 'user').length;
  // CHAR-01: why this count is larger than the 图鉴's — the 18+ looks are listed here, hidden there until 成人向内容 is on
  const adult = packs.filter((p) => p.adult).length;
  const removeDownload = (p: PackRow) =>
    ask.ask({
      desc: '她的形象文件会从本机删除，之后可以在商店里重新下载。衣柜、好感和聊天记录都会保留。',
      okText: '删除下载',
      run: async () => {
        const r = await api().removeDownload(p.id);
        if (r && (r as any).view) merge({ view: (r as any).view });
        return { done: `已删除下载「${p.name}」`, ok: !!r?.ok, r };
      },
      title: `删除下载「${p.name}」？`,
    });
  const removePack = (p: PackRow) =>
    ask.ask({
      desc: '会从数据目录里删除这套形象的角色包，它不再出现在角色图鉴里。好感和聊天记录跟着角色保留。',
      okText: '删除角色',
      run: async () => {
        const r = await api().removePack(p.id);
        if (r && r.view) merge({ view: r.view });
        return { done: `已删除角色「${p.name}」`, error: r?.errors?.join('；'), ok: !!r?.ok, r };
      },
      title: `删除角色「${p.name}」？`,
    });
  return (
    <>
      <PageHeader
        action={
          <Flexbox gap={8} horizontal>
            <Button icon={FolderOpen} onClick={() => api().openPacksFolder()}>
              打开文件夹
            </Button>
            <Button data-import-pack icon={Import} loading={importing} onClick={importPack} type="primary">
              导入角色…
            </Button>
          </Flexbox>
        }
        description="把角色包文件（.zip / 文件夹）导入，就会成为新角色。一个角色包是一套形象（像素 / 图片 / 全动态 / Live2D / VRM），同一位角色的几套形象共用名字、好感和聊天记录；导入的可以导出或删除。以某位角色为原型导入 Live2D / VRM 模型，在她的页面 → 装扮里。"
        title="角色包"
      />
      <Surface bleed data-packs title={`${rows.length} 位角色 · ${packs.length} 套形象（导入 ${user} 套${adult ? `；含 ${adult} 套 18+，没开成人向内容时不在图鉴里` : ''}）`}>
        <Table<Row>
          columns={[
            {
              key: 'name',
              render: (_: unknown, p) =>
                p.group ? (
                  <Flexbox align="baseline" data-pack-group={p.id.slice(8)} gap={8} horizontal>
                    <Text strong>{p.name}</Text>
                    <Text fontSize={12} type="secondary">
                      {`${p.children.length} 套形象${p.user ? `（导入 ${p.user} 套）` : ''}`}
                    </Text>
                  </Flexbox>
                ) : (
                  <Tooltip title={`角色包 id：${p.id}${p.version ? ` · v${p.version}` : ''}`}>
                    <a data-pack-row={p.id} data-pack-fresh={fresh === p.id || undefined} href={detailHref(p.id, 'looks')} style={{ color: 'inherit' }}>
                      <Text strong={fresh === p.id} type={fresh === p.id ? 'success' : undefined}>
                        {p.name}
                      </Text>
                    </a>
                  </Tooltip>
                ),
              title: '角色 / 形象',
            },
            { key: 'kind', render: (_: unknown, p) => (p.group ? null : <KindTag adult={p.adult} kind={p.kind} label={p.kindLabel} />), title: '类型', width: 120 },
            { key: 'source', render: (_: unknown, p) => (p.group ? null : <Tag color={p.source === 'user' ? 'processing' : undefined}>{p.sourceLabel}</Tag>), title: '来源', width: 80 },
            { key: 'license', render: (_: unknown, p) => (p.group ? null : <Text ellipsis fontSize={12} type="secondary">{p.license || '--'}</Text>), title: '授权', width: 200 },
            {
              key: 'act',
              render: (_: unknown, p) =>
                p.group ? null : p.source === 'download' ? (
                  <Button danger data-remove-download={p.id} icon={Trash2} onClick={() => removeDownload(p)} size="small" type="text">
                    删除下载
                  </Button>
                ) : p.removable ? (
                  <Flexbox gap={4} horizontal>
                    <Button data-export-pack={p.id} disabled={!p.exportable} icon={Download} onClick={() => run(api().exportPack(p.id), `已导出「${p.name}」`)} size="small" type="text">
                      导出
                    </Button>
                    <Button danger data-remove-pack={p.id} icon={Trash2} onClick={() => removePack(p)} size="small" type="text">
                      删除
                    </Button>
                  </Flexbox>
                ) : (
                  <Text fontSize={12} type="secondary">
                    内置，不能删除
                  </Text>
                ),
              title: '操作',
              width: 170,
            },
          ]}
          dataSource={rows}
          expandable={{ defaultExpandAllRows: true }}
          pagination={false}
          rowKey="id"
        />
      </Surface>
      {ask.modal}
    </>
  );
};
