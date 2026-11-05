/**
 * 商店 → 表情包 (docs/stickers-design.md §5.2 方案 B): the official sticker sets on LobeHub's CDN — the index is the
 * CDN's sticker-catalog.json (main falls back to the last good read, then to the copy shipped with the app).
 *
 *   shelf   #/store/stickers        one card per set: cover, name, count, 官方 / author, 适用角色; 全部 / 已获取 and
 *                                   a search; the one main action (获取 / progress + 取消 / 已获取)
 *   detail  #/store/sticker/<id>    every sticker's preview, who made it and its license, 获取 for a character,
 *                                   移除
 *
 * 获取 asks which character gets it; main downloads the zip, checks its size and sha256, unpacks it into
 * <userData>/stickers and attaches it — the set then shows as a read-only 「商店」 group on her 表情包 page and in
 * the chat box's sticker panel. Previews come from main as sticker://store/… (the window's CSP takes no web images).
 */
import {
  Alert,
  Button,
  createStaticStyles,
  cssVar,
  Empty,
  Flexbox,
  Image,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Tag,
  Text,
  toast,
} from "@lobehub/ui";
import { Surface } from "@lobehub/ui/dashboard";
import {
  Check,
  ChevronLeft,
  Download,
  ImageOff,
  RefreshCw,
  Search,
  Smile,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  api,
  type DownloadProgress,
  type StickerStoreState,
  type StoreStickerRow,
} from "../api";
import { ask } from "../fields";
import { useStore } from "../store";
import { downloading, storeStyles } from "./Characters";

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  `,
  art: css`
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 4 / 3;

    background: ${cssVar.colorFillQuaternary};

    img {
      display: block;
      width: 62%;
      height: 82%;
      object-fit: contain;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  noArt: css`
    color: ${cssVar.colorTextQuaternary};
  `,
  ribbon: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 8px;

    display: flex;
    padding: 2px;
    border-radius: ${cssVar.borderRadiusSM};

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowTertiary};
  `,
  name: css`
    color: ${cssVar.colorText};
    font-weight: 600;
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorPrimary};
    }
  `,
  head: css`
    display: grid;
    grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
    gap: 32px;
    align-items: start;

    @media (width <= 760px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  cover: css`
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    aspect-ratio: 1;
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};

    img {
      width: 80%;
      height: 80%;
      object-fit: contain;
    }
  `,
  stickers: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px;
  `,
  sticker: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;

    margin: 0;
    padding: 8px;
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  thumb: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1;
  `,
  info: css`
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 12px 16px;
    align-items: baseline;
  `,
}));

const detailHref = (id: string) => `#/store/sticker/${id}`;

/** The characters a set can go to: one per base (her 表情包 belong to the character, not to one of her looks). */
function useCharacters() {
  const { roster } = useStore();
  return useMemo(() => {
    const seen = new Map<
      string,
      { current: boolean; id: string; name: string }
    >();
    for (const c of roster) {
      const prev = seen.get(c.base);
      if (!prev)
        seen.set(c.base, {
          current: c.current,
          id: c.base,
          name: c.nameZh || c.name,
        });
      else if (c.current) prev.current = true;
    }
    return [...seen.values()];
  }, [roster]);
}

const percent = (p?: DownloadProgress) =>
  p && p.total
    ? Math.min(100, Math.floor(((p.received ?? 0) / p.total) * 100))
    : 0;

