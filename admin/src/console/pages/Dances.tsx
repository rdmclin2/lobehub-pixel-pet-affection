/**
 * 玩法 → 和她一起 → 舞蹈 (docs/vrm-dance.md §6.2 L2, §6.3): the dances she can dance, 让她跳 / 停止 / 循环播放,
 * 导入舞蹈 (an MMD .vmd with optional music and cover, baked into a VRM motion in main) and 删除舞蹈, and the
 * music's volume. Only a VRM look dances: otherwise the page says why, and 让她跳 is off.
 */
import { ActionIcon, Alert, Button, createStaticStyles, cssVar, Flexbox, Icon, Input, Modal, Progress, Select, Slider, Switch, Tag, Text, toast, Tooltip } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { FolderOpen, ImagePlus, Music, Play, Square, Trash2, Upload, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type DanceDraft, type DanceList, type DanceRow, type DanceState } from '../api';
import { ask } from '../fields';
import { SettingsForm } from '../SettingsForm';
import { useStore } from '../store';

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
    gap: 16px;
  `,
  card: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  current: css`
    border-color: ${cssVar.colorPrimary};
  `,
  cover: css`
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 16 / 10;
    width: 100%;

    color: ${cssVar.colorTextQuaternary};

    background: ${cssVar.colorFillQuaternary};
  `,
  img: css`
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
  thumb: css`
    overflow: hidden;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 56px;
    height: 56px;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorTextQuaternary};

    background: ${cssVar.colorFillQuaternary};
  `,
  name: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;

    min-height: calc(2 * 1.5em);

    font-weight: 600;
    line-height: 1.5;
  `,
  readme: css`
    overflow: auto;

    max-height: 96px;
    padding: 8px 12px;
    border-radius: ${cssVar.borderRadius};

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;

    background: ${cssVar.colorFillQuaternary};
  `,
  label: css`
    flex: none;
    width: 56px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

/** The look's name in the not-VRM notice (the same words as core/vrm-dances.js LOOK_LABEL). */
const LOOK_LABEL: Record<string, string> = { live2d: 'Live2D', pictures: '图片', rig: '像素', sprites: '像素', video: '像素' };

