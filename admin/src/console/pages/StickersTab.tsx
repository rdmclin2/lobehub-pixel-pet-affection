// 角色 → 她的详情页 → 表情包 (docs/stickers-design.md §4): the sticker sets she holds — her built-in memes
// (read-only) and her owner's own set: add several pictures at once (a file dialog, each one checked in main),
// see them in a grid, rename one / say when she uses it, delete one or several (asked first). Everything comes
// from window.petAdmin.stickers and is stored in <userData>/stickers (src/core/stickers.js).
import { ActionIcon, Alert, Button, Checkbox, createStaticStyles, cssVar, Empty, Flexbox, Icon, Input, Modal, Segmented, Skeleton, Tag, Text, TextArea, toast } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { ImagePlus, Pencil, RotateCw, Smile, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, type RosterRow, type Sticker, type StickerRejected, type StickerSet } from '../api';
import { ask } from '../fields';
import { useStore } from '../store';

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 12px;
  `,
  card: css`
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    &[data-selected='true'] {
      border-color: ${cssVar.colorPrimary};
    }

    &:hover [data-sticker-actions],
    &:focus-within [data-sticker-actions] {
      opacity: 1;
    }
  `,
  art: css`
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 1;
    padding: 12px;

    background: ${cssVar.colorFillQuaternary};

    img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
  `,
  meta: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px 12px;
  `,
  actions: css`
    position: absolute;
    inset-block-start: 6px;
    inset-inline-end: 6px;

    display: flex;
    gap: 4px;

    border-radius: ${cssVar.borderRadius};

    opacity: 0;
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowTertiary};

    transition: opacity 150ms ease-out;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  check: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;
  `,
  badge: css`
    position: absolute;
    inset-block-end: 56px;
    inset-inline-end: 8px;
  `,
  add: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;

    min-height: 180px;
    border: 1px dashed ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &:hover:not(:disabled) {
      border-color: ${cssVar.colorPrimary};
      color: ${cssVar.colorPrimary};
    }

    &:disabled {
      cursor: progress;
      opacity: 0.6;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
}));

type Load = { error: string; sets: null } | { error: null; sets: StickerSet[] } | { error: null; sets: null };

const StickerCard = ({ s, readOnly, selecting, selected, onToggle, onEdit, onDelete }: { onDelete: (s: Sticker) => void; onEdit: (s: Sticker) => void; onToggle: (id: string) => void; readOnly: boolean; s: Sticker; selected: boolean; selecting: boolean }) => (
  <div className={styles.card} data-selected={selected} data-sticker={s.id}>
    <div className={styles.art}>
      <img alt={s.label} draggable={false} loading="lazy" src={s.url} />
    </div>
    {s.animated && (
      <div className={styles.badge}>
        <Tag size="small">动图</Tag>
      </div>
    )}
    <div className={styles.meta}>
      <Text ellipsis strong>
        {s.label}
      </Text>
      <Text ellipsis fontSize={12} type="secondary">
        {s.desc || '还没写用途'}
      </Text>
    </div>
    {!readOnly && selecting && (
      <div className={styles.check}>
        <Checkbox aria-label={`选择「${s.label}」`} checked={selected} onChange={() => onToggle(s.id)} />
      </div>
    )}
    {!readOnly && !selecting && (
      <div className={styles.actions} data-sticker-actions>
        <ActionIcon aria-label={`编辑「${s.label}」`} icon={Pencil} onClick={() => onEdit(s)} size="small" title="编辑" />
        <ActionIcon aria-label={`删除「${s.label}」`} data-sticker-delete={s.id} icon={Trash2} onClick={() => onDelete(s)} size="small" title="删除" />
      </div>
    )}
  </div>
);

