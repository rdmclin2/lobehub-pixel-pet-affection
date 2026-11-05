/**
 * 商店 → 小游戏 (docs/mini-games.md §7): the store's game packs — the ones shipped with the app and the newest from
 * the games repository (rdmclin2/pixel-pet-mini-games, core/game-index.js). A game is data only — pictures and a
 * manifest — played by the app's own engine in the game window.
 *
 *   shelf   #/store/games         one card per game: cover, name, state, version, one line, its one main action
 *   detail  #/store/game/<id>     everything else (P-03): state and every action (开始玩 / 下载 / 更新 / 取消 /
 *                                 开源仓库 / 删除), what it offers, the newest version's notes, her progress in it,
 *                                 and where it comes from
 *
 * 下载 puts it in userData/games/<id>/, 开始玩 opens the game window with her in it, 更新 replaces it with the newer
 * version (her progress stays), 删除 takes it away. Progress arrives as `catalog-progress`.
 */
import { Github } from "@lobehub/icons";
import { ActionIcon, Alert, Button, createStaticStyles, cssVar, Flexbox, Image, Progress, Tag, Text, toast } from "@lobehub/ui";
import { Surface } from "@lobehub/ui/dashboard";
import { Check, ChevronLeft, ChevronRight, Download, Gamepad2, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { api, type DownloadProgress, type GameProgress, type GameStoreState, type StoreGameRow } from "../api";
import { ask } from "../fields";
import { downloading, storeStyles } from "./Characters";

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  `,
  art: css`
    position: relative;
    overflow: hidden;
    display: block;
    aspect-ratio: 16 / 10;
    background: ${cssVar.colorFillQuaternary};

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  noArt: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
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
  oneLine: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  `,
  // the detail page, top to bottom: the cover and who it is / what to do with it side by side; a row of
  // screenshots (App Store style, scrolls sideways, opens large); then its notes, her progress and 关于
  head: css`
    display: grid;
    grid-template-columns: minmax(260px, 400px) minmax(0, 1fr);
    gap: 32px;
    align-items: start;

    @media (width <= 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  cover: css`
    overflow: hidden;
    aspect-ratio: 16 / 10;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  shots: css`
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 2px;
    overflow-x: auto;
    display: flex;
    gap: 16px;

    padding-block-end: 8px;

    scrollbar-width: thin;
  `,
  shot: css`
    scroll-snap-align: start;
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;

    width: 352px;
    margin: 0;

    img {
      border-radius: ${cssVar.borderRadiusLG};
    }
  `,
  sections: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 20px;
    align-items: start;

    @media (width <= 860px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  notes: css`
    white-space: pre-wrap;
    line-height: 1.7;
  `,
  info: css`
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 12px 16px;
    align-items: baseline;
  `,
  quest: css`
    display: flex;
    gap: 12px;
    align-items: center;
    padding-block: 6px;
  `,
  check: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 18px;
    height: 18px;
    border: 1.5px solid ${cssVar.colorBorder};
    border-radius: 5px;

    &[data-done="true"] {
      border-color: ${cssVar.colorSuccess};
      color: ${cssVar.colorSuccess};
    }
  `,
}));

const STATE_TAG: Record<StoreGameRow["state"], { color?: string; text: string }> = {
  downloading: { color: "processing", text: "下载中" },
  installed: { color: "success", text: "已下载" },
  remote: { text: "未下载" },
  unsupported: { color: "warning", text: "需要更新应用" },
  update: { color: "orange", text: "有更新" },
};
const detailHref = (id: string) => `#/store/game/${id}`;

// what a row looks like right now, with the live download progress laid over it
function live(g: StoreGameRow, p?: DownloadProgress) {
  // 'done' arrives a moment before the refreshed row says installed: stay on 正在安装…
  const settling = p?.state === "done" && g.state !== "installed";
  const busy = downloading(p) || settling;
  const state = busy ? "downloading" : g.state;
  const pct = busy ? (p && p.total ? Math.min(100, Math.floor(((p.received ?? 0) / p.total) * 100)) : 0) : (g.percent ?? 0);
  const installing = busy ? p?.state === "installing" || settling : !!g.installing;
  return { state, pct, installing, playable: state === "installed" || state === "update" };
}