/** 获取 / 移除 and the live download progress, the same on the card and the detail page. */
function useStickerActions(done: () => void) {
  const [map, setMap] = useState<Record<string, DownloadProgress>>({});
  const [picking, setPicking] = useState<StoreStickerRow | null>(null);
  useEffect(
    () => api().onCatalogProgress((p) => setMap((m) => ({ ...m, [p.id]: p }))),
    [],
  );
  const get = async (s: StoreStickerRow, speciesId: string, who: string) => {
    setPicking(null);
    if (!s.attached.some((a) => a.id === speciesId))
      setMap((m) => ({
        ...m,
        [s.id]: { id: s.id, received: 0, state: "downloading", total: s.bytes },
      }));
    const r = await api().stickerStore.get(s.id, speciesId);
    done();
    if (r.ok)
      toast.success({
        description: `在 ${who} 的表情包页和聊天的表情包面板里，可以找到「商店 · ${s.name}」分组。`,
        title: `${who} 获取了「${s.name}」`,
      });
    else if (r.reason !== "canceled")
      toast.error({ description: r.text, title: `没能获取「${s.name}」` });
  };
  const remove = async (s: StoreStickerRow) => {
    const who = s.attached.map((a) => a.name).join("、");
    const ok = await ask(
      `移除表情包「${s.name}」？`,
      `${who ? `${who} 的表情包里不再有这组；` : ""}已经发出去的聊天消息照样显示。之后可以在商店重新获取。`,
      "移除表情包",
      true,
    );
    if (!ok) return false;
    const r = await api().stickerStore.remove(s.id);
    setMap((m) => {
      const { [s.id]: _gone, ...rest } = m;
      return rest;
    });
    done();
    if (r.ok) toast.success(`已移除表情包「${s.name}」`);
    else toast.error({ description: r.text, title: `没能移除「${s.name}」` });
    return r.ok;
  };
  return { get, map, picking, remove, setPicking };
}

/** 获取 → which character gets the set (default: one it is made for, else the one on the desktop). */
const GetModal = ({
  s,
  onCancel,
  onOk,
}: {
  onCancel: () => void;
  onOk: (speciesId: string, who: string) => void;
  s: StoreStickerRow | null;
}) => {
  const characters = useCharacters();
  const [target, setTarget] = useState<string>("");
  useEffect(() => {
    if (!s) return;
    const free = characters.filter(
      (c) => !s.attached.some((a) => a.id === c.id),
    );
    const pick =
      free.find((c) => s.forSpecies.some((f) => f.id === c.id)) ??
      free.find((c) => c.current) ??
      free[0];
    setTarget(pick?.id ?? "");
  }, [s, characters]);
  const who = characters.find((c) => c.id === target)?.name ?? target;
  return (
    <Modal
      cancelText="取消"
      destroyOnHidden
      okButtonProps={{
        disabled: !target,
        ...({ "data-sticker-get-confirm": s?.id } as object),
      }}
      okText={s?.installed ? "添加给她" : "获取"}
      onCancel={onCancel}
      onOk={() => target && onOk(target, who)}
      open={!!s}
      title={s ? `获取「${s.name}」` : ""}
    >
      {s && (
        <Flexbox gap={12} paddingBlock={8}>
          <Text type="secondary">
            选一位角色。获取后，这组表情包会出现在她的表情包页和聊天的表情包面板里，只能使用，不能改动。
          </Text>
          <div data-sticker-get-target>
            <Select
              onChange={(v) => setTarget(String(v))}
              options={characters.map((c) => {
                const has = s.attached.some((a) => a.id === c.id);
                return {
                  disabled: has,
                  label: `${c.name}${has ? "（已获取）" : ""}`,
                  value: c.id,
                };
              })}
              placeholder="选择角色"
              style={{ width: "100%" }}
              value={target || undefined}
            />
          </div>
          {s.forSpecies.length > 0 && (
            <Text fontSize={12} type="secondary">
              {`适用角色：${s.forSpecies.map((f) => f.name).join("、")}；其他角色也可以用。`}
            </Text>
          )}
        </Flexbox>
      )}
    </Modal>
  );
};

