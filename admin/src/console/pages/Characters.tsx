/**
 * 角色列表 (P-02) · 角色详情 (P-03 + P-04) · 外观资源 (P-02). Data: core/roster.js rows, rebuilt in main on
 * every change, so a switch made here shows in the pet window and the other way round.
 */
import { Alert, Button, Flexbox, Input, Modal, Progress, Select, Table, Tag, Text, TextArea, toast } from '@lobehub/ui';
import { PageHeader, PageTabs, Surface } from '@lobehub/ui/dashboard';
import { Download, FolderOpen, Import, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, reasonText, type PackRow, type RosterRow } from '../api';
import { CharacterPreview } from '../CharacterPreview';
import { ask } from '../fields';
import { FORM_STYLE } from '../SettingsForm';
import { useStore } from '../store';

const KIND_COLOR: Record<string, string> = { sprites: 'geekblue', pictures: 'cyan', rig: 'purple', live2d: 'magenta', vrm: 'volcano', video: 'gold' };

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

const relText = (c: RosterRow) => (c.met ? `${c.met.stage} · 好感 ${c.met.affection}` : '未见过');

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
      if (r && r.ok) toast.success(`已切换到 ${c.nameZh}`);
      else toast.error({ description: reasonText(r), title: `没能切换到 ${c.nameZh}` });
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

export const SwitchButton = ({ c, sw }: { c: RosterRow; sw: ReturnType<typeof useSwitch> }) =>
  c.current ? (
    <Tag color="success" data-current={c.id}>
      当前角色
    </Tag>
  ) : (
    <Button data-switch={c.id} loading={sw.busy === c.id} onClick={() => sw.start(c)} size="small" type={c.met ? 'default' : 'dashed'}>
      {c.met ? '切换' : '初次见面'}
    </Button>
  );

export const CharactersPage = ({ navigate }: { navigate: (p: string) => void }) => {
  const { roster, view } = useStore();
  const sw = useSwitch();
  return (
    <>
      <PageHeader
        action={
          <Button icon={Import} onClick={() => navigate('/packs')}>
            导入角色包…
          </Button>
        }
        description="所有可用角色：形象包、类型、来源、语音包和关系。点一行查看详情，也可以直接切换当前角色。"
        title="角色列表"
      />
      {!view && <Alert showIcon title="还没有唤醒桌宠" description="先在桌宠窗口里选一位角色并完成唤醒，之后就能在这里切换和设置她们。" type="info" />}
      <Surface bleed data-roster title={`共 ${roster.length} 位角色`}>
        <Table<RosterRow>
          columns={[
            { dataIndex: 'preview', key: 'preview', render: (_: unknown, c) => <CharacterPreview accent={c.accent} name={c.nameZh} preview={c.preview} size={48} />, title: '预览', width: 72 },
            {
              key: 'name',
              render: (_: unknown, c) => (
                <Flexbox gap={2}>
                  <Text strong>{c.displayName}</Text>
                  <Text fontSize={12} type="secondary">
                    {c.title}
                  </Text>
                </Flexbox>
              ),
              title: '名称',
            },
            { key: 'kind', render: (_: unknown, c) => <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />, title: '类型', width: 120 },
            {
              key: 'source',
              render: (_: unknown, c) => (
                <Flexbox gap={2}>
                  <Text>{c.sourceLabel}</Text>
                  <Text ellipsis fontSize={12} type="secondary">
                    {c.pack ? c.pack.name : '--'}
                  </Text>
                </Flexbox>
              ),
              title: '来源 · 形象包',
              width: 180,
            },
            {
              key: 'voice',
              render: (_: unknown, c) =>
                c.voicePack ? (
                  <Flexbox gap={2}>
                    <Text>{c.voicePack.engineLabel}</Text>
                    <Text fontSize={12} type="secondary">
                      {c.voicePack.lines} 句 · {c.voicePack.builtIn ? '内置' : '自定义'}
                    </Text>
                  </Flexbox>
                ) : (
                  <Text type="secondary">--</Text>
                ),
              title: '语音包',
              width: 130,
            },
            {
              key: 'rel',
              render: (_: unknown, c) => (
                <Flexbox gap={4} style={{ minWidth: 120 }}>
                  <Text fontSize={12}>{relText(c)}</Text>
                  {c.met && <Progress percent={Math.round((c.met.affection / 100) * 100)} showInfo={false} size="small" />}
                </Flexbox>
              ),
              title: '关系',
              width: 150,
            },
            {
              key: 'act',
              render: (_: unknown, c) => (
                <Flexbox align="center" gap={8} horizontal onClick={(e) => e.stopPropagation()}>
                  {view && <SwitchButton c={c} sw={sw} />}
                  <Button data-detail={c.id} onClick={() => navigate(`/characters/${c.id}`)} size="small" type="text">
                    详情
                  </Button>
                </Flexbox>
              ),
              title: '操作',
              width: 170,
            },
          ]}
          dataSource={roster}
          onRow={(c) => ({ 'data-row': c.id, onClick: () => navigate(`/characters/${c.id}`), style: { cursor: 'pointer' } }) as any}
          pagination={false}
          rowKey="id"
        />
      </Surface>
      {sw.modal}
    </>
  );
};

