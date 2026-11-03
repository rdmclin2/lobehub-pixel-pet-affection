/**
 * 角色列表 (P-02) · 角色详情 (P-03 + P-04) · 外观资源 (P-02). Data: core/roster.js rows, rebuilt in main on
 * every change, so a switch made here shows in the pet window and the other way round.
 */
import { Alert, Button, createStaticStyles, cssVar, Flexbox, Icon, Input, Modal, Segmented, Select, Slider, Table, Tag, Text, TextArea, toast } from '@lobehub/ui';
import { PageHeader, PageTabs, Surface } from '@lobehub/ui/dashboard';
import { Check, Download, FolderOpen, Heart, Import, Lock, Shirt, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api, reasonText, type OutfitRow, type PackOption, type PackRow, type RosterRow } from '../api';
import { ask } from '../fields';
import { CharacterStage } from '../stage/CharacterStage';
import { HeartMeter } from '../stage/HeartMeter';
import { SpriteStage } from '../stage/SpriteStage';
import { VrmLicense, vrmUi } from '../stage/VrmLicense';
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
  const [kind, setKind] = useState('all');
  // 按形象类型: every kind any character can wear, plus 有导入包 (a character with an imported pack of any kind)
  const kinds = [...new Map(roster.flatMap((c) => c.packKinds ?? []).map((k) => [k.kind, k.label])).entries()];
  const shown = roster.filter((c) => kind === 'all' || (kind === 'user' ? (c.packKinds ?? []).some((k) => k.user > 0) : (c.packKinds ?? []).some((k) => k.kind === kind)));
  return (
    <>
      <PageHeader
        action={
          <Button icon={Import} onClick={() => navigate('/packs')}>
            导入角色包…
          </Button>
        }
        description={`已遇见 ${met} / ${roster.length} 位。每个形象都是一个独立角色；点开一位，看她的故事、衣柜、模型和设定。`}
        title="角色图鉴"
      />
      {!view && <Alert description="先在桌宠窗口里选一位角色并完成唤醒，之后就能在这里结识和切换她们。" showIcon title="还没有唤醒桌宠" type="info" />}
      <Flexbox align="center" data-kind-filter gap={8} horizontal wrap="wrap">
        <Text fontSize={12} type="secondary">
          按形象类型
        </Text>
        <Segmented
          onChange={(v) => setKind(String(v))}
          options={[{ label: `全部 ${roster.length}`, value: 'all' }, ...kinds.map(([value, label]) => ({ label: `${label} ${roster.filter((c) => (c.packKinds ?? []).some((k) => k.kind === value)).length}`, value })), { label: `导入的角色 ${roster.filter((c) => (c.packKinds ?? []).some((k) => k.user > 0)).length}`, value: 'user' }]}
          size="small"
          value={kind}
        />
      </Flexbox>
      <div className={gstyles.grid} data-roster data-roster-filter={kind}>
        {shown.map((c) => (
          <article className={gstyles.card} data-current={c.current} data-row={c.id} key={c.id} style={{ ['--pet-accent' as string]: c.accent }}>
            <a aria-label={`查看 ${c.name ?? c.nameZh}`} className={gstyles.art} href={`#/characters/${c.id}`}>
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
              <Flexbox data-pack-kinds={c.id} gap={4} horizontal wrap="wrap">
                {(c.packKinds ?? []).map((k) => (
                  <Tag color={KIND_COLOR[k.kind]} key={k.kind} size="small">
                    {k.label}
                    {k.user ? ` · 导入 ${k.user}` : ''}
                  </Tag>
                ))}
              </Flexbox>
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
    <Flexbox gap={16}>
    {c.personality && (
      <Surface description="写在她的角色文件里，是她 system role 的底子（只读）。下面的个性化设定会加在它后面。" title="她的设定">
        <Text data-personality={c.id} style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {c.personality}
        </Text>
      </Surface>
    )}
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
    </Flexbox>
  );
};

const wstyles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
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

    height: 136px;
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

    min-height: 224px;
    padding: 16px;
    border: 1px dashed ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
  `,
}));

const KIND_NAME: Record<string, string> = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };

/** One outfit of the current character's wardrobe (view.outfits, as the pet window's 衣柜 lists it). */
/**
 * 衣柜: the outfits of the pack she wears, as chips. Only the character with you now can change (it is saved
 * with the pet); her stage on the left shows the new one the moment main confirms it. Chips, not pictures:
 * each outfit is a whole sprite sheet, and decoding a dozen of them for thumbnails is what made the console
 * stutter before.
 */
const OutfitRack = ({ c }: { c: RosterRow }) => {
  const { view, merge } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  // outfits new since she last looked keep a 新 tag while the rack is open; main forgets them right away
  const fresh = useRef<Set<string> | null>(null);
  if (view && c.current && fresh.current === null) fresh.current = new Set((view.outfits ?? []).filter((o: OutfitRow) => o.isNew).map((o: OutfitRow) => o.id));
  useEffect(() => {
    if (c.current && fresh.current?.size) api().markSeen('outfit').catch(() => {});
  }, [c.current]);
  if (!view) return null;
  if (!c.current)
    return (
      <Surface description="衣柜跟着当前陪你的角色走：切换到她之后可以在这里换衣服。" title="衣柜">
        <Text fontSize={12} type="secondary">
          现在陪你的是 {view.species?.nameZh ?? '别人'}。
        </Text>
      </Surface>
    );
  const list: OutfitRow[] = view.outfits ?? [];
  const open = list.filter((o) => !o.locked).length;
  return (
    <Surface description={`当前形象包里的服饰，已解锁 ${open} / ${list.length} 套。点一下就换上，左边立刻看到效果，桌宠窗口同步。`} title="衣柜">
      <Flexbox data-outfits={c.id} gap={8} horizontal wrap="wrap">
        {list.map((o) => (
          <Button
            aria-pressed={o.equipped}
            data-equipped={o.equipped}
            data-outfit={o.id}
            disabled={o.locked}
            icon={o.locked ? Lock : o.equipped ? Check : undefined}
            key={o.id}
            loading={busy === o.id}
            onClick={async () => {
              if (o.equipped) return;
              setBusy(o.id);
              try {
                const r = await api().equipOutfit(o.id);
                if (r && r.view) merge({ view: r.view });
                if (r && r.ok) toast.success(`换好了：「${o.label}」`);
                else toast.error(r && r.reason === 'locked' ? `「${o.label}」还没解锁：${r.condition}` : '这件现在不能穿');
              } finally {
                setBusy(null);
              }
            }}
            size="small"
            title={o.locked ? (o.condition ?? '还没解锁') : o.desc}
            {...(o.equipped ? { color: 'primary' as const, variant: 'outlined' as const } : {})}
          >
            {o.label}
            {fresh.current?.has(o.id) && (
              <Tag color="error" data-new-outfit size="small" style={{ marginInlineStart: 4 }}>
                新
              </Tag>
            )}
          </Button>
        ))}
      </Flexbox>
    </Surface>
  );
};

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
  const camera = ch?.look?.kind === 'vrm' || ch?.look?.kind === 'live2d';
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
              if (r && r.ok) toast.success(`${c.name ?? c.nameZh} 的取景已改为「${v === 'auto' ? follow : v === 'half' ? '半身' : '全身'}」`);
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
        {camera ? '半身只显示腰部以上，角色画得更大，窗口不变。立即生效。' : '目前只有 VRM 和 Live2D 形象包能半身取景；她现在穿的形象包保持全身。'}
      </Text>
    </Flexbox>
  );
};

/**
 * VRM 姿势 (docs/vrm-motion-system.md): the posture her VRM pack stands (or sits) in, kept per pack
 * (settings.vrmPostures); 自动 lets her change it herself while idle. Only shown while she wears a VRM pack.
 */
const POSTURE_LABEL: Record<string, string> = { auto: '自动', 'stand.relaxed': '放松站', 'stand.confident': '叉腰站', 'stand.shy': '害羞站', 'stand.playful': '俏皮站', 'sit.rest': '坐着', 'sit.doze': '靠坐' };
const PostureRow = ({ c }: { c: RosterRow }) => {
  const { view, settings, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const [busy, setBusy] = useState(false);
  const packId: string | undefined = ch?.look?.kind === 'vrm' ? ch?.look?.packId : undefined;
  if (!packId) return null;
  const own: string = settings?.vrmPostures?.[packId] ?? 'auto';
  return (
    <Flexbox align="center" data-posture-row={c.id} gap={12} horizontal wrap="wrap">
      <Text strong>VRM 姿势</Text>
      <div aria-label="VRM 姿势" data-key={`vrmPostures.${packId}`} role="group">
        <Select
          disabled={busy}
          onChange={async (v: string) => {
            setBusy(true);
            try {
              const r = await api().setVrmPosture(packId, v);
              if (r && r.settings) merge({ settings: r.settings });
              if (r && r.ok) toast.success(`${c.name ?? c.nameZh} 的姿势已设为「${POSTURE_LABEL[v] ?? v}」`);
              else toast.error(reasonText(r));
            } finally {
              setBusy(false);
            }
          }}
          options={Object.entries(POSTURE_LABEL).map(([value, label]) => ({ label, value }))}
          style={{ minWidth: 120 }}
          value={own}
        />
      </div>
      <Text fontSize={12} type="secondary">按这个 VRM 形象包记住。自动：待机时她自己换姿势。立即生效。</Text>
    </Flexbox>
  );
};

/**
 * 装扮: her wardrobe — the outfits of her own pack — then her look (T-2764: one pack per character, there is no
 * 形象包 to choose: every pack is a character of her own). Importing a pack / a Live2D / a VRM model adds a new
 * character on her base and switches to her (same agent and affection when it is the companion's base).
 */
const LookTab = ({ c, trying, onTry }: { c: RosterRow; onTry: (id: string | null) => void; trying: string | null }) => {
  const { view, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const options: PackOption[] = ch?.pack ? [ch.pack] : [];
  const run = async (p: Promise<any>, ok: string) => {
    const r = await p;
    if (r && r.view) merge({ view: r.view });
    if (r && r.ok) toast.success(ok);
    else if (r && r.reason !== 'canceled') toast.error(reasonText(r));
    return r;
  };
  // a freshly imported pack is a new character: be her, and open her page
  const becomeNew = async (id: string, ok: string) => {
    const r = await run(api().switchCharacter(id), ok);
    if (r && r.ok) location.hash = `/characters/${id}`;
    return r;
  };
  // 导入 VRM…: main checks the file and copies it into a new user pack; before she wears it, 导入确认 shows who
  // made the model and what its license allows. 取消导入 removes the pack again; 授权信息 stays on the card.
  const [vrmImport, setVrmImport] = useState<any>(null);
  const [licenseOf, setLicenseOf] = useState<PackOption | null>(null);
  const importVrm = async () => {
    const r = await api().importVrm(c.id);
    if (!r || r.reason === 'canceled') return;
    if (!r.ok) return void toast.error(vrmUi().importErrorText(r.errors));
    setVrmImport(r);
  };
  const closeVrmImport = async (use: boolean) => {
    const r = vrmImport;
    setVrmImport(null);
    if (!r) return;
    if (!use) {
      await api().removePack(r.pack.id);
      toast.success(`已取消导入「${r.pack.name}」，模型没有留在本机的角色包里。`);
      return;
    }
    await becomeNew(r.pack.id, `已导入 VRM 模型「${r.pack.name}」，成为新角色（作者：${r.license?.author ?? '未署名'}）`);
  };
  if (!view) return <Alert title="唤醒桌宠后可以给她换装扮" type="info" />;
  const worn = (_p: PackOption) => true; // her own and only pack
  return (
    <Flexbox gap={16}>
      <Modal
        cancelText="取消导入"
        destroyOnHidden
        maskClosable={false}
        okText="使用这个模型"
        onCancel={() => closeVrmImport(false)}
        onOk={() => closeVrmImport(true)}
        open={!!vrmImport}
        title={vrmImport ? `导入 VRM 模型「${vrmImport.pack.name}」` : ''}
      >
        {vrmImport && (
          <Flexbox data-vrm-confirm={vrmImport.pack.id} gap={12}>
            <Text type="secondary">
              {`${vrmImport.outfits?.length ?? 1} 套全年龄服饰都会穿这个模型。以下信息读自模型文件，应用会按授权限制使用；点“使用这个模型”即表示你确认有权在本机使用它。`}
            </Text>
            <VrmLicense packId={vrmImport.pack.id} vrm={{ ...vrmImport.license, models: [{ file: '', meta: vrmImport.meta, restrictions: vrmImport.license?.restrictions }] }} />
          </Flexbox>
        )}
      </Modal>
      <Modal footer={null} onCancel={() => setLicenseOf(null)} open={!!licenseOf} title={licenseOf ? `授权信息：${licenseOf.name}` : ''}>
        {licenseOf && <VrmLicense packId={licenseOf.id} vrm={licenseOf.vrm} />}
      </Modal>
      <OutfitRack c={c} />
      <FramingRow c={c} />
      <PostureRow c={c} />
      <Surface description="这个角色的形象。每个角色包都是一个独立角色；导入新的包会成为新角色。" title="形象">
        <div className={wstyles.grid} data-wardrobe={c.id}>
          {options.map((p) => (
            <div className={wstyles.card} data-pack={p.id} data-trying={trying === p.id} data-worn={worn(p)} key={p.id}>
              <button aria-label={`试穿「${p.name}」`} className={wstyles.cover} data-try-pack={p.id} onClick={() => onTry(trying === p.id ? null : p.id)} type="button">
                <SpriteStage animate={trying === p.id} height={128} name={p.name} preview={p.cover} />
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
                {p.kind === 'vrm' && p.vrm && vrmUi().creditLine(p.vrm) && (
                  <Text data-vrm-credit={p.id} fontSize={12} type="secondary">
                    {vrmUi().creditLine(p.vrm)}
                  </Text>
                )}
                {p.kind === 'vrm' && p.source === 'user' && !vrmUi().exportState(p).ok && (
                  <Text data-vrm-noexport={p.id} fontSize={12} type="secondary">
                    {`导出已禁用：${vrmUi().exportState(p).text}`}
                  </Text>
                )}
                <Flexbox gap={4} horizontal style={{ marginBlockStart: 'auto' }} wrap="wrap">
                  {worn(p) && (
                    <Tag color="success" icon={<Icon icon={Check} />}>
                      她的形象
                    </Tag>
                  )}
                  {p.kind === 'vrm' && p.vrm && (
                    <Button data-vrm-info={p.id} onClick={() => setLicenseOf(p)} size="small" type="text">
                      授权信息
                    </Button>
                  )}
                </Flexbox>
              </Flexbox>
            </div>
          ))}
          <div className={wstyles.add}>
            <Text strong>添加角色</Text>
            <Text fontSize={12} type="secondary">
              {`导入的包会成为${c.nameZh}的一个新角色，出现在角色图鉴里。`}
            </Text>
            <Button icon={Import} onClick={() => run(api().importPack(), '角色包已导入，成为新角色')} size="small">
              导入角色包…
            </Button>
            <Button
              data-import-live2d
              onClick={async () => {
                // the imported model is a new character on her base: she becomes her at once
                const r = await api().importLive2d(c.id);
                if (!r || r.reason === 'canceled') return;
                if (!r.ok) return void toast.error({ description: (r.errors ?? []).slice(0, 3).join('；') || reasonText(r), title: 'Live2D 导入失败' });
                await becomeNew(r.pack.id, `已导入 Live2D 模型「${r.pack.name}」，成为新角色`);
              }}
              size="small"
            >
              导入 Live2D…
            </Button>
            <Button data-import-vrm onClick={importVrm} size="small">
              导入 VRM…
            </Button>
          </div>
        </div>
      </Surface>
      <Live2dSize c={c} options={options} />
    </Flexbox>
  );
};

/** 模型大小: how much of the pet window an imported Live2D model she wears fills (the pet window's slider, saved in the pack). */
const Live2dSize = ({ c, options }: { c: RosterRow; options: PackOption[] }) => {
  const mine = options.find((o) => o.id === c.pack?.id && o.kind === 'live2d' && o.source === 'user');
  const [v, setV] = useState<number>(Math.round((mine?.height ?? 1) * 100));
  useEffect(() => setV(Math.round((mine?.height ?? 1) * 100)), [mine?.id, mine?.height]);
  if (!mine) return null;
  return (
    <Surface description="她穿的是导入的 Live2D 模型：调整模型占桌宠窗口的高度。松手后保存，桌宠窗口立即重绘。" title="Live2D 模型大小">
      <Flexbox align="center" data-live2d-size={mine.id} gap={12} horizontal>
        <Slider
          max={100}
          min={30}
          onChange={(x) => setV(Number(x))}
          onChangeComplete={async (x) => {
            const r = await api().setLive2dHeight(mine.id, Number(x) / 100);
            if (r && r.ok) toast.success(`模型大小 → ${x}%`);
            else toast.error(reasonText(r));
          }}
          step={5}
          style={{ flex: 1 }}
          value={v}
        />
        <Text code>{v}%</Text>
      </Flexbox>
    </Surface>
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
  // two columns: her stage on the left (stays in view while the panels on the right scroll), her story and
  // settings on the right; one column (stage on top, not pinned) when the window is narrow
  layout: css`
    display: grid;
    grid-template-columns: minmax(280px, 400px) minmax(0, 1fr);
    gap: 32px;
    align-items: start;

    @media (width <= 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  showcase: css`
    position: sticky;
    z-index: 1;
    inset-block-start: 16px;

    display: flex;
    flex-direction: column;
    gap: 12px;

    min-width: 0;

    @media (width <= 860px) {
      position: static;
    }
  `,
  panels: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
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

type DetailTab = 'looks' | 'outfits' | 'affection' | 'model' | 'role' | 'voice' | 'about';

const STAGE_MIN = 320;
const STAGE_MAX = 640;

/**
 * How tall her stage is: as wide as its column allows (her frames are portrait), never taller than the window
 * leaves room for. Rounded to 40 px steps: each height cuts its own cells from her sheet, so a window drag
 * re-cuts a few times, not on every pixel.
 */
const useStageHeight = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const byWidth = el.clientWidth * 1.25;
      const byWindow = window.innerHeight - 200;
      const h = Math.max(STAGE_MIN, Math.min(STAGE_MAX, byWidth, byWindow));
      setHeight(Math.floor(h / 40) * 40);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);
  return { height, ref };
};

/**
 * 角色详情: her stage on the left — what she wears now, played action by action, tap to pat, a pack being
 * tried on — and on the right her story, hearts and every setting of hers. A change of look made on the
 * right comes back as a new roster row (main rebuilds it on every change) and the stage redraws at once.
 */
export const CharacterDetailPage = ({ id }: { id: string; navigate: (p: string) => void }) => {
  const { roster, view } = useStore();
  const sw = useSwitch();
  const [tab, setTab] = useState<DetailTab>('looks');
  const [trying, setTrying] = useState<string | null>(null);
  const stage = useStageHeight();
  useEffect(() => setTrying(null), [id]);
  // an old link names her base (`#/characters/dafeiyu`, before T-2764): the current one of that base, else her first
  const c = roster.find((x) => x.id === id) ?? roster.find((x) => x.base === id && x.current) ?? roster.find((x) => x.base === id);
  const ch = view?.characters?.find((x: any) => x.id === c?.id);
  if (!c) return <Alert title={`没有角色「${id}」`} type="error" />;
  const tryOpt: PackOption | undefined = trying && ch?.pack?.id === trying ? ch.pack : undefined;
  const outfit: OutfitRow | undefined = c.current ? (view?.outfits ?? []).find((o: OutfitRow) => o.equipped) : undefined;
  const tts = c.voice?.tts;
  const wearing = c.pack ? c.pack.name : c.kind === 'video' ? '原版动画' : c.kindLabel;
  return (
    <>
      <div className={dstyles.layout} data-detail-layout={c.id} style={{ ['--pet-accent' as string]: c.accent }}>
        <aside aria-label={`${c.name ?? c.nameZh} 的展示区`} className={dstyles.showcase} data-showcase={c.id} ref={stage.ref}>
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
            height={stage.height}
            preview={tryOpt ? (tryOpt.cover ?? null) : undefined}
          />
          <Flexbox align="center" gap={8} horizontal justify="space-between" wrap="wrap">
            <Flexbox align="center" gap={6} horizontal style={{ minWidth: 0 }}>
              <Icon icon={Shirt} size={14} style={{ color: c.accent, flex: 'none' }} />
              <Text data-worn-caption={c.id} ellipsis fontSize={12} type="secondary">
                {tryOpt ? `试穿中：${tryOpt.name}（还没保存）` : `正在穿：${wearing}${outfit ? ` · ${outfit.label}` : ''}`}
              </Text>
            </Flexbox>
            {view && <SwitchButton c={c} sw={sw} />}
          </Flexbox>
        </aside>
        <div className={dstyles.panels}>
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
          <PageTabs
            label="角色详情"
            onChange={setTab}
            tabs={[
              { content: <LookTab c={c} onTry={setTrying} trying={trying} />, label: '装扮', value: 'looks' },
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
                      <Info label="可穿的形象">
                        <Flexbox gap={4} horizontal wrap="wrap">
                          {(c.packKinds ?? []).length ? c.packKinds.map((k) => <Tag color={KIND_COLOR[k.kind]} key={k.kind}>{`${k.label} · 内置 ${k.builtin} · 导入 ${k.user}`}</Tag>) : '--'}
                        </Flexbox>
                      </Info>
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
        </div>
      </div>
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
                    <Button data-export-pack={p.id} disabled={!p.exportable} icon={Download} onClick={() => run(api().exportPack(p.id), `已导出「${p.name}」`)} size="small" type="text">
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