const DownloadBar = ({
  s,
  p,
}: {
  p?: DownloadProgress;
  s: StoreStickerRow;
}) => {
  if (!downloading(p)) return null;
  const pct = percent(p);
  return (
    <Flexbox data-sticker-download-progress={s.id} gap={4}>
      <Progress percent={pct} showInfo={false} size="small" />
      <Text fontSize={12} type="secondary">
        {p?.state === "installing" ? "正在校验并安装…" : `已下载 ${pct}%`}
      </Text>
    </Flexbox>
  );
};

const FailedLine = ({ s, p }: { p?: DownloadProgress; s: StoreStickerRow }) =>
  p?.state === "failed" && p.reason !== "canceled" && !s.installed ? (
    <Text data-sticker-download-error={s.id} fontSize={12} type="danger">
      {p.text ?? "获取失败，请重试"}
    </Text>
  ) : null;

/** 获取 when nobody has it; 取消 while it downloads; 添加给她 once someone has it (to give it to another). */
const MainAction = ({
  s,
  p,
  onGet,
}: {
  onGet: () => void;
  p?: DownloadProgress;
  s: StoreStickerRow;
}) => {
  if (downloading(p))
    return (
      <Button
        data-sticker-get-cancel={s.id}
        disabled={p?.state === "installing"}
        onClick={() => api().stickerStore.cancel(s.id)}
        size="small"
      >
        取消
      </Button>
    );
  if (s.installed && !s.update)
    return (
      <Button data-sticker-get={s.id} icon={Smile} onClick={onGet} size="small">
        添加给她
      </Button>
    );
  return (
    <Button
      data-sticker-get={s.id}
      icon={Download}
      onClick={onGet}
      size="small"
      type="primary"
    >
      {s.update ? `更新到 v${s.version}` : "获取"}
    </Button>
  );
};

const StateTag = ({ s, p }: { p?: DownloadProgress; s: StoreStickerRow }) =>
  downloading(p) ? (
    <Tag color="processing">获取中</Tag>
  ) : s.installed ? (
    <Tag
      color="success"
      data-sticker-installed={s.id}
      icon={<Check size={12} />}
    >
      已获取
    </Tag>
  ) : (
    <Tag data-sticker-remote={s.id}>未获取</Tag>
  );

const Cover = ({ s }: { s: StoreStickerRow }) =>
  s.coverUrl ? (
    <img alt={`${s.name} 封面`} src={s.coverUrl} />
  ) : (
    <ImageOff className={styles.noArt} size={40} />
  );

const StickerSetCard = ({
  s,
  p,
  onGet,
}: {
  onGet: () => void;
  p?: DownloadProgress;
  s: StoreStickerRow;
}) => (
  <article className={storeStyles.card} data-store-sticker={s.id}>
    <a
      aria-label={`${s.name}：查看全部表情包`}
      className={styles.art}
      data-sticker-set-open={s.id}
      href={detailHref(s.id)}
    >
      <Cover s={s} />
      <span className={styles.ribbon}>
        <StateTag p={p} s={s} />
      </span>
    </a>
    <Flexbox flex={1} gap={8} padding={12}>
      <Flexbox gap={2}>
        <a
          className={styles.name}
          data-sticker-name={s.id}
          href={detailHref(s.id)}
        >
          {s.name}
        </a>
        <Text data-store-sticker-meta={s.id} fontSize={12} type="secondary">
          {[`${s.count} 张`, s.sizeLabel, `v${s.version}`].join(" · ")}
        </Text>
      </Flexbox>
      <Flexbox align="center" gap={6} horizontal wrap="wrap">
        {s.official && (
          <Tag color="blue" data-sticker-official={s.id}>
            官方
          </Tag>
        )}
        <Text
          ellipsis
          fontSize={12}
          style={{ flex: 1, minWidth: 0 }}
          title={s.author}
          type="secondary"
        >
          {s.author}
        </Text>
      </Flexbox>
      <Text
        data-store-sticker-for={s.id}
        ellipsis
        fontSize={12}
        type="secondary"
      >
        {s.attached.length
          ? `已获取：${s.attached.map((a) => a.name).join("、")}`
          : s.forSpecies.length
            ? `适用角色：${s.forSpecies.map((f) => f.name).join("、")}`
            : "适用于所有角色"}
      </Text>
      <DownloadBar p={p} s={s} />
      <FailedLine p={p} s={s} />
      <Flexbox
        align="center"
        gap={8}
        horizontal
        justify="space-between"
        style={{ marginBlockStart: "auto" }}
      >
        <Button href={detailHref(s.id)} size="small" type="text">
          详情
        </Button>
        <MainAction onGet={onGet} p={p} s={s} />
      </Flexbox>
    </Flexbox>
  </article>
);