// ---- 角色详情 ---------------------------------------------------------------------------------------------

const Info = ({ label, children }: { children: React.ReactNode; label: string }) => (
  <Flexbox align="baseline" gap={12} horizontal>
    <Text style={{ flex: 'none', width: 96 }} type="secondary">
      {label}
    </Text>
    <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
  </Flexbox>
);

const ModelTab = ({ c }: { c: RosterRow }) => {
  const { merge } = useStore();
  const [loading, setLoading] = useState(false);
  const m = c.model;
  // the catalogue is loaded the first time someone needs it (as her page in the pet window did)
  useEffect(() => {
    if (m && !m.loaded) api().refreshModels().then((r) => r && r.view && merge({ view: r.view }), () => {});
  }, [m?.loaded]);
  if (!m) return <Alert title="唤醒桌宠后可以给她选模型" type="info" />;
  return (
    <Surface description="她的 agent 用哪个模型。只列她所属厂商的模型；当前角色改动后立即在后台应用。" title="模型">
      <Flexbox gap={12}>
        <Flexbox align="center" gap={8} horizontal>
          <Select
            aria-label="模型"
            data-model-select={c.id}
            disabled={!m.options.length}
            onChange={async (key) => {
              const r = await api().setModel(String(key), c.id);
              if (r && r.view) merge({ view: r.view });
              if (r && r.ok) toast.success(`${c.nameZh} 的模型：${modelLabel(c, String(key))}`);
              else toast.error(reasonText(r));
            }}
            options={m.options.map((o) => ({ label: modelLabel(c, o.key), value: o.key }))}
            placeholder={m.loaded ? '没有可用的模型' : '模型目录还没加载'}
            style={{ width: 360 }}
            value={m.current ?? undefined}
          />
          <Button
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                const r = await api().refreshModels();
                if (r && r.view) merge({ view: r.view });
                toast.success('模型目录已刷新');
              } finally {
                setLoading(false);
              }
            }}
          >
            刷新目录
          </Button>
        </Flexbox>
        <Text data-model-status={c.id} type="secondary">
          {!m.loaded
            ? '正在读取模型列表…'
            : !m.current
              ? `你没有启用任何 ${c.vendor} 模型，她先用原来的模型。`
              : `${m.applied === m.current ? '正在用' : c.current ? '下一句话起用' : c.met ? '她下次陪你时起用' : '见面后起用'}：${modelLabel(c, m.current)}${m.chosen ? '' : '（默认）'}`}
        </Text>
        {m.pending && <Alert title={`待应用：她的 agent 还在用 ${modelLabel(c, m.applied)}，下次她说话前切到 ${modelLabel(c, m.current)}`} type="warning" />}
      </Flexbox>
    </Surface>
  );
};

