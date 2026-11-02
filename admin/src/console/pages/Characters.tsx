/**
 * 角色列表 (P-02) · 角色详情 (P-03 + P-04) · 外观资源 (P-02). Data: core/roster.js rows, rebuilt in main on
 * every change, so a switch made here shows in the pet window and the other way round.
 */
import { Alert, Button, createStaticStyles, cssVar, Flexbox, Icon, Input, Modal, Segmented, Select, Table, Tag, Text, TextArea, toast } from '@lobehub/ui';
import { PageHeader, PageTabs, Surface } from '@lobehub/ui/dashboard';
import { Check, Download, FolderOpen, Heart, Import, Lock, Shirt, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, reasonText, type PackOption, type PackRow, type RosterRow } from '../api';
import { ask } from '../fields';
import { CharacterStage } from '../stage/CharacterStage';
import { HeartMeter } from '../stage/HeartMeter';
import { SpriteStage } from '../stage/SpriteStage';
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

const gstyles = createStaticStyles(({ css }) => ({
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

/** 角色图鉴: every character as a collectible card — met ones in colour with their hearts, the rest a shadow. */
export const CharactersPage = ({ navigate }: { navigate: (p: string) => void }) => {
  const { roster, view } = useStore();
  const sw = useSwitch();
  const met = roster.filter((c) => c.met).length;
  return (
    <>
      <PageHeader
        action={
          <Button icon={Import} onClick={() => navigate('/packs')}>
            导入角色包…
          </Button>
        }
        description={`已遇见 ${met} / ${roster.length} 位。点开一位，看她的故事、换形象包、调她的模型和设定。`}
        title="角色图鉴"
      />
      {!view && <Alert description="先在桌宠窗口里选一位角色并完成唤醒，之后就能在这里结识和切换她们。" showIcon title="还没有唤醒桌宠" type="info" />}
      <div className={gstyles.grid} data-roster>
        {roster.map((c) => (
          <article className={gstyles.card} data-current={c.current} data-row={c.id} key={c.id} style={{ ['--pet-accent' as string]: c.accent }}>
            <a aria-label={`查看 ${c.nameZh}`} className={gstyles.art} href={`#/characters/${c.id}`}>
              <SpriteStage animate height={184} name={c.nameZh} preview={c.preview} silhouette={!c.met && !c.current} />
              {!c.met && !c.current && (
                <span className={gstyles.locked}>
                  <Icon icon={Lock} size={20} />
                  <Text fontSize={12} type="secondary">
                    未遇见
                  </Text>
                </span>
              )}
              {c.current && (
                <span className={gstyles.ribbon}>
                  <Tag color="success" data-current={c.id}>
                    当前角色
                  </Tag>
                </span>
              )}
              <span className={gstyles.kind}>
                <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />
              </span>
            </a>
            <Flexbox flex={1} gap={8} padding={12}>
              <Flexbox gap={2}>
                <Text ellipsis strong>
                  {c.displayName}
                </Text>
                <Text ellipsis fontSize={12} type="secondary">
                  {c.title}
                </Text>
              </Flexbox>
              <HeartMeter c={c} compact />
              <Text ellipsis fontSize={12} type="secondary">
                {c.pack ? c.pack.name : c.kindLabel} · {c.sourceLabel}
                {c.voicePack ? ` · 语音包 ${c.voicePack.lines} 句` : ''}
              </Text>
              <Flexbox align="center" gap={8} horizontal justify="space-between" style={{ marginBlockStart: 'auto' }}>
                <Button data-detail={c.id} href={`#/characters/${c.id}`} size="small" type="text">
                  详情
                </Button>
                {view && !c.current && <SwitchButton c={c} sw={sw} />}
              </Flexbox>
            </Flexbox>
          </article>
        ))}
      </div>
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

const wstyles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
    gap: 12px;
  `,
  card: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    &[data-worn='true'] {
      border-color: color-mix(in srgb, var(--pet-accent) 70%, transparent);
    }

    &[data-trying='true'] {
      border-style: dashed;
      border-color: var(--pet-accent);
    }
  `,
  cover: css`
    cursor: pointer;

    display: flex;
    align-items: flex-end;
    justify-content: center;

    height: 152px;
    padding: 0;
    border: 0;

    background: color-mix(in srgb, var(--pet-accent) 10%, ${cssVar.colorFillQuaternary});

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  add: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    justify-content: center;

    min-height: 240px;
    padding: 16px;
    border: 1px dashed ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
  `,
}));

const KIND_NAME: Record<string, string> = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };

/**
 * 形象包: her wardrobe. Every pack she can wear as a card with its picture; 试穿 shows it on her stage above,
 * 穿上 dresses her (in the pet window too). Importing new ones sits at the end of the rack.
 */
/**
 * 取景 (docs/half-body-mode.md): her own framing on the desktop — 跟随 (her pack's default, else the global
 * 桌宠行为 → 取景), 全身 or 半身. Saved at once; the pet window re-frames her without reloading the model.
 */
const FramingRow = ({ c }: { c: RosterRow }) => {
  const { view, settings, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const [busy, setBusy] = useState(false);
  const own: string = ch?.framing ?? 'auto';
  const global = settings?.prefs?.framing === 'half' ? '半身' : '全身';
  const packDefault = ch?.look?.framing === 'half' ? '半身' : ch?.look?.framing === 'full' ? '全身' : null;
  const follow = packDefault ? `跟随形象包（${packDefault}）` : `跟随全局（${global}）`;
  const camera = ch?.look?.kind === 'vrm';
  return (
    <Flexbox align="center" data-framing-row={c.id} gap={12} horizontal wrap="wrap">
      <Text strong>取景</Text>
      <div aria-label="取景" data-key={`framings.${c.id}`} role="group">
        <Segmented
          disabled={busy}
          onChange={async (v) => {
            setBusy(true);
            try {
              const r = await api().setFraming(v as 'auto' | 'full' | 'half', c.id);
              if (r && r.view) merge({ view: r.view });
              if (r && r.settings) merge({ settings: r.settings });
              if (r && r.ok) toast.success(`${c.nameZh} 的取景已改为「${v === 'auto' ? follow : v === 'half' ? '半身' : '全身'}」`);
              else toast.error(reasonText(r));
            } finally {
              setBusy(false);
            }
          }}
          options={[
            { label: follow, value: 'auto' },
            { label: '全身', value: 'full' },
            { label: '半身', value: 'half' },
          ]}
          value={own}
        />
      </div>
      <Text fontSize={12} type="secondary">
        {camera ? '半身只显示腰部以上，角色画得更大，窗口不变。立即生效。' : '目前只有 VRM 形象包能半身取景；她现在穿的形象包保持全身。'}
      </Text>
    </Flexbox>
  );
};

const LookTab = ({ c, trying, onTry }: { c: RosterRow; onTry: (id: string | null) => void; trying: string | null }) => {
  const { view, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const options: PackOption[] = ch?.appearance?.options ?? [];
  const run = async (p: Promise<any>, ok: string) => {
    const r = await p;
    if (r && r.view) merge({ view: r.view });
    if (r && r.ok) toast.success(ok);
    else if (r && r.reason !== 'canceled') toast.error(reasonText(r));
    return r;
  };
  if (!view) return <Alert title="唤醒桌宠后可以给她换形象包" type="info" />;
  const worn = (p: PackOption) => p.id === c.pack?.id || (!c.pack && p.kind === 'video');
  return (
    <Flexbox gap={12}>
      <FramingRow c={c} />
      <Text type="secondary">她能穿的角色包。点图片试穿，满意再「穿上」；18+ 包要先确认已满 18 周岁并打开成人向内容。</Text>
      <div className={wstyles.grid} data-wardrobe={c.id}>
        {options.map((p) => (
          <div className={wstyles.card} data-pack={p.id} data-trying={trying === p.id} data-worn={worn(p)} key={p.id}>
            <button aria-label={`试穿「${p.name}」`} className={wstyles.cover} data-try-pack={p.id} onClick={() => onTry(trying === p.id ? null : p.id)} type="button">
              <SpriteStage animate={trying === p.id} height={144} name={p.name} preview={p.cover} />
            </button>
            <Flexbox flex={1} gap={6} padding={12}>
              <Text ellipsis strong>
                {p.name}
              </Text>
              <KindTag adult={p.adult} kind={p.kind} label={KIND_NAME[p.kind] ?? p.kind} />
              <Text ellipsis fontSize={12} type="secondary">
                {p.source === 'user' ? '导入' : '内置'}
                {p.outfits && p.outfits > 1 ? ` · ${p.outfits} 套服饰` : ''}
                {p.author ? ` · ${p.author}` : ''}
              </Text>
              <Flexbox horizontal style={{ marginBlockStart: 'auto' }}>
                {worn(p) ? (
                  <Tag color="success" icon={<Icon icon={Check} />}>
                    正在穿
                  </Tag>
                ) : (
                  <Button
                    data-use-pack={p.id}
                    onClick={async () => {
                      const r = await run(api().setAppearance(p.id, c.id), `${c.nameZh} 换上了「${p.name}」`);
                      if (r && r.ok) onTry(null);
                    }}
                    size="small"
                    type={trying === p.id ? 'primary' : 'default'}
                  >
                    穿上
                  </Button>
                )}
              </Flexbox>
            </Flexbox>
          </div>
        ))}
        <div className={wstyles.add}>
          <Text strong>添加形象包</Text>
          <Text fontSize={12} type="secondary">
            导入的包会出现在这一排里。
          </Text>
          <Button icon={Import} onClick={() => run(api().importPack(), '角色包已导入')} size="small">
            导入角色包…
          </Button>
          <Button onClick={() => run(api().importLive2d(c.id), 'Live2D 模型已导入')} size="small">
            导入 Live2D…
          </Button>
          <Button onClick={() => run(api().importVrm(c.id), 'VRM 模型已导入')} size="small">
            导入 VRM…
          </Button>
        </div>
      </div>
    </Flexbox>
  );
};

const astyles = createStaticStyles(({ css }) => ({
  road: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 8px;
  `,
  step: css`
    display: flex;
    flex-direction: column;
    gap: 4px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    color: ${cssVar.colorTextTertiary};

    &[data-reached='true'] {
      border-color: color-mix(in srgb, var(--pet-accent) 40%, transparent);
      color: ${cssVar.colorText};
      background: color-mix(in srgb, var(--pet-accent) 8%, transparent);
    }

    &[data-here='true'] {
      border-color: var(--pet-accent);
    }
  `,
}));

/** 好感: the relationship as a road — every stage a step, the reached ones lit, where she is now marked. */
const AffectionTab = ({ c }: { c: RosterRow }) => {
  const { merge } = useStore();
  if (!c.met) return <Alert title="还没遇见她：切换到她并起个名字之后才有好感" type="info" />;
  const p = c.met.progress ?? {};
  const value = p.value ?? c.met.affection;
  const stages: { id: string; min: number; name: string }[] = p.stages ?? [];
  return (
    <Surface description="好感随你们的互动上涨；每到一个阶段，会解锁新的话题和服饰。" title="你们的关系" style={{ ['--pet-accent' as string]: c.accent }}>
      <Flexbox gap={16}>
        <HeartMeter c={c} />
        {stages.length > 0 && (
          <div className={astyles.road} data-road={c.id}>
            {stages.map((s) => (
              <div className={astyles.step} data-here={p.stage === s.id} data-reached={value >= s.min} key={s.id}>
                <Flexbox align="center" gap={6} horizontal>
                  <Icon fill={value >= s.min ? 'currentColor' : 'none'} icon={value >= s.min ? Heart : Lock} size={14} style={value >= s.min ? { color: c.accent } : undefined} />
                  <Text strong={p.stage === s.id}>{s.name}</Text>
                </Flexbox>
                <Text fontSize={12} type="secondary">
                  {p.stage === s.id ? '现在' : value >= s.min ? '已解锁' : `好感 ${s.min} 解锁`}
                </Text>
              </div>
            ))}
          </div>
        )}
        <Flexbox align="center" gap={12} horizontal justify="space-between">
          <Text fontSize={12} type="secondary">
            想直接看到全部内容？一键解锁会把好感拉满，不能撤销。
          </Text>
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

const dstyles = createStaticStyles(({ css }) => ({
  hero: css`
    display: grid;
    grid-template-columns: minmax(260px, 5fr) 6fr;
    gap: 32px;
    align-items: start;

    @media (width <= 900px) {
      grid-template-columns: 1fr;
    }
  `,
  quote: css`
    margin: 0;
    padding-block: 8px;
    padding-inline: 16px;
    border-radius: ${cssVar.borderRadiusLG};

    line-height: 1.6;

    background: color-mix(in srgb, var(--pet-accent) 10%, ${cssVar.colorFillQuaternary});
  `,
}));

type DetailTab = 'looks' | 'affection' | 'model' | 'role' | 'voice' | 'about';

/** 角色详情: her on a big stage (tap her, play her actions, try packs on), her story, and her settings below. */
export const CharacterDetailPage = ({ id }: { id: string; navigate: (p: string) => void }) => {
  const { roster, view } = useStore();
  const sw = useSwitch();
  const [tab, setTab] = useState<DetailTab>('looks');
  const [trying, setTrying] = useState<string | null>(null);
  const c = roster.find((x) => x.id === id);
  const ch = view?.characters?.find((x: any) => x.id === id);
  if (!c) return <Alert title={`没有角色「${id}」`} type="error" />;
  const tryOpt: PackOption | undefined = trying ? (ch?.appearance?.options ?? []).find((o: PackOption) => o.id === trying) : undefined;
  const tts = c.voice?.tts;
  return (
    <>
      <div className={dstyles.hero} style={{ ['--pet-accent' as string]: c.accent }}>
        <CharacterStage
          actions
          badge={c.current ? <Tag color="success">正在陪你</Tag> : !c.met ? <Tag>未遇见</Tag> : undefined}
          c={c}
          corner={
            tryOpt ? (
              <Tag closable color="processing" data-trying-tag onClose={() => setTrying(null)}>
                试穿：{tryOpt.name}
              </Tag>
            ) : undefined
          }
          height={420}
          preview={tryOpt ? (tryOpt.cover ?? null) : undefined}
        />
        <Flexbox gap={16}>
          <Flexbox gap={4}>
            <Flexbox align="center" gap={8} horizontal wrap="wrap">
              <Text as="h1" data-character-title={c.id} fontSize={28} strong style={{ lineHeight: 1.25, margin: 0 }}>
                {c.displayName}
              </Text>
              <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />
            </Flexbox>
            <Text type="secondary">{c.title}</Text>
          </Flexbox>
          {c.catchphrase && <blockquote className={dstyles.quote}>「{c.catchphrase}」</blockquote>}
          {c.blurb && <Text style={{ lineHeight: 1.7 }}>{c.blurb}</Text>}
          {c.likes?.length > 0 && (
            <Flexbox align="center" gap={6} horizontal wrap="wrap">
              <Text fontSize={12} type="secondary">
                喜欢
              </Text>
              {c.likes.map((x) => (
                <Tag key={x} size="small">
                  {x}
                </Tag>
              ))}
            </Flexbox>
          )}
          <HeartMeter c={c} />
          <Flexbox align="center" gap={8} horizontal wrap="wrap">
            {view && <SwitchButton c={c} sw={sw} />}
            <Button icon={Shirt} onClick={() => setTab('looks')} size="small" type="text">
              {c.pack ? `正在穿：${c.pack.name}` : `${c.packCount} 个形象包`}
            </Button>
          </Flexbox>
        </Flexbox>
      </div>
      <PageTabs
        label="角色详情"
        onChange={setTab}
        tabs={[
          { content: <LookTab c={c} onTry={setTrying} trying={trying} />, label: '形象包', value: 'looks' },
          { content: <AffectionTab c={c} />, label: '好感', value: 'affection' },
          { content: <ModelTab c={c} />, label: '模型', value: 'model' },
          { content: <RoleTab c={c} />, label: '个性化设定', value: 'role' },
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
                    角色音色写在角色文件里，只读。语音包可以在 设置 → 语音包 里重新读取或替换。
                  </Text>
                </Flexbox>
              </Surface>
            ),
            label: '语音',
            value: 'voice',
          },
          {
            content: (
              <Surface title="资料">
                <Flexbox gap={12}>
                  <Info label="厂商">{c.vendor}</Info>
                  <Info label="当前外观">{c.pack ? `${c.pack.name}（${c.sourceLabel}）` : c.kind === 'video' ? '原版动画' : '--'}</Info>
                  <Info label="模型">{c.model?.current ? modelLabel(c, c.model.current) : '--'}</Info>
                  <Info label="素材署名">
                    <Flexbox gap={4}>{c.credits.length ? c.credits.map((x) => <Text key={x} type="secondary">{x}</Text>) : '--'}</Flexbox>
                  </Info>
                </Flexbox>
              </Surface>
            ),
            label: '资料',
            value: 'about',
          },
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
