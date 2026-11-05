// 聊天 → 表情包面板 (docs/stickers-design.md §3.1): the Smile button next to 添加图片 opens her sticker sets —
// one tab per set (built-in memes, the owner's own), a search over name and use, a 5-column grid. One click
// sends that sticker as a message of its own (the draft in the input stays), and the panel closes. The sets
// come from window.petAdmin.stickers (core/stickers.js); a change on her 表情包 page shows at once.
import { ActionIcon, Button, createStaticStyles, cssVar, Empty, Flexbox, Input, Popover, Segmented, Spin, Text, Tooltip } from '@lobehub/ui';
import { Search, Smile } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type Sticker, type StickerSet } from '../api';

const COLS = 5;

const styles = createStaticStyles(({ css }) => ({
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 360px;
  `,
  grid: css`
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(${COLS}, 1fr);
    gap: 8px;

    max-height: 232px;
    padding: 2px;
    align-content: start;
  `,
  cell: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 1;
    padding: 4px;
    border: none;
    border-radius: 8px;

    background: ${cssVar.colorFillTertiary};

    transition: background 150ms ease-out;

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  empty: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 232px;
  `,
}));

const match = (s: Sticker, q: string) => !q || s.label.toLowerCase().includes(q) || (s.desc || '').toLowerCase().includes(q);

interface Props {
  /** her conversation (her base id: stickers are hers, shared by her looks) */
  speciesId: string;
  /** a reply is being written: nothing can be sent until it is done */
  disabled?: boolean;
  /** her name, for the empty state */
  name: string;
  onAdd: () => void;
  onPick: (set: StickerSet, sticker: Sticker) => void;
}

export const StickerPicker = ({ speciesId, disabled, name, onAdd, onPick }: Props) => {
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<StickerSet[] | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await api().stickers.list(speciesId);
    setSets(r.ok ? r.sets.filter((s) => s.stickers.length > 0) : []);
  }, [speciesId]);
  useEffect(() => {
    setSets(null);
    setTab(null);
  }, [speciesId]);
  // read when opened (and again when her stickers change while it is open)
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useEffect(() => api().stickers.onChanged((d) => d.speciesId === speciesId && load()), [speciesId, load]);

  const current = sets?.find((s) => s.id === tab) ?? sets?.[0] ?? null;
  const query = q.trim().toLowerCase();
  // a search looks through every set of hers, not only the open tab
  const shown = useMemo(() => {
    if (!sets) return [];
    if (query) return sets.flatMap((s) => s.stickers.filter((x) => match(x, query)).map((x) => ({ set: s, sticker: x })));
    return current ? current.stickers.map((x) => ({ set: current, sticker: x })) : [];
  }, [sets, current, query]);

  const pick = (set: StickerSet, sticker: Sticker) => {
    if (disabled) return;
    setOpen(false);
    setQ('');
    onPick(set, sticker);
  };

  // arrow keys move through the grid; Enter / Space press the focused cell (a native button)
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: COLS, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS }[e.key];
    if (!step) return;
    const cells = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-sticker-cell]') ?? [])];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    const next = cells[Math.max(0, Math.min(cells.length - 1, at < 0 ? 0 : at + step))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const content = (
    <div className={styles.panel} data-sticker-panel>
      {sets === null ? (
        <div className={styles.empty}>
          <Spin />
        </div>
      ) : sets.length === 0 ? (
        <div className={styles.empty}>
          <Empty
            action={
              <Button
                data-sticker-add
                onClick={() => {
                  setOpen(false);
                  onAdd();
                }}
                size="small"
                type="primary"
              >
                去添加表情包
              </Button>
            }
            description={`${name}还没有表情包`}
          />
        </div>
      ) : (
        <>
          <Input
            allowClear
            aria-label="搜索表情包"
            data-sticker-search
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称或用途"
            prefix={<Search size={14} />}
            size="small"
            value={q}
          />
          {!query && sets.length > 1 && (
            <div data-sticker-tabs>
              <Segmented
                block
                onChange={(v) => setTab(String(v))}
                options={sets.map((s) => ({ label: `${s.name} · ${s.stickers.length}`, value: s.id }))}
                size="small"
                value={current?.id}
              />
            </div>
          )}
          {shown.length ? (
            <div className={styles.grid} data-sticker-grid onKeyDown={onGridKey} ref={gridRef} role="grid">
              {shown.map(({ set, sticker }) => (
                <Tooltip key={`${set.id}/${sticker.id}`} title={sticker.desc ? `${sticker.label}：${sticker.desc}` : sticker.label}>
                  <button
                    aria-label={`发送表情包：${sticker.label}`}
                    className={styles.cell}
                    data-sticker-cell={`${set.id}/${sticker.id}`}
                    disabled={disabled}
                    onClick={() => pick(set, sticker)}
                    type="button"
                  >
                    <img alt={sticker.label} draggable={false} loading="lazy" src={sticker.url} />
                  </button>
                </Tooltip>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              <Text type="secondary">没有找到「{q.trim()}」</Text>
            </div>
          )}
          <Flexbox horizontal justify="space-between">
            <Text fontSize={12} type="secondary">
              点一下直接发送
            </Text>
            <Button
              data-sticker-manage
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
              size="small"
              type="link"
            >
              管理表情包
            </Button>
          </Flexbox>
        </>
      )}
    </div>
  );

  return (
    <Popover arrow={false} content={content} onOpenChange={setOpen} open={open} placement="topLeft" trigger="click">
      <ActionIcon data-sticker-open disabled={disabled} icon={Smile} title={disabled ? '她回复完才能发表情包' : '表情包'} />
    </Popover>
  );
};