/** 3:38 */
export const clock = (s: number) => {
  const t = Math.max(0, Math.round(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const Cover = ({ d, className }: { className: string; d: Pick<DanceRow, 'coverUrl' | 'name'> }) => (
  <div className={className}>{d.coverUrl ? <img alt={`《${d.name}》的封面`} className={styles.img} src={d.coverUrl} /> : <Icon icon={Music} size={24} />}</div>
);

// ---- 正在跳 ------------------------------------------------------------------------------------------------
/** The music's volume while she dances (prefs.danceVolume, the same value as 跳舞时 → 音乐音量 below; live). */
const DanceVolume = () => {
  const { settings, merge } = useStore();
  const saved = Number(settings.prefs?.danceVolume ?? 60);
  const [v, setV] = useState<number | null>(null);
  const muted = settings.prefs?.muted === true;
  return (
    <Flexbox align="center" data-dance-volume gap={8} horizontal style={{ width: 200 }}>
      <Icon icon={Volume2} size={16} />
      <Slider
        aria-label="音乐音量"
        max={100}
        min={0}
        onChange={(x: number) => setV(x)}
        onChangeComplete={async (x: number) => {
          const r = await api().set('prefs.danceVolume', x);
          if (r.settings) merge({ settings: r.settings });
          setV(null);
        }}
        step={5}
        style={{ flex: 1 }}
        value={v ?? saved}
      />
      <Text fontSize={12} style={{ minWidth: 40, textAlign: 'end' }} type="secondary">
        {muted ? '已静音' : `${v ?? saved}%`}
      </Text>
    </Flexbox>
  );
};

const NowDancing = ({ st, row, onStop, onLoop }: { onLoop: (on: boolean) => void; onStop: () => void; row?: DanceRow; st: DanceState }) => (
  <Surface title="正在跳">
    <Flexbox align="center" data-dance-now={st.id} gap={16} horizontal>
      <Cover className={styles.thumb} d={{ coverUrl: row?.coverUrl ?? null, name: st.name }} />
      <Flexbox flex={1} gap={6} style={{ minWidth: 0 }}>
        <Flexbox align="center" gap={8} horizontal>
          <Text ellipsis strong>
            《{st.name}》
          </Text>
          {st.paused && <Tag size="small">{st.pausedBy === 'lift' ? '被拎起来了，放下后接着跳' : '暂停中'}</Tag>}
          {!st.music && <Tag size="small">无音乐</Tag>}
        </Flexbox>
        <Progress percent={st.duration ? Math.min(100, (st.t / st.duration) * 100) : 0} showInfo={false} size="small" />
        <Text data-dance-progress fontSize={12} type="secondary">
          {clock(st.t)} / {clock(st.duration)}
        </Text>
      </Flexbox>
      {st.music && <DanceVolume />}
      <Flexbox align="center" gap={8} horizontal>
        <Switch aria-label="循环播放" checked={st.loop} data-dance-loop onChange={onLoop} size="small" />
        <Text fontSize={12}>循环播放</Text>
      </Flexbox>
      <Button data-dance-stop icon={Square} onClick={onStop}>
        停止
      </Button>
    </Flexbox>
  </Surface>
);

// ---- 导入确认 -----------------------------------------------------------------------------------------------
type Choice = { audio: string | null; cover: string | null; coverData: string | null; motion: string; name: string };
const NONE = '__none__';

const ImportDialog = ({ draft, onClose, onDone }: { draft: DanceDraft | null; onClose: () => void; onDone: (r: { id: string; name: string }) => void }) => {
  const [c, setC] = useState<Choice | null>(null);
  const [audios, setAudios] = useState<{ label: string; path: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ detail?: string; message: string } | null>(null);
  useEffect(() => {
    if (!draft) return;
    setC({ audio: draft.audio, cover: draft.cover, coverData: draft.coverData, motion: draft.motion, name: draft.name });
    setAudios(draft.audios);
    setError(null);
    setBusy(false);
  }, [draft]);
  if (!draft || !c) return null;
  const motion = draft.motions.find((m) => m.path === c.motion);
  const pickExtra = async (kind: 'audio' | 'cover') => {
    const r = await api().danceImportExtra(draft.token, kind);
    if (!r.ok) {
      if (r.reason !== 'canceled') setError({ message: r.message ?? '没能选上这个文件' });
      return;
    }
    setError(null);
    if (kind === 'audio') {
      setAudios((a) => (a.some((x) => x.path === r.path) ? a : [...a, { label: r.label, path: r.path }]));
      setC({ ...c, audio: r.path });
    } else setC({ ...c, cover: r.path, coverData: r.coverData ?? null });
  };
  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api().danceImportCommit({ audio: c.audio, cover: c.cover, motion: c.motion, name: c.name.trim(), token: draft.token });
      if (r.ok) onDone(r);
      else if (r.reason !== 'canceled') setError({ detail: r.detail, message: r.message ?? '导入没有成功' });
    } finally {
      setBusy(false);
    }
  };
  const row = (label: string, node: React.ReactNode) => (
    <Flexbox align="center" gap={12} horizontal>
      <Text className={styles.label}>{label}</Text>
      <Flexbox align="center" flex={1} gap={8} horizontal style={{ minWidth: 0 }}>
        {node}
      </Flexbox>
    </Flexbox>
  );
  return (
    <Modal
      cancelButtonProps={{ disabled: busy }}
      cancelText="取消"
      closable={!busy}
      destroyOnHidden
      maskClosable={false}
      okButtonProps={{ 'data-dance-import-ok': true, disabled: !c.name.trim() || !motion } as any}
      okText={busy ? '正在转换…' : '导入舞蹈'}
      onCancel={() => (busy ? undefined : onClose())}
      onOk={commit}
      confirmLoading={busy}
      open
      title="导入舞蹈"
      width={560}
    >
      <Flexbox data-dance-draft={draft.token} gap={12}>
        {row('名字', <Input aria-label="舞蹈名字" data-dance-name disabled={busy} maxLength={60} onChange={(e) => setC({ ...c, name: e.target.value })} value={c.name} />)}
        {row(
          '动作',
          draft.motions.length > 1 ? (
            <Select
              aria-label="舞蹈动作"
              disabled={busy}
              onChange={(v: string) => setC({ ...c, motion: v })}
              options={draft.motions.map((m) => ({ label: `${m.label}（${clock(m.duration ?? 0)}）`, value: m.path }))}
              style={{ flex: 1, minWidth: 0 }}
              value={c.motion}
            />
          ) : (
            <Text ellipsis>{motion?.label}</Text>
          ),
        )}
        {row('时长', <Text data-dance-draft-duration>{clock(motion?.duration ?? draft.duration)}</Text>)}
        {row(
          '音乐',
          <>
            <Select
              aria-label="舞蹈音乐"
              data-dance-audio-select
              disabled={busy}
              onChange={(v: string) => setC({ ...c, audio: v === NONE ? null : v })}
              options={[...audios.map((a) => ({ label: a.label, value: a.path })), { label: '不带音乐', value: NONE }]}
              style={{ flex: 1, minWidth: 0 }}
              value={c.audio ?? NONE}
            />
            <Button disabled={busy} icon={Music} onClick={() => pickExtra('audio')}>
              换一个…
            </Button>
          </>,
        )}
        {row(
          '封面',
          <>
            <Cover className={styles.thumb} d={{ coverUrl: c.coverData, name: c.name }} />
            <Button disabled={busy} icon={ImagePlus} onClick={() => pickExtra('cover')}>
              {c.cover ? '换封面…' : '选封面…'}
            </Button>
            {c.cover && (
              <Button disabled={busy} onClick={() => setC({ ...c, cover: null, coverData: null })} type="text">
                不要封面
              </Button>
            )}
          </>,
        )}
        {draft.credit && row('署名', <Text data-dance-draft-credit>{draft.credit}</Text>)}
        {draft.readme && (
          <Flexbox gap={4}>
            <Text fontSize={12} type="secondary">
              素材说明（{draft.readme.file}）：使用前请看一下作者的要求
            </Text>
            <div className={styles.readme} data-dance-readme>
              {draft.readme.excerpt}
            </div>
          </Flexbox>
        )}
        {draft.warnings.map((w) => (
          <Alert key={w} title={w} type="warning" />
        ))}
        {busy && (
          <Flexbox gap={4}>
            <Text fontSize={12}>正在把舞蹈动作转换成 VRM 动作，长的舞蹈要十几秒…</Text>
            <Flexbox align="center" gap={8} horizontal>
              <Progress percent={100} showInfo={false} size="small" status="active" style={{ flex: 1 }} />
              <Button onClick={() => api().danceImportCancel()} size="small">
                取消导入
              </Button>
            </Flexbox>
          </Flexbox>
        )}
        {error && <Alert data-dance-import-error description={error.detail ? `详细信息：${error.detail}` : undefined} title={error.message} type="error" />}
        <Text fontSize={12} type="secondary">
          舞蹈素材只保存在这台电脑上，不会随角色包导出或分享。
        </Text>
      </Flexbox>
    </Modal>
  );
};

// ---- 页面 ---------------------------------------------------------------------------------------------------
export const DancesPage = () => {
  const { schema, view } = useStore();
  const [list, setList] = useState<DanceList | null>(null);
  const [st, setSt] = useState<DanceState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<DanceDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const look: string | null = view?.look?.kind ?? null;
  // only the newest answer counts: a list asked for before her look changed must not overwrite a newer one
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    const ask = api().dances();
    return ask.then(
      (r) => n === seq.current && setList(r),
      () => n === seq.current && setList(null),
    );
  }, []);
  useEffect(() => {
    reload();
  }, [reload, look, view?.pet?.speciesId]);
  // what she is dancing, while this page is open
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api()
        .danceState()
        .then((s) => alive && setSt(s ?? null), () => alive && setSt(null));
    tick();
    const t = setInterval(tick, 500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const page = schema.pages.dances;
  // who may dance follows her look as the window knows it now (core/vrm-dances.js cannotDance: a VRM look only)
  const isVrm = look === 'vrm';
  const canDance = isVrm && !!view?.pet;
  const lookLabel = LOOK_LABEL[look ?? ''] ?? '像素';
  const dances = list?.dances ?? [];
  const own = dances.filter((d) => !d.builtin);
  const pick = async (folder: boolean) => {
    setPicking(true);
    setPickError(null);
    try {
      const r = await api().danceImportPick(folder);
      if (r.ok) setDraft(r);
      else if (r.reason !== 'canceled') setPickError(r.message ?? '没能读取选中的文件');
    } finally {
      setPicking(false);
    }
  };
  const play = async (d: DanceRow) => {
    setBusy(d.id);
    try {
      const r = await api().dancePlay(d.id);
      if (r.ok) toast.success(`她开始跳《${d.name}》了`);
      else toast.error({ description: r.message ?? '她现在跳不了，稍后再试', title: `没能跳《${d.name}》` });
      setSt(await api().danceState());
    } finally {
      setBusy(null);
    }
  };
  const stop = async () => {
    await api().danceStop();
    setSt(null);
  };
  const remove = async (d: DanceRow) => {
    const dancing = st?.id === d.id;
    const ok = await ask(`删除舞蹈《${d.name}》？`, `${dancing ? '她正在跳这支，会先停下。' : ''}导入的动作、音乐和封面都会从这台电脑上删掉，不能撤回；原来的素材文件不受影响。`, '删除舞蹈', true);
    if (!ok) return;
    const r = await api().danceRemove(d.id);
    if (r.ok) toast.success(`已删除《${d.name}》`);
    else toast.error(r.message ?? '没能删除这支舞蹈');
    reload();
  };
  const importButtons = (
    <Flexbox gap={8} horizontal>
      <Button data-dance-import-folder disabled={picking || !!list?.importing} icon={FolderOpen} onClick={() => pick(true)}>
        选文件夹导入
      </Button>
      <Button data-dance-import disabled={!!list?.importing} icon={Upload} loading={picking} onClick={() => pick(false)} type="primary">
        导入舞蹈
      </Button>
    </Flexbox>
  );
  return (
    <>
      <PageHeader action={importButtons} description={page?.description} title={page?.title ?? '舞蹈'} />
      {draft && (
        <ImportDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onDone={(r) => {
            setDraft(null);
            reload();
            toast.success({ description: canDance ? '在下面点「让她跳」，或者在桌宠工具栏点「跳舞」。' : '换成 VRM 外观后就能跳。', title: `已导入《${r.name}》` });
          }}
        />
      )}
      {!canDance && (
        <Alert
          action={
            view?.pet ? (
              <Button href={`#/characters/${view.pet.speciesId}`} size="small">
                去换外观
              </Button>
            ) : undefined
          }
          data-dance-notvrm={look ?? 'none'}
          description={view?.pet ? `她现在是${lookLabel}外观，换成 VRM 模型再来吧。` : '还没有唤醒桌宠：先在桌宠窗口里选一位角色并唤醒她，再给她换上 VRM 外观。'}
          showIcon
          title="舞蹈只有 VRM 外观可以跳"
          type="info"
        />
      )}
      {pickError && <Alert closable data-dance-pick-error onClose={() => setPickError(null)} showIcon title={pickError} type="error" />}
      {list?.error && <Alert description={`已导入的舞蹈文件还在：${list.dir}`} showIcon title="舞蹈列表读取失败" type="warning" />}
      {st && <NowDancing onLoop={(on) => api().danceLoop(on).then((r) => r.ok && setSt({ ...st, loop: !!r.loop }))} onStop={stop} row={dances.find((d) => d.id === st.id)} st={st} />}
      <Surface description={own.length ? `${own.length} 支导入的舞蹈 · 最新导入的在最前面` : undefined} title="舞蹈">
        <Flexbox gap={12}>
          {list && !own.length && (
            <Flexbox data-dance-empty gap={4}>
              <Text strong>还没有导入舞蹈，先试试内置的示例舞</Text>
              <Text fontSize={12} type="secondary">
                把 MMD 舞蹈（.vmd，可以带音乐和封面）的文件夹导入进来，她就能跟着音乐跳。
              </Text>
            </Flexbox>
          )}
          <div className={styles.grid} data-busy={busy ?? ''} data-can-dance={canDance} data-dance-list data-pet={!!view?.pet} data-vrm={isVrm}>
            {dances.map((d) => {
              const now = st?.id === d.id;
              const go = (
                <Button
                  block
                  data-dance-play={d.id}
                  disabled={!canDance || (!!busy && busy !== d.id)}
                  icon={now ? Square : Play}
                  loading={busy === d.id}
                  onClick={() => (now ? stop() : play(d))}
                  type={now ? 'default' : 'primary'}
                >
                  {now ? '停止' : '让她跳'}
                </Button>
              );
              return (
                <div className={`${styles.card} ${now ? styles.current : ''}`} data-dance={d.id} data-dancing={now} key={d.id}>
                  <Cover className={styles.cover} d={d} />
                  <Flexbox flex={1} gap={6} padding={12}>
                    <Text className={styles.name} title={d.name}>
                      {d.name}
                    </Text>
                    <Flexbox align="center" gap={6} horizontal wrap="wrap">
                      <Text data-dance-duration fontSize={12} type="secondary">
                        {clock(d.duration)}
                      </Text>
                      {now && (
                        <Tag color="processing" size="small">
                          正在跳
                        </Tag>
                      )}
                      {d.builtin && <Tag size="small">内置示例</Tag>}
                      {d.music ? (
                        <Tag data-dance-music="1" icon={<Icon icon={Music} size={12} />} size="small">
                          有音乐
                        </Tag>
                      ) : (
                        <Tag data-dance-music="0" size="small">
                          无音乐
                        </Tag>
                      )}
                      {d.face && <Tag size="small">含表情</Tag>}
                    </Flexbox>
                    {d.credit && (
                      <Text ellipsis fontSize={12} title={d.credit} type="secondary">
                        {d.credit}
                      </Text>
                    )}
                    <Flexbox align="center" gap={8} horizontal style={{ marginBlockStart: 'auto' }}>
                      {canDance ? go : <Tooltip title={isVrm ? '先唤醒桌宠' : '换成 VRM 外观后可以跳'}><span style={{ flex: 1 }}>{go}</span></Tooltip>}
                      {!d.builtin && <ActionIcon data-dance-remove={d.id} icon={Trash2} onClick={() => remove(d)} title="删除舞蹈" />}
                    </Flexbox>
                  </Flexbox>
                </div>
              );
            })}
          </div>
        </Flexbox>
      </Surface>
      <SettingsForm page="dances" />
      <Text fontSize={12} type="secondary">
        舞蹈素材只保存在这台电脑上，不会随角色包导出或分享。{list?.dir ? `舞蹈库位置：${list.dir}` : ''}
      </Text>
    </>
  );
};
