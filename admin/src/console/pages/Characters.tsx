/**
 * 角色列表 (P-02) · 角色详情 (P-03 + P-04) · 角色包 / 导入角色 (P-02). Data: core/roster.js rows, rebuilt in main on
 * every change, so a switch made here shows in the pet window and the other way round.
 */
import { Alert, Button, createStaticStyles, cssVar, Flexbox, Icon, Input, Modal, Progress, Segmented, Select, Slider, Table, Tag, Text, TextArea, toast } from '@lobehub/ui';
import { PageHeader, PageTabs, Surface } from '@lobehub/ui/dashboard';
import { Check, Download, FolderOpen, Heart, Import, Lock, Shirt, Store, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api, reasonText, type CatalogRow, type DownloadProgress, type OutfitRow, type PackOption, type PackRow, type RosterRow, type VoicePackOption } from '../api';
import { ask } from '../fields';
import { CharacterStage } from '../stage/CharacterStage';
import { HeartMeter } from '../stage/HeartMeter';
import { SpriteStage } from '../stage/SpriteStage';
import { LicenseRows, VrmLicense, vrmUi } from '../stage/VrmLicense';
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
  // a 通用设定 character belongs to no vendor: name the provider whose key it is
  const owner = c.vendor === '通用' ? String(o.providerId) : c.vendor;
  return o.hosted ? String(o.label ?? o.key) : `${o.label ?? o.key}（自己的 ${owner} Key）`;
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
    // a generic VRM companion (通用设定) is called by her model's name unless the owner picks another
    setName(c.vendor === '通用' ? [...(c.nameZh ?? '')].slice(0, 12).join('') : '');
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

const KIND_ORDER = ['sprites', 'pictures', 'rig', 'live2d', 'vrm', 'video'];

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
export { gstyles as storeStyles };