const RoleTab = ({ c }: { c: RosterRow }) => {
  const { merge, settings } = useStore();
  const max = settings.systemRoleMax ?? 1000;
  const [text, setText] = useState(c.systemRole);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(c.systemRole), [c.systemRole]);
  const len = [...text].length;
  return (
    <Surface description="加在她 system role 里的你自己的话（比如称呼、口癖）。留空即删除。" title="个性化设定">
      <Flexbox gap={8}>
        <TextArea aria-label="个性化设定" data-system-role={c.id} onChange={(e) => setText(e.target.value)} placeholder="例如：叫我老板，回答简短一点。" rows={6} aria-invalid={len > max} value={text} />
        <Flexbox align="center" horizontal justify="space-between">
          <Text fontSize={12} type={len > max ? 'danger' : 'secondary'}>
            {len} / {max} · {c.systemRole ? `已保存${c.current ? '，下一句话起用' : c.met ? '，她下次陪你时起用' : '，见面后起用'}` : '还没写，她按默认性格来'}
          </Text>
          <Flexbox gap={8} horizontal>
            <Button
              data-clear-role={c.id}
              disabled={!text && !c.systemRole}
              onClick={async () => {
                if (!c.systemRole) return setText('');
                if (!(await ask(`清空 ${c.nameZh} 的个性化设定？`, '她会按默认性格来，已经写的内容会删除。', '清空个性化设定', true))) return;
                const r = await api().setSystemRole('', c.id);
                if (r && r.view) merge({ view: r.view });
                if (r && r.ok) toast.success(`${c.nameZh} 的个性化设定已清空`);
                else toast.error(reasonText(r));
              }}
            >
              清空
            </Button>
            <Button
              data-save-role={c.id}
              disabled={len > max || text === c.systemRole}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api().setSystemRole(text, c.id);
                  if (r && r.view) merge({ view: r.view });
                  if (r && r.ok) toast.success('个性化设定已保存');
                  else toast.error(reasonText(r));
                } finally {
                  setBusy(false);
                }
              }}
              type="primary"
            >
              保存
            </Button>
          </Flexbox>
        </Flexbox>
      </Flexbox>
    </Surface>
  );
};

