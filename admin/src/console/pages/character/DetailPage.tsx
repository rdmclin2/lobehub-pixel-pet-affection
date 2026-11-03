/**
 * 角色详情 (P-03 + P-04)（实施包 B）：标签进 URL `#/characters/:id/:tab`（B02 / CHAR-02）；页头一行身份 + 一行紧凑
 * 好感，完整路线图只在「好感」标签（B03 / CHAR-03）；「资料与语音」合并（B04 / CHAR-04）；页底 DangerZone
 * （B05 / CHAR-05）；找不到的角色给出路（B06 / CHAR-06）。由 Characters.tsx 拆出。
 */
import { Alert, Button, createStaticStyles, cssVar, Empty, Flexbox, Icon, Modal, Segmented, Select, Slider, Tag, Text, TextArea, toast } from '@lobehub/ui';
import { PageTabs, Surface } from '@lobehub/ui/dashboard';
import { Check, Heart, Import, Lock, Shirt, Store } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api, reasonText, type OutfitRow, type PackOption, type RosterRow } from '../../api';
import { detailHref, lookName, lookState, resolveCharacter, STATE_WORD, toDetailTab, type DetailTab } from '../../roster-model';
import { CharacterStage } from '../../stage/CharacterStage';
import { HeartMeter } from '../../stage/HeartMeter';
import { SpriteStage } from '../../stage/SpriteStage';
import { VrmLicense, vrmUi } from '../../stage/VrmLicense';
import { useStore } from '../../store';
import { replaceHash } from '../../../useHashPath';
import { DangerZone, useAskAsync, type DangerItem } from './DangerZone';
import { CatalogCard, KIND_NAME, KindTag, modelLabel, SwitchButton, useDownloads, useSwitch } from './shared';

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
    <Surface description="加在她 system role 里的你自己的话（比如称呼、口癖）。留空保存即删除；整段清空在页底「危险操作」里。" title="个性化设定">
      <Flexbox gap={8}>
        <TextArea aria-label="个性化设定" data-system-role={c.id} onChange={(e) => setText(e.target.value)} placeholder="例如：叫我老板，回答简短一点。" rows={6} aria-invalid={len > max} value={text} />
        <Flexbox align="center" horizontal justify="space-between">
          <Text fontSize={12} type={len > max ? 'danger' : 'secondary'}>
            {len} / {max} · {c.systemRole ? `已保存${c.current ? '，下一句话起用' : c.met ? '，她下次陪你时起用' : '，见面后起用'}` : '还没写，她按默认性格来'}
          </Text>
          <Flexbox gap={8} horizontal>
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
    if (r && r.ok) location.hash = detailHref(id, 'looks');
    return r;
  };
  // 导入 VRM…: main checks the file and copies it into a new user pack; before she wears it, 导入确认 shows who
  // made the model and what its license allows. 取消导入 removes the pack again; 授权信息 stays on her page.
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
      toast.success(`已取消导入「${r.pack.name}」，模型没有留在本机。`);
      return;
    }
    await becomeNew(r.pack.id, `已导入 VRM 模型「${r.pack.name}」，成为新角色（作者：${r.license?.author ?? '未署名'}）`);
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
            <VrmLicense packId={vrmImport.pack.id} vrm={{ ...vrmImport.license, models: [{ file: '', meta: vrmImport.meta, restrictions: vrmImport.license?.restrictions }] }} />
          </Flexbox>
        )}
      </Modal>
      <Modal footer={null} onCancel={() => setLicenseOf(null)} open={!!licenseOf} title={licenseOf ? `授权信息：${licenseOf.name}` : ''}>
        {licenseOf && <VrmLicense packId={licenseOf.id} vrm={licenseOf.vrm} />}
      </Modal>
      <LookPicker c={c} />
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
          </Flexbox>
        </Surface>
      )}
      <Surface description={`导入的模型或角色包会成为${c.nameZh}的一位新角色：和她共用名字、好感和聊天记录，出现在角色图鉴里。`} title="导入新角色">
        <Flexbox data-import-row={c.id} gap={8} horizontal wrap="wrap">
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
          <Button data-import-vrm icon={Import} onClick={importVrm}>
            导入 VRM 角色…
          </Button>
          <Button icon={Import} onClick={() => run(api().importPack(), '角色包已导入，成为新角色')}>
            导入角色包…
          </Button>
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
  if (!c.met) return <Alert title={`${STATE_WORD.unmet}：和她初次见面、起个名字之后才有好感`} type="info" />;
  const p = c.met.progress ?? {};
  const value = p.value ?? c.met.affection;
  const stages: { id: string; min: number; name: string }[] = p.stages ?? [];
  return (
    <Surface description="好感随你们的互动上涨；每到一个阶段，会解锁新的话题和服饰。" title="你们的关系" style={{ ['--pet-accent' as string]: c.accent }}>
      <Flexbox gap={16}>
        {/* the bar itself is in the page head (B03 / CHAR-03, W-07: one number drawn once); here what only this tab says */}
        <Text data-affection-next={c.id} fontSize={12} type="secondary">
          {[p.next ? `离「${p.nextName}」还差 ${p.need}` : '已经是最亲密的关系', typeof p.today === 'number' ? `今天 +${Math.round(p.today)}${p.dailyCap ? ` / 上限 ${p.dailyCap}` : ''}` : ''].filter(Boolean).join(' · ')}
        </Text>
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
        <Text fontSize={12} type="secondary">
          想直接看到全部内容？页底「危险操作」里可以一键解锁（不能撤销）。
        </Text>
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
    inset-block-start: calc(16px + var(--pet-titlebar, 0px));

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
 * 形象（B01）：她的几套形象（一个角色包 = 一套），每套一张小卡，点开是那套形象的页面；正在陪你的那套标出来。
 * 图鉴一位角色一张卡，她的形象都在这里换。
 */
const lstyles = createStaticStyles(({ css }) => ({
  row: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    gap: 8px;
  `,
  look: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    color: inherit;

    background: ${cssVar.colorBgContainer};

    &[aria-current='page'] {
      border-color: var(--pet-accent);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  pic: css`
    display: flex;
    align-items: flex-end;
    justify-content: center;

    height: 96px;

    background: color-mix(in srgb, var(--pet-accent) 10%, ${cssVar.colorFillQuaternary});
  `,
}));

const LookPicker = ({ c }: { c: RosterRow }) => {
  const { roster } = useStore();
  const looks = roster.filter((x) => x.base === c.base);
  if (looks.length < 2) return null;
  return (
    <Surface description={`${c.met?.name ?? c.nameZh} 有 ${looks.length} 套形象，共用名字、好感和聊天记录。点一套去看她穿这套的样子，在那里「切换」。`} title="形象">
      <div className={lstyles.row} data-looks={c.base}>
        {looks.map((x) => (
          <a aria-current={x.id === c.id ? 'page' : undefined} aria-label={`${lookName(x)}${x.current ? `，${STATE_WORD.current}` : ''}`} className={lstyles.look} data-look={x.id} href={detailHref(x.id, 'looks')} key={x.id}>
            <div className={lstyles.pic}>
              <SpriteStage animate={false} height={88} lazy name={x.label} preview={x.preview} />
            </div>
            <Flexbox gap={2} padding={8}>
              <Text ellipsis fontSize={12} strong>
                {x.label || x.kindLabel}
              </Text>
              <Text ellipsis fontSize={12} type={x.current ? 'success' : 'secondary'}>
                {x.current ? STATE_WORD.current : x.sourceLabel}
              </Text>
            </Flexbox>
          </a>
        ))}
      </div>
    </Surface>
  );
};

/** 资料与语音（B04 / CHAR-04）：她是谁（口头禅、简介、喜欢）、她的声音（语音包可点去管理）、素材署名。 */
const AboutTab = ({ c }: { c: RosterRow }) => {
  const tts = c.voice?.tts;
  return (
    <Flexbox gap={16}>
      <Surface title="资料">
        <Flexbox gap={12}>
          {c.catchphrase && <blockquote className={dstyles.quote}>「{c.catchphrase}」</blockquote>}
          {c.blurb && <Text style={{ lineHeight: 1.7 }}>{c.blurb}</Text>}
          {c.likes?.length > 0 && (
            <Info label="喜欢">
              <Flexbox gap={4} horizontal wrap="wrap">
                {c.likes.map((x) => (
                  <Tag key={x} size="small">
                    {x}
                  </Tag>
                ))}
              </Flexbox>
            </Info>
          )}
          <Info label="厂商">{c.vendor}</Info>
          <Info label="角色包">{c.pack ? `${c.pack.name}（${c.sourceLabel}）` : c.kind === 'video' ? '原版动画' : '--'}</Info>
          <Info label="素材署名">
            <Flexbox gap={4}>{c.credits.length ? c.credits.map((x) => <Text key={x} type="secondary">{x}</Text>) : '--'}</Flexbox>
          </Info>
        </Flexbox>
      </Surface>
      <Surface
        description="角色音色写在角色文件里，只读。"
        extra={
          <Button data-go-voicepacks href="#/voicepacks" size="small">
            管理语音包
          </Button>
        }
        title="语音"
      >
        <Flexbox gap={12}>
          <Info label="语音包">{c.voicePack ? `${c.voicePack.name} · ${c.voicePack.engineLabel} · ${c.voicePack.lines} 句 · ${c.voicePack.builtIn ? '内置' : '自定义'}` : '没有语音包'}</Info>
          {c.voicePack?.credit && <Info label="音色署名">{c.voicePack.credit}</Info>}
          <Info label="角色音色">
            <Flexbox gap={4} horizontal wrap="wrap">
              {tts ? Object.keys(tts).map((k) => <Tag key={k}>{k}</Tag>) : '--'}
            </Flexbox>
          </Info>
        </Flexbox>
      </Surface>
    </Flexbox>
  );
};

/** 角色不存在（B06 / CHAR-06）：说清可能的原因，给两个出口。 */
const Missing = ({ id }: { id: string }) => (
  <Empty
    action={
      <Flexbox gap={8} horizontal justify="center">
        <Button data-missing-back href="#/characters" type="primary">
          回角色图鉴
        </Button>
        <Button data-missing-store href="#/store" icon={Store}>
          去商店
        </Button>
      </Flexbox>
    }
    data-character-missing={id}
    description={`没有角色「${id}」：可能删除了她的下载、关掉了成人向内容，或者链接里的名字改过了。`}
    title="找不到这位角色"
    type="page"
  />
);

/**
 * 页底危险操作（B05）：删除下载 / 一键解锁 / 清空设定，统一在弹窗里执行（S-7），写清删除什么、保留什么。
 */
const useDanger = (c: RosterRow) => {
  const { view, merge } = useStore();
  const ask = useAskAsync();
  const ch = view?.characters?.find((x: any) => x.id === c.id);
  const p: PackOption | undefined = ch?.pack ?? undefined;
  const items: DangerItem[] = [];
  if (p && p.source === 'download')
    items.push({
      data: { 'data-remove-download': p.id },
      desc: `${c.current ? '她正陪着你：删除后先换回默认形象。' : ''}这套形象的文件从本机删除，可以在商店里重新下载；衣柜、好感和聊天记录都保留。`,
      key: 'remove-download',
      label: '删除下载',
      onClick: () =>
        ask.ask({
          desc: `${c.current ? '她正陪着你：删除后先换回默认形象，再下载就能换回来。' : '她的形象文件会从本机删除，之后可以在商店里重新下载。'}衣柜、好感和聊天记录都会保留。`,
          okText: '删除下载',
          run: async () => {
            const r = await api().removeDownload(p.id);
            if (r && r.ok) location.hash = '#/characters';
            return { done: `已删除下载「${p.name}」`, ok: !!r?.ok, r };
          },
          title: `删除下载「${p.name}」？`,
        }),
    });
  if (c.met)
    items.push({
      data: { 'data-unlock': c.id },
      desc: '好感直接拉满，解锁她的所有阶段、话题和服饰。不能撤销。',
      key: 'unlock',
      label: '一键解锁',
      onClick: () =>
        ask.ask({
          desc: '把好感拉满，解锁她的所有阶段、话题和服饰。不能撤销。',
          okText: '一键解锁',
          run: async () => {
            const r = await api().unlockAll(c.id);
            if (r && r.view) merge({ view: r.view });
            return { done: r?.already ? '已经全部解锁了' : `${c.met?.name ?? c.nameZh} 已全部解锁`, ok: !!r?.ok, r };
          },
          title: `一键解锁 ${c.met?.name ?? c.nameZh}？`,
        }),
    });
  if (c.systemRole)
    items.push({
      data: { 'data-clear-role': c.id },
      desc: '删除你写的个性化设定，她按默认性格来；她的角色设定不受影响。',
      key: 'clear-role',
      label: '清空个性化设定',
      onClick: () =>
        ask.ask({
          desc: '她会按默认性格来，已经写的内容会删除。',
          okText: '清空个性化设定',
          run: async () => {
            const r = await api().setSystemRole('', c.id);
            if (r && r.view) merge({ view: r.view });
            return { done: `${c.met?.name ?? c.nameZh} 的个性化设定已清空`, ok: !!r?.ok, r };
          },
          title: `清空 ${c.met?.name ?? c.nameZh} 的个性化设定？`,
        }),
    });
  return { items, modal: ask.modal };
};

/** `#/characters/:id/:tab` 里的标签（ConsoleApp 只把 :id 交给页面）。 */
const useDetailTab = (id: string): [DetailTab, (t: DetailTab) => void] => {
  const read = () => toDetailTab(location.hash.replace(/^#/, '').split('?')[0].split('/')[3]);
  const [tab, setTab] = useState<DetailTab>(read);
  useEffect(() => {
    const on = () => setTab(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // 换标签不加历史记录：「返回」回到来的那一页，刷新留在这个标签
  return [tab, (t) => replaceHash(`/characters/${id}/${t}`)];
};

/**
 * 角色详情: her stage on the left — what she wears now, played action by action, tap to pat, an outfit being
 * tried on — and on the right who she is (one line), how close you are (one line), her tabs, and the
 * DangerZone at the bottom. A change of look made on the right comes back as a new roster row (main rebuilds
 * it on every change) and the stage redraws at once.
 */
export const CharacterDetailPage = ({ id }: { id: string; navigate: (p: string) => void }) => {
  const { roster, view, catalog } = useStore();
  const sw = useSwitch();
  const dl = useDownloads();
  const [tab, setTab] = useDetailTab(id);
  const [trying, setTrying] = useState<string | null>(null);
  const stage = useStageHeight();
  useEffect(() => setTrying(null), [id]);
  // an old link names her base (`#/characters/dafeiyu`, before T-2764): roster-model resolves it (B13)
  const c = resolveCharacter(roster, id);
  // a character that has to be downloaded first: her card, nothing else to set until she is here
  const remote = !c ? (catalog ?? []).find((d) => d.id === id) : undefined;
  if (!c && remote)
    return (
      <Flexbox data-detail-remote={remote.id} gap={16} style={{ maxWidth: 360 }}>
        <Alert description="这个形象不随应用自带。下载后她会出现在角色图鉴里，可以切换、换装。" showIcon title={`「${remote.name}」还没有下载`} type="info" />
        <CatalogCard d={remote} onDownload={() => dl.start(remote)} p={dl.map[remote.id]} />
      </Flexbox>
    );
  if (!c) return <Missing id={id} />;
  return <Detail c={c} setTab={setTab} stage={stage} sw={sw} tab={tab} trying={trying} setTrying={setTrying} view={view} />;
};

const Detail = ({ c, tab, setTab, trying, setTrying, stage, sw, view }: { c: RosterRow; setTab: (t: DetailTab) => void; setTrying: (x: string | null) => void; stage: ReturnType<typeof useStageHeight>; sw: ReturnType<typeof useSwitch>; tab: DetailTab; trying: string | null; view: any }) => {
  const danger = useDanger(c);
  // 试穿: one of her outfits on her stage, not saved until 穿上
  const tryOpt: OutfitRow | undefined = trying ? (c.outfits ?? []).find((o) => o.id === trying && !o.locked) : undefined;
  const outfit: OutfitRow | undefined = (c.outfits ?? []).find((o) => o.equipped);
  const wearing = c.pack ? c.pack.name : c.kind === 'video' ? '原版动画' : c.kindLabel;
  const state = lookState(c);
  return (
    <>
      <div className={dstyles.layout} data-detail-layout={c.id} style={{ ['--pet-accent' as string]: c.accent }}>
        <aside aria-label={`${c.name ?? c.nameZh} 的展示区`} className={dstyles.showcase} data-showcase={c.id} ref={stage.ref}>
          <CharacterStage
            actions
            badge={
              state === 'current' ? (
                <Tag color="success" data-current={c.id}>
                  {STATE_WORD.current}
                </Tag>
              ) : state === 'unmet' ? (
                <Tag>{STATE_WORD.unmet}</Tag>
              ) : undefined
            }
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
            {/* 一个状态说一次：正在陪你只在舞台角标上（W-07） */}
            {view && !c.current && <SwitchButton c={c} sw={sw} />}
          </Flexbox>
        </aside>
        <div className={dstyles.panels}>
          {/* 页头：一行身份 + 一行紧凑好感（B03），标签栏进第一屏；口头禅、简介在「资料与语音」 */}
          <Flexbox data-detail-head={c.id} gap={8}>
            <Flexbox align="center" gap={8} horizontal wrap="wrap">
              <Text as="h1" data-character-title={c.id} fontSize={24} strong style={{ lineHeight: 1.25, margin: 0 }}>
                {c.displayName}
              </Text>
              <KindTag adult={c.pack?.adult} kind={c.kind} label={c.kindLabel} />
              <Text type="secondary">{c.title}</Text>
            </Flexbox>
            {c.met ? (
              <a aria-label="看你们的关系" data-head-affection={c.id} href={detailHref(c.id, 'affection')} style={{ color: 'inherit', maxWidth: 360 }}>
                <HeartMeter c={c} compact />
              </a>
            ) : (
              <Text data-head-unmet={c.id} fontSize={12} type="secondary">
                {view ? `${STATE_WORD.unmet}：在左边「初次见面」给她起个名字，之后才有好感。` : `${STATE_WORD.unmet}。`}
              </Text>
            )}
          </Flexbox>
          <PageTabs
            label="角色详情"
            onChange={setTab}
            tabs={[
              { content: <LookTab c={c} onTry={setTrying} trying={trying} />, label: '装扮', value: 'looks' },
              { content: <ModelTab c={c} />, label: '模型', value: 'model' },
              { content: <RoleTab c={c} />, label: '个性化设定', value: 'role' },
              { content: <AffectionTab c={c} />, label: '好感', value: 'affection' },
              { content: <AboutTab c={c} />, label: '资料与语音', value: 'about' },
            ]}
            value={tab}
          />
          <DangerZone items={danger.items} />
        </div>
      </div>
      {danger.modal}
      {sw.modal}
    </>
  );
};