export const CatalogCard = ({ d, p, onDownload }: { d: CatalogRow; onDownload: () => void; p?: DownloadProgress }) => {
  const busy = downloading(p);
  const [license, setLicense] = useState(false);
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
          {[d.sizeLabel, d.kind === 'vrm' ? d.author : d.outfits ? `${d.outfits} 套服饰` : '', d.license].filter(Boolean).join(' · ')}
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
          {d.licenseRows && d.licenseRows.length > 0 && (
            <Button data-store-license-open={d.id} onClick={() => setLicense(true)} size="small" type="text">
              授权
            </Button>
          )}
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
      {d.licenseRows && (
        <Modal footer={null} onCancel={() => setLicense(false)} open={license} title={`「${d.name}」的授权`} width={520}>
          <Flexbox gap={12}>
            <Text fontSize={12} type="secondary">
              {d.redistributable ? '模型声明允许再分发。' : '模型没有声明允许再分发。'}使用前请阅读授权条款；授权信息读自模型文件。
            </Text>
            <LicenseRows id={d.id} rows={d.licenseRows} />
          </Flexbox>
        </Modal>
      )}
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

/**
 * 角色图鉴: every character as a collectible card — met ones in colour with their hearts, the rest a shadow.
 * One card per character (T-2764): 「大肥鱼 · 像素」 and 「大肥鱼 · Live2D」 are two of them, each its own look.
 */
export const CharactersPage = ({ navigate }: { navigate: (p: string) => void }) => {
  const { roster, view, catalog: cat } = useStore();
  // 商店 holds what can be downloaded (pages/Store.tsx); the 图鉴 lists only characters on this machine
  const catalog = cat ?? [];
  const sw = useSwitch();
  const dl = useDownloads();
  const met = roster.filter((c) => c.met).length;
  const [kind, setKind] = useState('all');
  // 按形象类型: each character has one kind; 导入的 = from a pack you imported
  const kinds = KIND_ORDER.filter((k) => roster.some((c) => c.kind === k));
  const user = roster.filter((c) => c.source === 'user').length;
  const shown = roster.filter((c) => kind === 'all' || (kind === 'user' ? c.source === 'user' : c.kind === kind));
  const remote = catalog.filter((d) => !d.installed);
  const pending = view?.pendingDownload as { id: string; name: string; sizeLabel: string } | null | undefined;
  const pendingRow = pending ? catalog.find((d) => d.id === pending.id) : undefined;
  return (
    <>
      <PageHeader
        action={
          <Button data-go-import icon={Import} onClick={() => navigate('/packs')}>
            导入角色
          </Button>
        }
        description={`已遇见 ${met} / ${roster.length} 位。每种形象都是一位独立角色；更多角色在商店里下载。`}
        title="角色图鉴"
      />
      {!view && <Alert description="先在桌宠窗口里选一位角色并完成唤醒，之后就能在这里结识和切换她们。" showIcon title="还没有唤醒桌宠" type="info" />}
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
            { label: `全部 ${roster.length}`, value: 'all' },
            ...kinds.map((k) => ({ label: `${KIND_NAME[k] ?? k} ${roster.filter((c) => c.kind === k).length}`, value: k })),
            ...(user ? [{ label: `导入的 ${user}`, value: 'user' }] : []),
          ]}
          size="small"
          value={kind}
        />
      </Flexbox>
      <div className={gstyles.grid} data-roster data-roster-filter={kind}>
        {shown.map((c) => (
          <article className={gstyles.card} data-current={c.current} data-kind={c.kind ?? ''} data-row={c.id} key={c.id} style={{ ['--pet-accent' as string]: c.accent }}>
            <a aria-label={`查看 ${c.name ?? c.nameZh}`} className={gstyles.art} href={`#/characters/${c.id}`}>
              <SpriteStage animate height={184} name={c.name ?? c.nameZh} preview={c.preview} silhouette={!c.met && !c.current} />
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
              {/* the 语音包 in force (专属 / 通用·男 / 通用·女), its name and lines on hover: the card line is short */}
              <Text data-row-meta={c.id} ellipsis fontSize={12} title={c.voicePack ? `语音包：${packText(c.voicePack)}（${c.voicePack.sourceLabel}）` : undefined} type="secondary">
                {[c.sourceLabel, c.pack?.outfits ? `${c.pack.outfits} 套服饰` : '', c.voicePack ? `语音包 ${c.voicePack.label}` : ''].filter(Boolean).join(' · ')}
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
      {remote.length > 0 && (
        <Flexbox align="center" data-store-hint gap={8} horizontal justify="space-between" wrap="wrap">
          <Text fontSize={12} type="secondary">
            {`商店里还有 ${remote.length} 位角色可以下载。`}
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
    <Surface
      description={`她的 agent 用哪个模型。${c.vendor === '通用' ? '她用通用设定，不限厂商，列出所有可用的模型' : '只列她所属厂商的模型'}；当前角色改动后立即在后台应用。`}
      title="模型"
    >
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

const GENDER_ZH: Record<string, string> = { female: '女', male: '男' };
const GROUP_LABEL: Record<VoicePackOption['group'], string> = { generic: '通用语音包', other: '其他角色的语音包', own: '专属语音包' };

/** One pack as the picker and her page name it: 「专属 · 克洛蒂语音 · 219 句」. */
const packText = (p: { label: string; lines: number; name: string }) => [p.label, p.name, p.lines ? `${p.lines} 句` : '还没有录好的台词'].join(' · ');

/** Why this pack: 手动指定 / 自动（专属）/ 自动回退（按性别：男）. */
const sourceText = (c: RosterRow) => {
  const v = c.voicePack;
  if (!v) return '';
  if (v.source === 'user') return '手动指定';
  if (v.source === 'default') return '自动 · 跟随我的语音包（设置 → 语音包）';
  if (v.source === 'own') return '自动 · 她有专属语音包';
  return `自动回退 · 按性别（${GENDER_ZH[c.voicePackPick.gender ?? 'female']}）用通用语音包`;
};

/**
 * 语音: which 语音包 she uses. 自动 = her own one, else the generic pack of her gender; or one picked here.
 * A pick is saved (settings.tts.voicePackByCharacter) and is in force from her next line (main.js set-voice-pack).
 */
const VoiceTab = ({ c }: { c: RosterRow }) => {
  const { merge } = useStore();
  const [busy, setBusy] = useState(false);
  const pick = c.voicePackPick;
  const v = c.voicePack;
  const tts = c.voice?.tts;
  const groups = (['own', 'generic', 'other'] as const)
    .map((g) => ({ label: GROUP_LABEL[g], options: pick.options.filter((o) => o.group === g).map((o) => ({ label: packText(o), value: o.id })) }))
    .filter((g) => g.options.length > 0);
  const autoText = pick.userChoice && pick.userChoice !== 'auto' ? '自动（跟随我的语音包）' : '自动（按性别）';
  const options = [{ label: `${autoText}${v && pick.choice === 'auto' ? ` · 现在是 ${v.label}` : ''}`, value: 'auto' }, ...groups];
  const onPick = async (id: string) => {
    setBusy(true);
    try {
      const r = await api().setVoicePack(c.base, id);
      if (r && r.settings) merge({ settings: r.settings });
      if (r && r.ok) toast.success(id === 'auto' ? `${c.nameZh} 的语音包：自动` : `${c.nameZh} 的语音包：${pick.options.find((o) => o.id === id)?.name ?? id}`);
      else toast.error({ description: reasonText(r), title: '没能切换语音包' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Flexbox gap={16}>
      <Surface description="她说话用哪个语音包。录好的台词直接播放，其余的用语音包的音色朗读。切换后她的下一句就用新的语音包。" title="语音包">
        <Flexbox gap={12}>
          <div data-voice-pack-select={c.base}>
            <Select aria-label="语音包" disabled={busy || !pick.options.length} loading={busy} onChange={(x) => x && onPick(String(x))} options={options} style={{ maxWidth: 420, width: '100%' }} value={pick.choice} />
          </div>
          <Flexbox data-voice-pack-current={c.base} gap={12}>
            <Info label="正在用">
              {v ? (
                <Flexbox align="center" gap={6} horizontal wrap="wrap">
                  <Text>{v.name}</Text>
                  <Tag color={v.kind === 'generic' ? 'processing' : 'success'} data-voice-pack-label>
                    {v.label}
                  </Tag>
                </Flexbox>
              ) : (
                '没有语音包，用她自己的音色朗读'
              )}
            </Info>
            {v && (
              <Info label="来源">
                <Text data-voice-pack-source={v.source}>{sourceText(c)}</Text>
              </Info>
            )}
            {v && <Info label="台词">{v.lines ? `${v.lines} 句录好的台词 · ${v.engineLabel} · ${v.builtIn ? '内置' : '自定义'}` : `还没有录好的台词，全部用 ${v.engineLabel} 朗读`}</Info>}
            {pick.engineVoice && (
              <Info label="朗读音色">
                {`${pick.engineVoice.engine} · ${pick.engineVoice.voiceId ?? '默认'}${pick.engineVoice.fromPack ? '（来自语音包）' : '（她自己的）'}`}
              </Info>
            )}
            {v?.credit && <Info label="音色署名">{v.credit}</Info>}
          </Flexbox>
          {pick.missing && <Alert showIcon title={`你选的语音包「${pick.missing}」已经不在了，先按自动选择。`} type="warning" />}
        </Flexbox>
      </Surface>
      <Surface title="角色音色">
        <Flexbox gap={12}>
          <Info label="引擎">
            <Flexbox gap={4} horizontal wrap="wrap">
              {tts ? Object.keys(tts).map((k) => <Tag key={k}>{k}</Tag>) : '--'}
            </Flexbox>
          </Info>
          <Text fontSize={12} type="secondary">
            角色音色写在角色文件里，只读。导入的通用语音包放进 设置 → 语音包 的文件夹，重新读取后就能在这里选。
          </Text>
        </Flexbox>
      </Surface>
    </Flexbox>
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

    &[data-equipped='true'] {
      border-color: color-mix(in srgb, var(--pet-accent) 70%, transparent);
    }

    &[data-trying='true'] {
      border-style: dashed;
      border-color: var(--pet-accent);
    }
  `,
  cover: css`
    cursor: pointer;

    position: relative;

    display: flex;
    align-items: flex-end;
    justify-content: center;

    height: 168px;
    padding: 0;
    border: 0;

    background: color-mix(in srgb, var(--pet-accent) 10%, ${cssVar.colorFillQuaternary});

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }

    &:disabled {
      cursor: default;
    }
  `,
  badge: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
  `,
}));

export const KIND_NAME: Record<string, string> = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };

/**
 * 衣柜 (T-2784): her outfits as cards, the way her looks were listed before every look became a character of
 * her own — a picture of each, its name, 成人 / 新 tags, which one she has on and 穿上. Tapping a picture tries
 * it on her stage on the left (not saved); 穿上 saves it (the current character changes at once and the pet
 * window follows; another character met before wears it the next time she is with you).
 * Each outfit is a whole sprite sheet: a card shows only the first frame of its idle action, cut once at card
 * size, and loads nothing before it scrolls into view (SpriteStage `lazy`, one sheet decoded at a time).
 */
const OutfitRack = ({ c, onTry, trying }: { c: RosterRow; onTry: (id: string | null) => void; trying: string | null }) => {
  const { merge } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const list: OutfitRow[] | null = c.outfits;
  // outfits new since she last looked keep a 新 tag while the rack is open; main forgets them right away
  const fresh = useRef<Set<string> | null>(null);
  if (list && fresh.current === null) fresh.current = new Set(list.filter((o) => o.isNew).map((o) => o.id));
  useEffect(() => {
    if (fresh.current?.size) api().markSeen('outfit', c.id).catch(() => {});
  }, [c.id, !!list]);
  if (!list)
    return (
      <Surface description="初次见面之后，可以在这里看她的服饰、给她换衣服。" title="衣柜">
        <Text data-outfits-empty={c.id} fontSize={12} type="secondary">
          还没遇见她。
        </Text>
      </Surface>
    );
  const open = list.filter((o) => !o.locked).length;
  const equip = async (o: OutfitRow) => {
    setBusy(o.id);
    try {
      const r = await api().equipOutfit(o.id, c.id);
      if (r && r.view) merge({ view: r.view });
      if (r && r.ok) {
        onTry(null);
        toast.success(c.current ? `换好了：「${o.label}」` : `换好了：「${o.label}」，她下次陪你时穿`);
      } else toast.error(r && r.reason === 'locked' ? `「${o.label}」还没解锁：${r.condition}` : reasonText(r));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Surface description={`${c.name} 的服饰，已解锁 ${open} / ${list.length} 套。点图片试穿，满意再「穿上」${c.current ? '，桌宠窗口同步' : '，她下次陪你时就穿这套'}。`} title="衣柜">
      <div className={wstyles.grid} data-outfits={c.id}>
        {list.map((o) => (
          <div className={wstyles.card} data-equipped={o.equipped} data-locked={o.locked} data-outfit={o.id} data-trying={trying === o.id} key={o.id}>
            <button
              aria-label={o.locked ? `「${o.label}」还没解锁` : `试穿「${o.label}」`}
              aria-pressed={trying === o.id}
              className={wstyles.cover}
              data-try-outfit={o.id}
              disabled={o.locked || !o.preview}
              onClick={() => onTry(trying === o.id ? null : o.id)}
              type="button"
            >
              <SpriteStage animate={trying === o.id} height={160} lazy name={o.label} preview={o.preview} silhouette={o.locked} />
              {fresh.current?.has(o.id) && (
                <span className={wstyles.badge}>
                  <Tag color="error" data-new-outfit>
                    新
                  </Tag>
                </span>
              )}
            </button>
            <Flexbox flex={1} gap={6} padding={12}>
              <Text ellipsis strong>
                {o.label}
              </Text>
              <Flexbox gap={4} horizontal wrap="wrap">
                {o.rating === 'adult' ? (
                  <Tag color="error" data-rating={o.id}>
                    成人
                  </Tag>
                ) : (
                  <Tag data-rating={o.id}>全年龄</Tag>
                )}
                {o.stageName && <Tag color="magenta">{o.stageName}</Tag>}
              </Flexbox>
              <Text ellipsis fontSize={12} title={o.locked ? (o.condition ?? undefined) : o.desc} type="secondary">
                {o.locked ? (o.condition ?? '还没解锁') : o.desc}
              </Text>
              <Flexbox gap={4} horizontal style={{ marginBlockStart: 'auto' }} wrap="wrap">
                {o.equipped ? (
                  <Tag color="success" data-worn={o.id} icon={<Icon icon={Check} />}>
                    正在穿
                  </Tag>
                ) : o.locked ? (
                  <Tag icon={<Icon icon={Lock} />}>未解锁</Tag>
                ) : (
                  <Button data-equip={o.id} loading={busy === o.id} onClick={() => equip(o)} size="small">
                    穿上
                  </Button>
                )}
              </Flexbox>
            </Flexbox>
          </div>
        ))}
      </div>
    </Surface>
  );
};
/**
 * 取景 (docs/half-body-mode.md): her own framing on the desktop — 跟随 (her character's default, else the global
 * 桌宠行为 → 取景), 全身 or 半身. Saved at once; the pet window re-frames her without reloading the model.
 */
const FramingRow = ({ c }: { c: RosterRow }) => {
  const { view, settings, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const [busy, setBusy] = useState(false);
  const own: string = ch?.framing ?? 'auto';
  const global = settings?.prefs?.framing === 'half' ? '半身' : '全身';
  const packDefault = ch?.look?.framing === 'half' ? '半身' : ch?.look?.framing === 'full' ? '全身' : null;
  const follow = packDefault ? `跟随角色默认（${packDefault}）` : `跟随全局（${global}）`;
  // from the main process (core/framing.js SUPPORTED_KINDS); an older view without it: the kinds that re-frame
  const reframes: boolean = ch?.framingSupported ?? ['vrm', 'live2d', 'sprites'].includes(ch?.look?.kind);
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
        {reframes ? '半身只显示腰部以上，角色画得更大，窗口不变。立即生效。' : '图片和全动态角色不能半身取景，这位角色保持全身。'}
      </Text>
    </Flexbox>
  );
};

/**
 * VRM 姿势 (docs/vrm-motion-system.md): the posture a VRM character stands (or sits) in, kept per pack — her
 * pack is her (settings.vrmPostures); 自动 lets her change it herself while idle. Only for VRM characters.
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
      <Text fontSize={12} type="secondary">按这位角色记住。自动：待机时她自己换姿势。立即生效。</Text>
    </Flexbox>
  );
};

/**
 * 装扮: her wardrobe as cards (T-2784), her framing and posture, the 角色包 she comes from, then 导入新角色 —
 * a Live2D / VRM model or a pack imported here becomes a new character on her base (same name, hearts and
 * chat as her) and you meet her at once. There is no 形象包 to choose any more: every pack is a character.
 */
const LookTab = ({ c, trying, onTry }: { c: RosterRow; onTry: (id: string | null) => void; trying: string | null }) => {
  const { view, merge } = useStore();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const p: PackOption | undefined = ch?.pack ?? undefined;
  const run = async (q: Promise<any>, ok: string) => {
    const r = await q;
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
  // made the model and what its license allows. 取消导入 removes the pack again; 授权信息 stays on her page.
  const [vrmImport, setVrmImport] = useState<any>(null);
  const [licenseOf, setLicenseOf] = useState<PackOption | null>(null);
  // 设定 (docs/vrm-dance.md §12): 通用 by default — the model is a companion of her own (her own name, affection
  // and chat); or a new look of this page's character, sharing hers. A generic character's page offers only 通用.
  const ownBase = c.vendor !== '通用' ? c.base : null;
  const [vrmBase, setVrmBase] = useState<string>('generic');
  const importVrm = async () => {
    const r = await api().importVrm('generic');
    if (!r || r.reason === 'canceled') return;
    if (!r.ok) return void toast.error(vrmUi().importErrorText(r.errors));
    setVrmBase('generic');
    setVrmImport(r);
  };
  const closeVrmImport = async (use: boolean) => {
    const r = vrmImport;
    setVrmImport(null);
    if (!r) return;
    if (!use) {
      await api().removePack(r.pack.id);
      toast.success(`已取消导入「${r.pack.name}」，模型没有留在本机。`);
      return;
    }
    if (vrmBase !== 'generic') {
      const b = await api().setPackBase(r.pack.id, vrmBase);
      if (!b || !b.ok) return void toast.error('没能把她设成这位角色的新形象，模型仍按通用设定导入');
    }
    await becomeNew(r.pack.id, `已导入 VRM 模型「${r.pack.name}」，${vrmBase === 'generic' ? '成为一位新伙伴' : `成为「${c.nameZh}」的新形象`}（作者：${r.license?.author ?? '未署名'}）`);
  };
  if (!view) return <Alert title="唤醒桌宠后可以给她换装扮" type="info" />;
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
            {ownBase && (
              <Flexbox data-vrm-base gap={6}>
                <Text strong>设定</Text>
                <Segmented
                  onChange={(v) => setVrmBase(String(v))}
                  options={[
                    { label: '通用（一位新伙伴）', value: 'generic' },
                    { label: `「${c.nameZh}」的新形象`, value: ownBase },
                  ]}
                  value={vrmBase}
                />
                <Text fontSize={12} type="secondary">
                  {vrmBase === 'generic' ? `用通用设定：她叫「${vrmImport.pack.name}」，好感、名字和聊天记录只属于她。` : `和「${c.nameZh}」共用人设、好感和聊天记录，换上这个模型就像换衣服。`}
                </Text>
              </Flexbox>
            )}
            <VrmLicense packId={vrmImport.pack.id} vrm={{ ...vrmImport.license, models: [{ file: '', meta: vrmImport.meta, restrictions: vrmImport.license?.restrictions }] }} />
          </Flexbox>
        )}
      </Modal>
      <Modal footer={null} onCancel={() => setLicenseOf(null)} open={!!licenseOf} title={licenseOf ? `授权信息：${licenseOf.name}` : ''}>
        {licenseOf && <VrmLicense packId={licenseOf.id} vrm={licenseOf.vrm} />}
      </Modal>
      <OutfitRack c={c} key={c.id} onTry={onTry} trying={trying} />
      <FramingRow c={c} />
      <PostureRow c={c} />
      <Live2dSize c={c} pack={p} />
      {p && (
        <Surface description="她来自这个角色包：形象、服饰和授权都写在包里。" title="角色包">
          <Flexbox data-pack={p.id} gap={12}>
            <Flexbox align="center" gap={8} horizontal wrap="wrap">
              <Text strong>{p.name}</Text>
              <KindTag adult={p.adult} kind={p.kind} label={KIND_NAME[p.kind] ?? p.kind} />
            </Flexbox>
            <Text fontSize={12} type="secondary">
              {[p.source === 'user' ? '导入' : p.source === 'download' ? '下载' : '内置', p.outfits ? `${p.outfits} 套服饰` : '', p.author ?? '', p.license ?? ''].filter(Boolean).join(' · ')}
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
            {p.kind === 'vrm' && p.vrm && (
              <div>
                <Button data-vrm-info={p.id} onClick={() => setLicenseOf(p)} size="small">
                  授权信息
                </Button>
              </div>
            )}
            {p.source === 'download' && (
              <div>
                <Button
                  data-remove-download={p.id}
                  danger
                  icon={Trash2}
                  onClick={async () => {
                    const msg = c.current ? '她正陪着你：删除后先换回默认形象，再下载就能换回来。' : '她的形象文件会从本机删除，之后可以在商店里重新下载。';
                    if (!(await ask(`删除下载「${p.name}」？`, `${msg}衣柜、好感和聊天记录都会保留。`, '删除下载', true))) return;
                    const r = await api().removeDownload(p.id);
                    if (r && r.ok) {
                      toast.success(`已删除下载「${p.name}」`);
                      location.hash = '#/characters';
                    } else toast.error(reasonText(r));
                  }}
                  size="small"
                >
                  删除下载
                </Button>
              </div>
            )}
          </Flexbox>
        </Surface>
      )}
      <Surface
        description={
          ownBase
            ? `导入的 Live2D 模型或角色包会成为${c.nameZh}的一位新角色：和她共用名字、好感和聊天记录。VRM 模型默认用通用设定，成为一位新伙伴，也可以在导入确认里改成${c.nameZh}的新形象。`
            : '导入的 VRM 模型用通用设定，成为一位新伙伴，有自己的名字、好感和聊天记录。'
        }
        title="导入新角色"
      >
        <Flexbox data-import-row={c.id} gap={8} horizontal wrap="wrap">
          {ownBase && (
            <Button
              data-import-live2d
              icon={Import}
              onClick={async () => {
                // the imported model is a new character on her base: she becomes her at once
                const r = await api().importLive2d(c.id);
                if (!r || r.reason === 'canceled') return;
                if (!r.ok) return void toast.error({ description: (r.errors ?? []).slice(0, 3).join('；') || reasonText(r), title: 'Live2D 导入失败' });
                await becomeNew(r.pack.id, `已导入 Live2D 模型「${r.pack.name}」，成为新角色`);
              }}
            >
              导入 Live2D 角色…
            </Button>
          )}
          <Button data-import-vrm icon={Import} onClick={importVrm}>
            导入 VRM 角色…
          </Button>
          {ownBase && (
            <Button icon={Import} onClick={() => run(api().importPack(), '角色包已导入，成为新角色')}>
              导入角色包…
            </Button>
          )}
        </Flexbox>
      </Surface>
    </Flexbox>
  );
};

/** 模型大小: how much of the pet window an imported Live2D character fills (the pet window's slider, saved in her pack). */
const Live2dSize = ({ c, pack }: { c: RosterRow; pack?: PackOption }) => {
  const mine = pack && pack.kind === 'live2d' && pack.source === 'user' ? pack : undefined;
  const [v, setV] = useState<number>(Math.round((mine?.height ?? 1) * 100));
  useEffect(() => setV(Math.round((mine?.height ?? 1) * 100)), [mine?.id, mine?.height]);
  if (!mine) return null;
  return (
    <Surface description={`${c.name} 是导入的 Live2D 模型：调整她占桌宠窗口的高度。松手后保存，桌宠窗口立即重绘。`} title="Live2D 模型大小">
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
 * 角色详情: her stage on the left — what she wears now, played action by action, tap to pat, an outfit being
 * tried on — and on the right her story, hearts and every setting of hers. A change of look made on the
 * right comes back as a new roster row (main rebuilds it on every change) and the stage redraws at once.
 */
export const CharacterDetailPage = ({ id }: { id: string; navigate: (p: string) => void }) => {
  const { roster, view, catalog } = useStore();
  const sw = useSwitch();
  const dl = useDownloads();
  const [tab, setTab] = useState<DetailTab>('looks');
  const [trying, setTrying] = useState<string | null>(null);
  const stage = useStageHeight();
  useEffect(() => setTrying(null), [id]);
  // an old link names her base (`#/characters/dafeiyu`, before T-2764): the current one of that base, else her first
  const c = roster.find((x) => x.id === id) ?? roster.find((x) => x.base === id && x.current) ?? roster.find((x) => x.base === id);
  const ch = view?.characters?.find((x: any) => x.id === c?.id);
  // a character that has to be downloaded first: her card, nothing else to set until she is here
  const remote = !c ? (catalog ?? []).find((d) => d.id === id) : undefined;
  if (!c && remote)
    return (
      <Flexbox data-detail-remote={remote.id} gap={16} style={{ maxWidth: 360 }}>
        <Alert description="这个形象不随应用自带。下载后她会出现在角色图鉴里，可以切换、换装。" showIcon title={`「${remote.name}」还没有下载`} type="info" />
        <CatalogCard d={remote} onDownload={() => dl.start(remote)} p={dl.map[remote.id]} />
      </Flexbox>
    );
  if (!c) return <Alert title={`没有角色「${id}」`} type="error" />;
  // 试穿: one of her outfits on her stage, not saved until 穿上
  const tryOpt: OutfitRow | undefined = trying ? (c.outfits ?? []).find((o) => o.id === trying && !o.locked) : undefined;
  const outfit: OutfitRow | undefined = (c.outfits ?? []).find((o) => o.equipped);
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
                  试穿：{tryOpt.label}
                </Tag>
              ) : undefined
            }
            height={stage.height}
            preview={tryOpt ? (tryOpt.preview ?? null) : undefined}
          />
          <Flexbox align="center" gap={8} horizontal justify="space-between" wrap="wrap">
            <Flexbox align="center" gap={6} horizontal style={{ minWidth: 0 }}>
              <Icon icon={Shirt} size={14} style={{ color: c.accent, flex: 'none' }} />
              <Text data-worn-caption={c.id} ellipsis fontSize={12} type="secondary">
                {tryOpt ? `试穿中：${tryOpt.label}（还没穿上）` : `正在穿：${outfit ? outfit.label : wearing}`}
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
                content: <VoiceTab c={c} />,
                label: '语音',
                value: 'voice',
              },
              {
                content: (
                  <Surface title="资料">
                    <Flexbox gap={12}>
                      <Info label="厂商">{c.vendor}</Info>
                      <Info label="形象">
                        <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />
                      </Info>
                      <Info label="角色包">{c.pack ? `${c.pack.name}（${c.sourceLabel}）` : c.kind === 'video' ? '原版动画' : '--'}</Info>
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

// ---- 角色包（导入角色） ------------------------------------------------------------------------------------------

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
            <Button data-import-pack icon={Import} onClick={() => run(api().importPack(), '已导入，成为新角色')} type="primary">
              导入角色…
            </Button>
          </Flexbox>
        }
        description="每个角色包都是一位独立角色（像素 / 图片 / 全动态 / Live2D / VRM），都在角色图鉴里。导入的可以导出或删除；以某位角色为原型导入 Live2D / VRM 模型，在她的详情 → 装扮里。"
        title="角色包"
      />
      <Surface bleed data-packs title={`共 ${packs.length} 位角色（导入 ${user} 位）`}>
        <Table<PackRow>
          columns={[
            { dataIndex: 'name', key: 'name', render: (_: unknown, p) => <Flexbox gap={2}><Text strong>{p.name}</Text><Text code fontSize={12} type="secondary">{p.id}</Text></Flexbox>, title: '角色' },
            { dataIndex: 'speciesName', key: 'species', title: '原型', width: 90 },
            { key: 'kind', render: (_: unknown, p) => <KindTag adult={p.adult} kind={p.kind} label={p.kindLabel} />, title: '类型', width: 120 },
            { key: 'source', render: (_: unknown, p) => <Tag color={p.source === 'user' ? 'processing' : undefined}>{p.sourceLabel}</Tag>, title: '来源', width: 80 },
            { dataIndex: 'license', key: 'license', render: (v: string) => <Text ellipsis fontSize={12} type="secondary">{v || '--'}</Text>, title: '授权', width: 200 },
            {
              key: 'act',
              render: (_: unknown, p) =>
                p.source === 'download' ? (
                  <Button
                    danger
                    data-remove-download={p.id}
                    icon={Trash2}
                    onClick={async () => {
                      if (await ask(`删除下载「${p.name}」？`, '她的形象文件会从本机删除，之后可以在商店里重新下载。衣柜、好感和聊天记录都会保留。', '删除下载', true)) run(api().removeDownload(p.id), `已删除下载「${p.name}」`);
                    }}
                    size="small"
                    type="text"
                  >
                    删除下载
                  </Button>
                ) : p.removable ? (
                  <Flexbox gap={4} horizontal>
                    <Button data-export-pack={p.id} disabled={!p.exportable} icon={Download} onClick={() => run(api().exportPack(p.id), `已导出「${p.name}」`)} size="small" type="text">
                      导出
                    </Button>
                    <Button
                      danger
                      data-remove-pack={p.id}
                      icon={Trash2}
                      onClick={async () => {
                        if (await ask(`删除角色「${p.name}」？`, '会从数据目录里删除她的角色包，她不再出现在角色图鉴里。好感和聊天记录跟着原型保留。', '删除角色', true)) run(api().removePack(p.id), `已删除角色「${p.name}」`);
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