export const StickersTab = ({ c }: { c: RosterRow }) => {
  const { settings } = useStore();
  const speciesId = c.base;
  const [load, setLoad] = useState<Load>({ error: null, sets: null });
  const [setId, setSetId] = useState<string>(`mine-${speciesId}`);
  const [adding, setAdding] = useState(false);
  const [rejected, setRejected] = useState<StickerRejected[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Sticker | null>(null);
  const [draft, setDraft] = useState({ desc: '', label: '' });

  const refresh = useCallback(async () => {
    try {
      const r = await api().stickers.list(speciesId);
      if (r.ok) setLoad({ error: null, sets: r.sets });
      else setLoad({ error: r.message || '读不到她的表情包', sets: null });
    } catch (e: any) {
      setLoad({ error: String(e?.message || e), sets: null });
    }
  }, [speciesId]);

  useEffect(() => {
    setLoad({ error: null, sets: null });
    setSetId(`mine-${speciesId}`);
    setSelecting(false);
    setSelected([]);
    setRejected([]);
    refresh();
    return api().stickers.onChanged((d) => {
      if (d.speciesId === speciesId) refresh();
    });
  }, [speciesId, refresh]);

  const add = async () => {
    setAdding(true);
    try {
      const r = await api().stickers.pickAndAdd(speciesId);
      if (r.reason === 'canceled') return;
      setRejected(r.rejected ?? []);
      if (r.added?.length) toast.success(`已添加 ${r.added.length} 张表情包${r.rejected?.length ? `，${r.rejected.length} 张没有添加` : ''}`);
      else toast.error(r.message || '没有可以添加的图片');
      await refresh();
    } finally {
      setAdding(false);
    }
  };

  const remove = async (ids: string[], what: string) => {
    if (!(await ask(`删除${what}？`, `删除后她不会再用${ids.length > 1 ? '这些' : '这张'}表情包；已经发进聊天里的仍然能看到。`, '删除表情包', true))) return;
    const r = await api().stickers.remove(speciesId, ids);
    if (r.ok) {
      toast.success(`已删除 ${r.removed} 张表情包`);
      setSelected([]);
      setSelecting(false);
    } else toast.error(r.message || '没能删除');
    await refresh();
  };

  const saveEdit = async () => {
    if (!editing) return;
    const r = await api().stickers.update(speciesId, editing.id, draft);
    if (!r.ok) return void toast.error(r.message || '没能保存');
    toast.success('已保存');
    setEditing(null);
    await refresh();
  };

  const toggle = (id: string) => setSelected((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  if (load.error)
    return (
      <Alert
        action={
          <Button icon={RotateCw} onClick={refresh} size="small">
            重试
          </Button>
        }
        data-stickers-error
        description={load.error}
        title="读不到她的表情包"
        type="error"
      />
    );
  if (!load.sets)
    return (
      <Surface title={`${c.nameZh}的表情包`}>
        <div aria-busy className={styles.grid} data-stickers-loading>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton animated height={180} key={i} radius={cssVar.borderRadiusLG} />
          ))}
        </div>
      </Surface>
    );

  const sets = load.sets;
  const set = sets.find((s) => s.id === setId) ?? sets.find((s) => s.kind === 'mine') ?? sets[0];
  const mine = set && !set.readOnly;
  const total = sets.reduce((n, s) => n + s.stickers.length, 0);

  return (
    <Flexbox data-stickers={speciesId} gap={16}>
      {settings?.prefs?.memes === false && <Alert title="她现在不会主动发表情包（在 设置 → 桌宠行为 打开）" type="info" />}
      <Surface
        description={`她回复时会从这里挑一张合适的配上（共 ${total} 张）。图片支持 PNG、JPG、WebP、GIF，单张不超过 2 MB，边长 64–1024 px。`}
        title={`${c.nameZh}的表情包`}
      >
        <Flexbox gap={16}>
          <Flexbox align="center" gap={8} horizontal justify="space-between" wrap="wrap">
            <Segmented
              onChange={(v) => {
                setSetId(String(v));
                setSelecting(false);
                setSelected([]);
              }}
              options={sets.map((s) => ({ label: `${s.name} · ${s.stickers.length}`, value: s.id }))}
              value={set?.id}
            />
            {mine && set.stickers.length > 0 && (
              <Flexbox gap={8} horizontal>
                {selecting ? (
                  <>
                    <Button data-stickers-delete-selected danger disabled={!selected.length} icon={Trash2} onClick={() => remove(selected, `所选的 ${selected.length} 张表情包`)}>
                      {`删除所选（${selected.length}）`}
                    </Button>
                    <Button
                      onClick={() => {
                        setSelecting(false);
                        setSelected([]);
                      }}
                    >
                      完成
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={() => setSelecting(true)}>选择</Button>
                    <Button data-stickers-add icon={ImagePlus} loading={adding} onClick={add}>
                      添加表情包
                    </Button>
                  </>
                )}
              </Flexbox>
            )}
          </Flexbox>
          {rejected.length > 0 && (
            <Alert
              closable
              data-stickers-rejected
              description={
                <Flexbox gap={2}>
                  {rejected.map((x, i) => (
                    <Text key={`${x.name}-${i}`} type="secondary">{`${x.name}：${x.message}`}</Text>
                  ))}
                </Flexbox>
              }
              onClose={() => setRejected([])}
              title={`${rejected.length} 张图片没有添加`}
              type="warning"
            />
          )}
          {set && set.stickers.length === 0 && mine ? (
            <Empty
              action={
                <Button data-stickers-add icon={ImagePlus} loading={adding} onClick={add} type="primary">
                  添加表情包
                </Button>
              }
              data-stickers-empty
              description="一次可以选多张图片。她会在合适的时候发给你。"
              icon={Smile}
              title={`还没有给${c.nameZh}添加表情包`}
            />
          ) : (
            <div className={styles.grid} data-stickers-grid={set?.id}>
              {mine && !selecting && (
                <button className={styles.add} data-stickers-add-tile disabled={adding} onClick={add} type="button">
                  <Icon icon={ImagePlus} size={24} />
                  <Text type="secondary">{adding ? '正在添加…' : '添加表情包'}</Text>
                </button>
              )}
              {set?.stickers.map((s) => (
                <StickerCard
                  key={s.id}
                  onDelete={(x) => remove([x.id], `「${x.label}」`)}
                  onEdit={(x) => {
                    setDraft({ desc: x.desc, label: x.label });
                    setEditing(x);
                  }}
                  onToggle={toggle}
                  readOnly={!!set.readOnly}
                  s={s}
                  selected={selected.includes(s.id)}
                  selecting={selecting}
                />
              ))}
            </div>
          )}
          {set?.readOnly && (
            <Text data-sticker-readonly={set.kind} type="secondary">
              {set.kind === 'store' ? '这组来自商店，只能使用，不能删除或修改其中的图片；不需要了可以在 商店 → 表情包 里移除。' : '内置表情包随角色提供，不能删除或修改。'}
            </Text>
          )}
        </Flexbox>
      </Surface>
      <Modal cancelText="取消" destroyOnHidden okText="保存" onCancel={() => setEditing(null)} onOk={saveEdit} open={!!editing} title="编辑表情包">
        {editing && (
          <Flexbox data-sticker-edit={editing.id} gap={12}>
            <Flexbox gap={6}>
              <Text strong>名称</Text>
              <Input maxLength={20} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} value={draft.label} />
            </Flexbox>
            <Flexbox gap={6}>
              <Text strong>用途</Text>
              <TextArea autoSize={{ maxRows: 4, minRows: 2 }} maxLength={60} onChange={(e) => setDraft((d) => ({ ...d, desc: e.target.value }))} placeholder="比如：被夸的时候、开心到冒花" value={draft.desc} />
              <Text fontSize={12} type="secondary">
                她会根据这段话决定什么时候用这张。
              </Text>
            </Flexbox>
          </Flexbox>
        )}
      </Modal>
    </Flexbox>
  );
};