const LookTab = ({ c }: { c: RosterRow }) => {
  const { view, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const options: any[] = ch?.appearance?.options ?? [];
  const run = async (p: Promise<any>, ok: string) => {
    const r = await p;
    if (r && r.view) merge({ view: r.view });
    if (r && r.ok) toast.success(ok);
    else if (r && r.reason !== 'canceled') toast.error(reasonText(r));
  };
  if (!view) return <Alert title="唤醒桌宠后可以给她换外观" type="info" />;
  return (
    <Surface
      bleed
      description="她穿的角色包。18+ 包要先确认已满 18 周岁并打开成人向内容。"
      extra={
        <Flexbox gap={8} horizontal>
          <Button icon={Import} onClick={() => run(api().importPack(), '角色包已导入')} size="small">
            导入角色包…
          </Button>
          <Button onClick={() => run(api().importLive2d(c.id), 'Live2D 模型已导入')} size="small">
            导入 Live2D…
          </Button>
          <Button onClick={() => run(api().importVrm(c.id), 'VRM 模型已导入')} size="small">
            导入 VRM…
          </Button>
        </Flexbox>
      }
      title="外观"
    >
      <Table
        columns={[
          { dataIndex: 'name', key: 'name', render: (_: unknown, p: any) => <Text strong={p.id === c.pack?.id}>{p.name}</Text>, title: '形象包' },
          { key: 'kind', render: (_: unknown, p: any) => <KindTag adult={p.adult} kind={p.kind} label={({ sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' } as any)[p.kind] ?? p.kind} />, title: '类型', width: 120 },
          { key: 'source', render: (_: unknown, p: any) => (p.source === 'user' ? '导入' : '内置'), title: '来源', width: 80 },
          { dataIndex: 'author', key: 'author', render: (v: string) => <Text ellipsis type="secondary">{v || '--'}</Text>, title: '作者', width: 180 },
          {
            key: 'use',
            render: (_: unknown, p: any) =>
              p.id === c.pack?.id || (!c.pack && p.kind === 'video') ? (
                <Tag color="success">正在使用</Tag>
              ) : (
                <Button data-use-pack={p.id} onClick={() => run(api().setAppearance(p.id, c.id), `${c.nameZh} 换上了「${p.name}」`)} size="small">
                  使用
                </Button>
              ),
            title: '',
            width: 110,
          },
        ]}
        dataSource={options}
        pagination={false}
        rowKey="id"
      />
    </Surface>
  );
};

const AffectionTab = ({ c }: { c: RosterRow }) => {
  const { merge } = useStore();
  if (!c.met) return <Alert title="还没见过她：切换到她并起个名字之后才有好感度" type="info" />;
  const p = c.met.progress;
  return (
    <Surface description="关系阶段随好感上涨解锁新的话题和服饰。" title="好感度">
      <Flexbox gap={12}>
        <Info label="关系">{relText(c)}</Info>
        <Info label="进度">
          <Progress percent={Math.round(((p?.value ?? c.met.affection) / (p?.max ?? 100)) * 100)} />
        </Info>
        {p?.next && (
          <Info label="下一阶段">
            {p.nextName}：还差 {p.need}
          </Info>
        )}
        <Flexbox horizontal>
          <Button
            danger
            data-unlock={c.id}
            onClick={async () => {
              if (!(await ask(`一键解锁 ${c.nameZh}？`, '把好感拉满，解锁她的所有阶段、话题和服饰。不能撤销。', '一键解锁', true))) return;
              const r = await api().unlockAll(c.id);
              if (r && r.view) merge({ view: r.view });
              if (r && r.ok) toast.success(r.already ? '已经全部解锁了' : '已全部解锁');
              else toast.error(reasonText(r));
            }}
          >
            一键解锁
          </Button>
        </Flexbox>
      </Flexbox>
    </Surface>
  );
};

export const CharacterDetailPage = ({ id, navigate }: { id: string; navigate: (p: string) => void }) => {
  const { roster, view } = useStore();
  const sw = useSwitch();
  const [tab, setTab] = useState<'overview' | 'model' | 'role' | 'look' | 'voice' | 'affection'>('overview');
  const c = roster.find((x) => x.id === id);
  if (!c) return <Alert title={`没有角色「${id}」`} type="error" />;
  const tts = c.voice?.tts;
  return (
    <>
      <PageHeader
        action={
          <Flexbox gap={8} horizontal>
            <Button onClick={() => navigate('/characters')}>返回列表</Button>
            {view && <SwitchButton c={c} sw={sw} />}
          </Flexbox>
        }
        description={c.title}
        mark={<CharacterPreview accent={c.accent} name={c.nameZh} preview={c.preview} size={56} />}
        title={<span data-character-title={c.id}>{c.displayName}</span>}
      />
      <PageTabs
        label="角色详情"
        onChange={setTab}
        tabs={[
          {
            content: (
              <Surface title="概况">
                <Flexbox gap={12} style={{ maxWidth: FORM_STYLE.style.maxWidth }}>
                  <Info label="简介">{c.blurb || '--'}</Info>
                  <Info label="口头禅">{c.catchphrase || '--'}</Info>
                  <Info label="喜欢">{c.likes?.length ? c.likes.join('、') : '--'}</Info>
                  <Info label="当前外观">
                    <Flexbox align="center" gap={8} horizontal>
                      <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />
                      <Text>{c.pack ? `${c.pack.name}（${c.sourceLabel}）` : c.kind === 'video' ? '原版动画' : '--'}</Text>
                    </Flexbox>
                  </Info>
                  <Info label="可选外观">{c.packCount} 个</Info>
                  <Info label="关系">{relText(c)}</Info>
                  <Info label="模型">{c.model?.current ? modelLabel(c, c.model.current) : '--'}</Info>
                  <Info label="素材署名">
                    <Flexbox gap={4}>{c.credits.length ? c.credits.map((x) => <Text key={x} type="secondary">{x}</Text>) : '--'}</Flexbox>
                  </Info>
                </Flexbox>
              </Surface>
            ),
            label: '概况',
            value: 'overview',
          },
          { content: <ModelTab c={c} />, label: '模型', value: 'model' },
          { content: <RoleTab c={c} />, label: '个性化设定', value: 'role' },
          { content: <LookTab c={c} />, label: '外观', value: 'look' },
          {
            content: (
              <Surface title="语音">
                <Flexbox gap={12}>
                  <Info label="语音包">{c.voicePack ? `${c.voicePack.name} · ${c.voicePack.engineLabel} · ${c.voicePack.lines} 句 · ${c.voicePack.builtIn ? '内置' : '自定义'}` : '没有语音包'}</Info>
                  {c.voicePack?.credit && <Info label="音色署名">{c.voicePack.credit}</Info>}
                  <Info label="角色音色">
                    <Flexbox gap={4} horizontal wrap="wrap">
                      {tts ? Object.keys(tts).map((k) => <Tag key={k}>{k}</Tag>) : '--'}
                    </Flexbox>
                  </Info>
                  <Text fontSize={12} type="secondary">
                    角色音色写在角色文件里，只读。语音包可以在「语音包」页重新读取或打开文件夹替换。
                  </Text>
                </Flexbox>
              </Surface>
            ),
            label: '语音',
            value: 'voice',
          },
          { content: <AffectionTab c={c} />, label: '好感度', value: 'affection' },
        ]}
        value={tab}
      />
      {sw.modal}
    </>
  );
};

// ---- 外观资源 ---------------------------------------------------------------------------------------------

export const PacksPage = () => {
  const { packs, merge } = useStore();
  const run = async (p: Promise<any>, ok: string) => {
    const r = await p;
    if (r && r.view) merge({ view: r.view });
    if (r && r.ok) toast.success(ok);
    else if (r && r.reason !== 'canceled') toast.error(reasonText(r));
  };
  const user = packs.filter((p) => p.source === 'user').length;
  return (
    <>
      <PageHeader
        action={
          <Flexbox gap={8} horizontal>
            <Button icon={FolderOpen} onClick={() => api().openPacksFolder()}>
              打开文件夹
            </Button>
            <Button data-import-pack icon={Import} onClick={() => run(api().importPack(), '角色包已导入')} type="primary">
              导入角色包…
            </Button>
          </Flexbox>
        }
        description="内置和导入的角色包（像素 / 图片 / 全动态 / Live2D / VRM）。导入的包可以导出或删除；Live2D 和 VRM 在角色详情 → 外观里导入。"
        title="外观资源"
      />
      <Surface bleed data-packs title={`共 ${packs.length} 个（导入 ${user} 个）`}>
        <Table<PackRow>
          columns={[
            { dataIndex: 'name', key: 'name', render: (_: unknown, p) => <Flexbox gap={2}><Text strong>{p.name}</Text><Text code fontSize={12} type="secondary">{p.id}</Text></Flexbox>, title: '名称' },
            { dataIndex: 'speciesName', key: 'species', title: '角色', width: 90 },
            { key: 'kind', render: (_: unknown, p) => <KindTag adult={p.adult} kind={p.kind} label={p.kindLabel} />, title: '类型', width: 120 },
            { key: 'source', render: (_: unknown, p) => <Tag color={p.source === 'user' ? 'processing' : undefined}>{p.sourceLabel}</Tag>, title: '来源', width: 80 },
            { dataIndex: 'license', key: 'license', render: (v: string) => <Text ellipsis fontSize={12} type="secondary">{v || '--'}</Text>, title: '授权', width: 200 },
            {
              key: 'act',
              render: (_: unknown, p) =>
                p.removable ? (
                  <Flexbox gap={4} horizontal>
                    <Button disabled={!p.exportable} icon={Download} onClick={() => run(api().exportPack(p.id), `已导出「${p.name}」`)} size="small" type="text">
                      导出
                    </Button>
                    <Button
                      danger
                      data-remove-pack={p.id}
                      icon={Trash2}
                      onClick={async () => {
                        if (await ask(`删除角色包「${p.name}」？`, '会从数据目录里删除这个导入的包；正在穿它的角色换回默认外观。', '删除角色包', true)) run(api().removePack(p.id), `已删除角色包「${p.name}」`);
                      }}
                      size="small"
                      type="text"
                    >
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
          dataSource={packs}
          pagination={false}
          rowKey="id"
        />
      </Surface>
    </>
  );
};