const versionLine = (g: StoreGameRow) =>
  g.installedVersion && g.installedVersion !== g.version ? `v${g.installedVersion} → v${g.version}` : `v${g.version}`;
const blockedText = (g: StoreGameRow) =>
  g.minAppVersion
    ? `v${g.version} 需要 Pixel Pet ${g.minAppVersion} 或更新的版本，请先更新应用。`
    : `v${g.version} 需要更新版本的应用才能玩，请先更新应用。`;

// download / update, play, remove — the same on the card and the detail page; `done` gets the new store state
function useGameActions(done: (s: GameStoreState) => void) {
  const [map, setMap] = useState<Record<string, DownloadProgress>>({});
  useEffect(() => api().onCatalogProgress((p) => setMap((m) => ({ ...m, [p.id]: p }))), []);
  const start = async (g: StoreGameRow) => {
    const updating = g.state === "update";
    setMap((m) => ({ ...m, [g.id]: { id: g.id, received: 0, state: "downloading", total: g.bytes } }));
    const r = await api().gameDownload(g.id);
    if (r.store) done(r.store);
    if (r.ok && updating) toast.success({ description: "进度（今日小事、菜地、收集到的东西）都保留着。", title: `「${g.name}」已更新到 v${g.version}` });
    else if (r.ok) toast.success({ description: "点「开始玩」，她就会进到游戏里；托盘「小游戏」和她面板上的 ⌂ 也能打开。", title: `「${g.name}」下载好了` });
    else if (r.reason !== "canceled") toast.error({ description: r.text, title: updating ? `没能更新「${g.name}」` : `没能下载「${g.name}」` });
  };
  const play = async (g: StoreGameRow) => {
    const r = await api().gamePlay(g.id);
    if (!r || !r.ok) toast.error({ description: r?.reason === "no-pet" ? "先在桌面上领养一位角色。" : "请稍后再试。", title: `没能打开「${g.name}」` });
  };
  const remove = async (g: StoreGameRow) => {
    const ok = await ask(`删除小游戏「${g.name}」？`, "游戏文件会被删掉，进度（今日小事、收集到的东西）会保留；之后可以在商店重新下载。", "删除小游戏", true);
    if (!ok) return false;
    const r = await api().gameRemove(g.id);
    if (r.store) done(r.store);
    setMap((m) => {
      const { [g.id]: _gone, ...rest } = m;
      return rest;
    });
    if (r.ok) toast.success(`已删除小游戏「${g.name}」`);
    else toast.error({ description: r.text, title: `没能删除「${g.name}」` });
    return r.ok;
  };
  return { map, start, play, remove };
}

// the one main action of a game in its current state (a card has only this one)
const MainAction = ({ g, p, onDownload, onPlay }: { g: StoreGameRow; onDownload: () => void; onPlay: () => void; p?: DownloadProgress }) => {
  const s = live(g, p);
  if (s.playable)
    return (
      <Button data-game-play={g.id} icon={Gamepad2} onClick={onPlay} size="small" type="primary">
        开始玩
      </Button>
    );
  if (s.state === "downloading")
    return (
      <Button data-game-download-cancel={g.id} disabled={s.installing} onClick={() => api().gameDownloadCancel(g.id)} size="small">
        取消
      </Button>
    );
  return (
    <Button data-game-download={g.id} disabled={s.state === "unsupported"} icon={Download} onClick={onDownload} size="small" type="primary">
      下载
    </Button>
  );
};

const DownloadBar = ({ g, p }: { g: StoreGameRow; p?: DownloadProgress }) => {
  const s = live(g, p);
  if (s.state !== "downloading") return null;
  return (
    <Flexbox data-game-download-progress={g.id} gap={4}>
      <Progress percent={s.pct} showInfo={false} size="small" />
      <Text fontSize={12} type="secondary">
        {s.installing ? "正在安装…" : `已下载 ${s.pct}%`}
      </Text>
    </Flexbox>
  );
};

const StateTag = ({ g, p }: { g: StoreGameRow; p?: DownloadProgress }) => {
  const tag = STATE_TAG[live(g, p).state];
  return (
    <Tag color={tag.color} data-game-tag={g.id}>
      {tag.text}
    </Tag>
  );
};