const SourceLine = ({ st }: { st: StickerStoreState }) => {
  const text =
    st.source === "remote"
      ? "目录来自 LobeHub CDN（刚刚读取）"
      : st.source === "cache"
        ? "目录来自上一次从 LobeHub CDN 读取的副本"
        : "目录来自随应用打包的副本";
  return (
    <Text
      data-sticker-source={st.source}
      fontSize={12}
      title={st.url ?? undefined}
      type="secondary"
    >
      {text}
    </Text>
  );
};

const ShelfSkeleton = () => (
  <div className={styles.grid} data-sticker-loading>
    {[0, 1, 2, 3].map((i) => (
      <Skeleton animated height={300} key={i} radius={cssVar.borderRadiusLG} />
    ))}
  </div>
);

export const StickersShelf = () => {
  const [st, setSt] = useState<StickerStoreState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [show, setShow] = useState<"all" | "installed">("all");
  const [query, setQuery] = useState("");
  const load = useCallback(async (refresh = false) => {
    try {
      const r = await api().stickerStore.list({ refresh });
      setSt(r);
      setFailed(null);
      return r;
    } catch (e: any) {
      setFailed(String(e?.message || e));
      return null;
    }
  }, []);
  const { get, map, picking, setPicking } = useStickerActions(() => load());
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      api().onCatalogProgress((p) => {
        if (
          st?.sets.some((s) => s.id === p.id) &&
          (p.state === "done" || p.state === "failed")
        )
          setTimeout(() => load(), 0);
      }),
    [load, st],
  );
  const retry = async () => {
    setChecking(true);
    const r = await load(true);
    setChecking(false);
    if (r && r.error)
      toast.error({
        description: "请检查网络后再试。",
        title: "没能连上表情包商店",
      });
  };
  if (failed && !st)
    return (
      <div data-sticker-error>
        <Alert
          action={
            <Button
              data-sticker-retry
              icon={RefreshCw}
              loading={checking}
              onClick={retry}
              size="small"
            >
              重试
            </Button>
          }
          description={failed}
          title="表情包商店打不开"
          type="error"
        />
      </div>
    );
  if (!st) return <ShelfSkeleton />;
  const q = query.trim().toLowerCase();
  const installed = st.sets.filter((s) => s.installed).length;
  const items = st.sets.filter(
    (s) =>
      (show === "all" || s.installed) &&
      (!q ||
        [
          s.name,
          s.description,
          s.author,
          ...s.forSpecies.map((f) => f.name),
        ].some((t) => t.toLowerCase().includes(q))),
  );
  return (
    <Flexbox gap={16}>
      {st.error && (
        <div data-sticker-error>
          <Alert
            action={
              <Button
                data-sticker-retry
                icon={RefreshCw}
                loading={checking}
                onClick={retry}
                size="small"
              >
                重试
              </Button>
            }
            description={`${st.source === "bundled" ? "下面是随应用打包的目录，可能不是最新的。" : "下面是上一次读到的目录。"}（${st.error}）`}
            showIcon
            title="没能从 LobeHub CDN 读取最新的表情包目录"
            type="warning"
          />
        </div>
      )}
      <Flexbox
        align="center"
        gap={8}
        horizontal
        justify="space-between"
        wrap="wrap"
      >
        <Flexbox align="center" gap={8} horizontal wrap="wrap">
          <div data-sticker-filter>
            <Segmented
              onChange={(v) => setShow(v as typeof show)}
              options={[
                { label: `全部 ${st.sets.length}`, value: "all" },
                { label: `已获取 ${installed}`, value: "installed" },
              ]}
              size="small"
              value={show}
            />
          </div>
          <Input
            allowClear
            data-sticker-search
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称、作者或角色"
            prefix={<Search size={14} />}
            size="small"
            style={{ width: 220 }}
            value={query}
          />
        </Flexbox>
        <Flexbox align="center" gap={8} horizontal>
          <SourceLine st={st} />
          <Button
            data-sticker-refresh
            icon={RefreshCw}
            loading={checking}
            onClick={retry}
            size="small"
          >
            刷新
          </Button>
        </Flexbox>
      </Flexbox>
      <Text fontSize={12} type="secondary">
        官方整理的表情包合集。获取时选一位角色，之后在她的表情包页和聊天的表情包面板里就能发送；她回复时也会用上。
      </Text>
      {!st.sets.length ? (
        <div data-sticker-empty>
          <Empty description="商店里还没有表情包，之后再来看看。" />
        </div>
      ) : items.length ? (
        <div className={styles.grid} data-store-stickers>
          {items.map((s) => (
            <StickerSetCard
              key={s.id}
              onGet={() => setPicking(s)}
              p={map[s.id]}
              s={s}
            />
          ))}
        </div>
      ) : (
        <div data-sticker-empty>
          <Empty
            description={
              q
                ? `没有和「${query.trim()}」相关的表情包。`
                : "还没有获取表情包。在「全部」里挑一组吧。"
            }
          />
        </div>
      )}
      <GetModal
        onCancel={() => setPicking(null)}
        onOk={(sid, who) => picking && get(picking, sid, who)}
        s={picking}
      />
    </Flexbox>
  );
};