/** One game on the shelf: just enough to pick it; the rest is on its page. */
const GameCard = ({ g, p, last, onDownload, onPlay }: { g: StoreGameRow; last: boolean; onDownload: () => void; onPlay: () => void; p?: DownloadProgress }) => (
  <article className={storeStyles.card} data-game-state={live(g, p).state} data-store-game={g.id}>
    <a aria-label={`${g.name}：查看详情`} className={styles.art} data-game-open={g.id} href={detailHref(g.id)}>
      {g.pictureSrc ? (
        <img alt={g.name} src={g.pictureSrc} />
      ) : (
        <div className={styles.noArt}>
          <Gamepad2 size={40} />
        </div>
      )}
      <span className={styles.ribbon}>
        <StateTag g={g} p={p} />
      </span>
    </a>
    <Flexbox flex={1} gap={8} padding={12}>
      <Flexbox gap={2}>
        <a className={styles.name} data-game-name={g.id} href={detailHref(g.id)}>
          {g.name}
        </a>
        <Text data-store-game-meta={g.id} fontSize={12} type="secondary">
          {[versionLine(g), g.sizeLabel, last && "上次玩的"].filter(Boolean).join(" · ")}
        </Text>
      </Flexbox>
      <Text className={styles.oneLine} data-store-game-desc={g.id} fontSize={13} type="secondary">
        {g.description}
      </Text>
      <DownloadBar g={g} p={p} />
      <Flexbox align="center" gap={8} horizontal justify="space-between" style={{ marginBlockStart: "auto" }}>
        <Button href={detailHref(g.id)} size="small" type="text">
          详情
        </Button>
        <MainAction g={g} onDownload={onDownload} onPlay={onPlay} p={p} />
      </Flexbox>
    </Flexbox>
  </article>
);

const checkedLabel = (t: number | null) => {
  if (!t) return "还没检查过新版本";
  const d = new Date(t);
  return `上次检查新版本：${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const GamesShelf = () => {
  const [st, setSt] = useState<GameStoreState | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(async (refresh = false) => {
    const r = await api().gameStore({ refresh });
    setSt(r);
    return r;
  }, []);
  const { map, start, play } = useGameActions(setSt);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => api().onGameUpdates(() => load()), [load]);
  useEffect(() => api().onCatalogProgress((p) => { if (p.state === "done" || p.state === "failed") setTimeout(() => load(), 0); }), [load]);
  const check = async () => {
    setChecking(true);
    const r = await load(true);
    setChecking(false);
    const ups = r.games.filter((g) => g.state === "update");
    if (r.checkError) toast.error({ description: "请检查网络后再试。", title: "没能检查新版本" });
    else if (ups.length) toast.info(`有 ${ups.length} 个小游戏可以更新`);
    else toast.success("都是最新版本");
  };
  if (!st) return null;
  if (!st.games.length) return <Alert description="目前没有可以下载的小游戏。" title="商店里还没有小游戏" type="info" />;
  return (
    <Flexbox gap={16}>
      <Flexbox align="center" gap={12} horizontal justify="space-between" wrap="wrap">
        <Text fontSize={12} style={{ flex: 1, minWidth: 280 }} type="secondary">
          她会进到小游戏里自己走动、做事，你可以调时段和天气，陪她完成每天的小事。点卡片看详情。
        </Text>
        <Flexbox align="center" gap={8} horizontal>
          <Text data-game-checked fontSize={12} type="secondary">
            {checkedLabel(st.checkedAt)}
          </Text>
          <Button data-game-check icon={RefreshCw} loading={checking} onClick={check} size="small">
            检查更新
          </Button>
        </Flexbox>
      </Flexbox>
      <div className={styles.grid} data-store-games>
        {st.games.map((g) => (
          <GameCard g={g} key={g.id} last={st.last === g.id} onDownload={() => start(g)} onPlay={() => play(g)} p={map[g.id]} />
        ))}
      </div>
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

const ProgressPanel = ({ progress }: { progress: GameProgress }) => {
  const done = progress.quests.filter((q) => q.done).length;
  const have = Object.entries(progress.items).filter(([, n]) => n > 0);
  return (
    <Surface title={`你们的进度 · 今日小事 ${done}/${progress.quests.length}`}>
      <Flexbox data-game-progress gap={4}>
        {progress.quests.map((q) => (
          <div className={styles.quest} data-quest={q.id} key={q.id}>
            <span className={styles.check} data-done={q.done}>
              {q.done && <Check size={12} strokeWidth={3} />}
            </span>
            <Flexbox flex={1} gap={0} style={{ minWidth: 0 }}>
              <Text delete={q.done} type={q.done ? "secondary" : undefined}>
                {q.title}
              </Text>
              {q.hint && !q.done && (
                <Text fontSize={12} type="secondary">
                  {q.hint}
                </Text>
              )}
            </Flexbox>
            {q.count > 1 && (
              <Text fontSize={12} type="secondary">
                {`${q.n}/${q.count}`}
              </Text>
            )}
          </div>
        ))}
        <Text fontSize={12} style={{ marginBlockStart: 8 }} type="secondary">
          {have.length ? `收集到：${have.map(([k, n]) => `${progress.itemNames[k] ?? k} ×${n}`).join("　")}` : "还没有收集到东西。"}
          {"　每天三件小事，完成一件好感 +2（每天最多三次）。"}
        </Text>
      </Flexbox>
    </Surface>
  );
};

/** 预览: the game's screenshots in a row that scrolls sideways (‹ › or a swipe); a click opens them large. */
const Gallery = ({ shots }: { shots: { caption: string; src: string }[] }) => {
  const row = useRef<HTMLDivElement>(null);
  const page = (dir: number) => row.current?.scrollBy({ behavior: "smooth", left: dir * (352 + 16) });
  return (
    <Flexbox data-game-shots={shots.length} gap={12}>
      <Flexbox align="center" horizontal justify="space-between">
        <Text strong>预览</Text>
        <Flexbox gap={4} horizontal>
          <ActionIcon icon={ChevronLeft} onClick={() => page(-1)} size="small" title="上一张" />
          <ActionIcon icon={ChevronRight} onClick={() => page(1)} size="small" title="下一张" />
        </Flexbox>
      </Flexbox>
      <Image.PreviewGroup>
        <div className={styles.shots} ref={row}>
          {shots.map((x, i) => (
            <figure className={styles.shot} data-game-shot={i} key={x.src.slice(-80) + i}>
              <Image alt={x.caption || `预览 ${i + 1}`} height={220} objectFit="cover" preview src={x.src} variant="borderless" width={352} />
              {x.caption && (
                <Text as="figcaption" fontSize={12} type="secondary">
                  {x.caption}
                </Text>
              )}
            </figure>
          ))}
        </div>
      </Image.PreviewGroup>
    </Flexbox>
  );
};

/** 商店 → 小游戏 → one game (#/store/game/<id>). */
export const GameDetailPage = ({ id }: { id: string }) => {
  const [d, setD] = useState<Awaited<ReturnType<ReturnType<typeof api>["gameDetail"]>> | null>(null);
  const load = useCallback(async () => setD(await api().gameDetail(id)), [id]);
  const { map, start, play, remove } = useGameActions(() => load());
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => api().onGameUpdates(() => load()), [load]);
  useEffect(() => api().onCatalogProgress((p) => { if (p.id === id && (p.state === "done" || p.state === "failed")) setTimeout(() => load(), 0); }), [id, load]);
  const back = (
    <Flexbox horizontal>
      <Button data-back="store-games" href="#/store/games" icon={ChevronLeft} size="small" type="text">
        小游戏
      </Button>
    </Flexbox>
  );
  if (!d) return back;
  if (!d.ok || !d.game)
    return (
      <Flexbox gap={16}>
        {back}
        <Alert description="它可能已经从商店下架了。" title={`商店里没有小游戏「${id}」`} type="error" />
      </Flexbox>
    );
  const g = d.game;
  const p = map[g.id];
  const s = live(g, p);
  const source = g.source === "remote" ? "开源仓库（应用发布后上架或更新的版本）" : "随应用一起发布的商店目录";
  return (
    <Flexbox data-game-detail={g.id} gap={28}>
      {back}
      <div className={styles.head}>
        <div className={styles.cover}>
          {g.pictureSrc ? (
            <img alt={g.name} src={g.pictureSrc} />
          ) : (
            <div className={styles.noArt}>
              <Gamepad2 size={56} />
            </div>
          )}
        </div>
        <Flexbox gap={20} style={{ minWidth: 0 }}>
          <Flexbox gap={6}>
            <Flexbox align="center" gap={12} horizontal wrap="wrap">
              <Text as="h1" data-game-title={g.id} fontSize={28} strong style={{ lineHeight: 1.25, margin: 0 }}>
                {g.name}
              </Text>
              <StateTag g={g} p={p} />
            </Flexbox>
            <Text data-game-detail-meta={g.id} type="secondary">
              {[versionLine(g), g.sizeLabel, d.last === g.id && "上次玩的"].filter(Boolean).join(" · ")}
            </Text>
          </Flexbox>
          <Text style={{ lineHeight: 1.7 }}>{g.description}</Text>
          {g.features.length > 0 && (
            <Flexbox gap={6} horizontal wrap="wrap">
              {g.features.map((f) => (
                <Tag key={f}>{f}</Tag>
              ))}
            </Flexbox>
          )}
          {(s.state === "unsupported" || g.updateBlocked) && <Alert data-game-unsupported={g.id} description={g.updateBlocked ? "已经装好的版本照样能玩。" : undefined} title={blockedText(g)} type="warning" />}
          <DownloadBar g={g} p={p} />
          <Flexbox align="center" gap={8} horizontal wrap="wrap">
            <MainAction g={g} onDownload={() => start(g)} onPlay={() => play(g)} p={p} />
            {s.state === "update" && (
              <Button data-game-update={g.id} icon={RefreshCw} onClick={() => start(g)} size="small">
                {`更新到 v${g.version}`}
              </Button>
            )}
            <Button data-game-repo={g.id} icon={<Github size={14} />} onClick={() => api().openLink(g.repo)} size="small" title={g.repo}>
              开源仓库
            </Button>
          </Flexbox>
        </Flexbox>
      </div>
      {d.shots && d.shots.length > 0 && <Gallery shots={d.shots} />}
      <div className={styles.sections}>
        <Flexbox gap={20} style={{ minWidth: 0 }}>
          {g.changelog && (
            <Surface title={s.state === "update" ? `v${g.version} 更新了什么` : `v${g.version} 更新说明`}>
              <Text className={styles.notes} data-game-changelog={g.id} fontSize={13}>
                {g.changelog}
              </Text>
            </Surface>
          )}
          {d.progress && <ProgressPanel progress={d.progress} />}
        </Flexbox>
        <Flexbox gap={20} style={{ minWidth: 0 }}>
          <Surface title="关于">
            <div className={styles.info} data-game-about={g.id}>
              <Info label="版本">{g.installedVersion ? `已装 v${g.installedVersion} · 最新 v${g.version}` : `最新 v${g.version}`}</Info>
              <Info label="大小">{g.sizeLabel}</Info>
              <Info label="署名">
                <Text fontSize={13}>{g.credit || "--"}</Text>
              </Info>
              <Info label="玩法引擎">
                <Text fontSize={13}>{`${g.engine}（应用自带；游戏包里只有图片和配置）`}</Text>
              </Info>
              {g.minAppVersion && <Info label="需要应用">{`Pixel Pet ${g.minAppVersion} 或更新`}</Info>}
              <Info label="来源">
                <Text fontSize={13}>{source}</Text>
              </Info>
              <Info label="源码">
                <Button onClick={() => api().openLink(g.repo)} size="small" style={{ paddingInline: 0 }} type="link">
                  {g.repo.replace(/^https:\/\//, "")}
                </Button>
              </Info>
            </div>
          </Surface>
          {s.playable && (
            <Flexbox align="center" gap={12} horizontal justify="space-between" wrap="wrap">
              <Text fontSize={12} type="secondary">
                删除后游戏文件会被删掉，进度保留，之后可以重新下载。
              </Text>
              <Button
                danger
                data-game-remove={g.id}
                icon={Trash2}
                onClick={async () => {
                  if (await remove(g)) location.hash = "#/store/games";
                }}
                size="small"
              >
                删除小游戏
              </Button>
            </Flexbox>
          )}
        </Flexbox>
      </div>
    </Flexbox>
  );
};