const Info = ({ label, children }: { children: ReactNode; label: string }) => (
  <>
    <Text fontSize={13} type="secondary">
      {label}
    </Text>
    <div>{children}</div>
  </>
);

type Detail = Awaited<
  ReturnType<ReturnType<typeof api>["stickerStore"]["detail"]>
>;

/** 商店 → 表情包 → one set (#/store/sticker/<id>): every sticker, who made it, 获取 / 移除. */
export const StickerSetDetailPage = ({ id }: { id: string }) => {
  const [d, setD] = useState<Detail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setD(await api().stickerStore.detail(id));
      setFailed(null);
    } catch (e: any) {
      setFailed(String(e?.message || e));
    }
  }, [id]);
  const { get, map, picking, remove, setPicking } = useStickerActions(() =>
    load(),
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      api().onCatalogProgress((p) => {
        if (p.id === id && (p.state === "done" || p.state === "failed"))
          setTimeout(() => load(), 0);
      }),
    [id, load],
  );
  const back = (
    <Flexbox horizontal>
      <Button
        data-back="store-stickers"
        href="#/store/stickers"
        icon={ChevronLeft}
        size="small"
        type="text"
      >
        表情包
      </Button>
    </Flexbox>
  );
  if (failed)
    return (
      <Flexbox gap={16}>
        {back}
        <Alert
          action={
            <Button icon={RefreshCw} onClick={load} size="small">
              重试
            </Button>
          }
          description={failed}
          title="没能打开这组表情包"
          type="error"
        />
      </Flexbox>
    );
  if (!d)
    return (
      <Flexbox gap={16}>
        {back}
        <Skeleton animated height={280} radius={cssVar.borderRadiusLG} />
      </Flexbox>
    );
  if (!d.ok)
    return (
      <Flexbox gap={16}>
        {back}
        <Alert
          description="它可能已经从商店下架了。"
          title={`商店里没有表情包「${id}」`}
          type="error"
        />
      </Flexbox>
    );
  const s = d.set;
  const p = map[s.id];
  const missing = d.stickers.filter((x) => !x.url).length;
  return (
    <Flexbox data-sticker-detail={s.id} gap={28}>
      {back}
      <div className={styles.head}>
        <div className={styles.cover}>
          <Cover s={s} />
        </div>
        <Flexbox gap={16} style={{ minWidth: 0 }}>
          <Flexbox gap={6}>
            <Flexbox align="center" gap={12} horizontal wrap="wrap">
              <Text
                as="h1"
                data-sticker-title={s.id}
                fontSize={28}
                strong
                style={{ lineHeight: 1.25, margin: 0 }}
              >
                {s.name}
              </Text>
              <StateTag p={p} s={s} />
              {s.official && <Tag color="blue">官方</Tag>}
            </Flexbox>
            <Text data-sticker-detail-meta={s.id} type="secondary">
              {[`${s.count} 张`, s.sizeLabel, `v${s.version}`].join(" · ")}
            </Text>
          </Flexbox>
          {s.description && (
            <Text style={{ lineHeight: 1.7 }}>{s.description}</Text>
          )}
          <DownloadBar p={p} s={s} />
          <FailedLine p={p} s={s} />
          <Flexbox align="center" gap={8} horizontal wrap="wrap">
            <MainAction onGet={() => setPicking(s)} p={p} s={s} />
            {s.installed && !downloading(p) && (
              <Button
                danger
                data-sticker-remove={s.id}
                icon={Trash2}
                onClick={async () => {
                  await remove(s);
                }}
                size="small"
              >
                移除
              </Button>
            )}
          </Flexbox>
          <div className={styles.info} data-sticker-about={s.id}>
            <Info label="作者">
              <Text fontSize={13}>{s.author}</Text>
            </Info>
            <Info label="授权">
              <Text data-sticker-license={s.id} fontSize={13}>
                {s.license}
              </Text>
            </Info>
            <Info label="适用角色">
              <Text fontSize={13}>
                {s.forSpecies.length
                  ? s.forSpecies.map((f) => f.name).join("、")
                  : "所有角色"}
              </Text>
            </Info>
            <Info label="已获取">
              <Text data-sticker-attached={s.id} fontSize={13}>
                {s.attached.length
                  ? s.attached.map((a) => a.name).join("、")
                  : "还没有"}
              </Text>
            </Info>
          </div>
        </Flexbox>
      </div>
      <Surface title={`全部表情包 · ${d.stickers.length}`}>
        <Flexbox gap={12}>
          {missing > 0 && (
            <Alert
              description="可能是网络问题，获取后会显示全部图片。"
              showIcon
              title={`有 ${missing} 张预览图没能加载`}
              type="warning"
            />
          )}
          <Image.PreviewGroup>
            <div
              className={styles.stickers}
              data-sticker-previews={d.stickers.length}
            >
              {d.stickers.map((x) => (
                <figure
                  className={styles.sticker}
                  data-sticker-preview={x.id}
                  key={x.id}
                  title={x.desc || x.label}
                >
                  <div className={styles.thumb}>
                    {x.url ? (
                      <Image
                        alt={x.label}
                        height={104}
                        objectFit="contain"
                        preview
                        src={x.url}
                        variant="borderless"
                        width={104}
                      />
                    ) : (
                      <ImageOff className={styles.noArt} size={28} />
                    )}
                  </div>
                  <Text as="figcaption" ellipsis fontSize={12}>
                    {x.label}
                  </Text>
                </figure>
              ))}
            </div>
          </Image.PreviewGroup>
        </Flexbox>
      </Surface>
      <GetModal
        onCancel={() => setPicking(null)}
        onOk={(sid, who) => picking && get(picking, sid, who)}
        s={picking}
      />
    </Flexbox>
  );
};
