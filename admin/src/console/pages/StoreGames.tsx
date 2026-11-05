/**
 * 商店 → 小游戏 (docs/mini-games.md §7): the store's game packs — the ones shipped with the app and the newest from
 * the games repository (rdmclin2/pixel-pet-mini-games, core/game-index.js). A game is data only — pictures and a
 * manifest — played by the app's own engine in the game window. 下载 puts it in userData/games/<id>/, 开始玩 opens
 * the game window with her in it, 更新 replaces it with the newer version (her progress stays), 删除 takes it away;
 * 开源仓库 opens its source. Progress arrives as `catalog-progress`.
 */
import { Alert, Button, createStaticStyles, cssVar, Flexbox, Progress, Tag, Text, toast } from "@lobehub/ui";
import { Github } from "@lobehub/icons";
import { Download, Gamepad2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, type DownloadProgress, type GameStoreState, type StoreGameRow } from "../api";
import { ask } from "../fields";
import { downloading, storeStyles } from "./Characters";

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  `,
  art: css`
    position: relative;
    overflow: hidden;
    aspect-ratio: 16 / 10;
    background: ${cssVar.colorFillQuaternary};

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
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

    .ant-tag {
      margin: 0;
    }
  `,
  notes: css`
    padding: 8px 10px;
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillTertiary};
    white-space: pre-wrap;
  `,
}));

const STATE_TAG: Record<StoreGameRow["state"], { color?: string; text: string }> = {
  downloading: { color: "processing", text: "下载中" },
  installed: { color: "success", text: "已下载" },
  remote: { text: "未下载" },
  unsupported: { color: "warning", text: "需要更新应用" },
  update: { color: "orange", text: "有更新" },
};

const GameCard = ({
  g,
  p,
  last,
  onDownload,
  onPlay,
  onRemove,
}: {
  g: StoreGameRow;
  last: boolean;
  onDownload: () => void;
  onPlay: () => void;
  onRemove: () => void;
  p?: DownloadProgress;
}) => {
  // 'done' arrives a moment before the refreshed row says installed: stay on 正在安装…
  const settling = p?.state === "done" && g.state !== "installed";
  const live = downloading(p) || settling;
  const state = live ? "downloading" : g.state;
  const pct = live ? (p && p.total ? Math.min(100, Math.floor(((p.received ?? 0) / p.total) * 100)) : 0) : (g.percent ?? 0);
  const installing = live ? p?.state === "installing" || settling : !!g.installing;
  const playable = state === "installed" || state === "update";
  const tag = STATE_TAG[state];
  const version =
    g.installedVersion && g.installedVersion !== g.version ? `v${g.installedVersion} → v${g.version}` : `v${g.version}`;
  return (
    <article className={storeStyles.card} data-game-state={state} data-store-game={g.id}>
      <div className={styles.art}>
        {g.pictureSrc ? (
          <img alt={g.name} src={g.pictureSrc} />
        ) : (
          <div className={styles.noArt}>
            <Gamepad2 size={40} />
          </div>
        )}
        <span className={styles.ribbon}>
          <Tag color={tag.color} data-game-tag={g.id}>
            {tag.text}
          </Tag>
        </span>
      </div>
      <Flexbox flex={1} gap={8} padding={12}>
        <Flexbox gap={2}>
          <Text ellipsis strong>
            {g.name}
          </Text>
          <Text data-store-game-meta={g.id} fontSize={12} type="secondary">
            {[g.sizeLabel, version, last && "上次玩的"].filter(Boolean).join(" · ")}
          </Text>
        </Flexbox>
        <Text data-store-game-desc={g.id} fontSize={13}>
          {g.description}
        </Text>
        {g.features.length > 0 && (
          <Flexbox gap={6} horizontal wrap="wrap">
            {g.features.map((f) => (
              <Tag key={f}>{f}</Tag>
            ))}
          </Flexbox>
        )}
        {state === "update" && g.changelog && (
          <Flexbox data-game-changelog={g.id} gap={4}>
            <Text fontSize={12} strong>{`v${g.version} 更新了什么`}</Text>
            <Text className={styles.notes} fontSize={12}>
              {g.changelog}
            </Text>
          </Flexbox>
        )}
        {(state === "unsupported" || g.updateBlocked) && (
          <Text data-game-unsupported={g.id} fontSize={12} type="warning">
            {g.minAppVersion
              ? `v${g.version} 需要 Pixel Pet ${g.minAppVersion} 或更新的版本，请先更新应用。`
              : `v${g.version} 需要更新版本的应用才能玩，请先更新应用。`}
          </Text>
        )}
        <Text ellipsis fontSize={12} title={g.credit} type="secondary">
          {g.credit}
        </Text>
        {!live && g.error && (
          <Text data-game-download-error={g.id} fontSize={12} type="danger">
            {g.error}
          </Text>
        )}
        {state === "downloading" && (
          <Flexbox data-game-download-progress={g.id} gap={4}>
            <Progress percent={pct} showInfo={false} size="small" />
            <Text fontSize={12} type="secondary">
              {installing ? "正在安装…" : `已下载 ${pct}%`}
            </Text>
          </Flexbox>
        )}
        <Flexbox align="center" gap={8} horizontal justify="space-between" style={{ marginBlockStart: "auto" }}>
          <Button
            data-game-repo={g.id}
            icon={Github}
            onClick={() => api().openLink(g.repo)}
            size="small"
            title={g.repo}
            type="text"
          >
            开源仓库
          </Button>
          <Flexbox gap={8} horizontal>
            {playable && (
              <Button data-game-remove={g.id} icon={Trash2} onClick={onRemove} size="small">
                删除
              </Button>
            )}
            {state === "update" && (
              <Button data-game-update={g.id} icon={RefreshCw} onClick={onDownload} size="small">
                {`更新到 v${g.version}`}
              </Button>
            )}
            {playable ? (
              <Button data-game-play={g.id} icon={Gamepad2} onClick={onPlay} size="small" type="primary">
                开始玩
              </Button>
            ) : state === "downloading" ? (
              <Button
                data-game-download-cancel={g.id}
                disabled={installing}
                onClick={() => api().gameDownloadCancel(g.id)}
                size="small"
              >
                取消
              </Button>
            ) : (
              <Button
                data-game-download={g.id}
                disabled={state === "unsupported"}
                icon={Download}
                onClick={onDownload}
                size="small"
                type="primary"
              >
                下载
              </Button>
            )}
          </Flexbox>
        </Flexbox>
      </Flexbox>
    </article>
  );
};

const checkedLabel = (t: number | null) => {
  if (!t) return "还没检查过新版本";
  const d = new Date(t);
  return `上次检查新版本：${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const GamesShelf = () => {
  const [st, setSt] = useState<GameStoreState | null>(null);
  const [map, setMap] = useState<Record<string, DownloadProgress>>({});
  const [checking, setChecking] = useState(false);
  const load = useCallback(async (refresh = false) => {
    const r = await api().gameStore({ refresh });
    setSt(r);
    return r;
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => api().onGameUpdates(() => load()), [load]);
  useEffect(
    () =>
      api().onCatalogProgress((p) => {
        setSt((s) => {
          if (s && s.games.some((g) => g.id === p.id)) {
            setMap((m) => ({ ...m, [p.id]: p }));
            if (p.state === "done" || p.state === "failed") setTimeout(() => load(), 0);
          }
          return s;
        });
      }),
    [load],
  );
  const check = async () => {
    setChecking(true);
    const r = await load(true);
    setChecking(false);
    const ups = r.games.filter((g) => g.state === "update");
    if (r.checkError) toast.error({ description: "请检查网络后再试。", title: "没能检查新版本" });
    else if (ups.length) toast.info(`有 ${ups.length} 个小游戏可以更新`);
    else toast.success("都是最新版本");
  };
  const start = async (g: StoreGameRow) => {
    const updating = g.state === "update";
    setMap((m) => ({ ...m, [g.id]: { id: g.id, received: 0, state: "downloading", total: g.bytes } }));
    const r = await api().gameDownload(g.id);
    if (r.store) setSt(r.store);
    if (r.ok && updating) toast.success({ description: "进度（今日小事、菜地、收集到的东西）都保留着。", title: `「${g.name}」已更新到 v${g.version}` });
    else if (r.ok) toast.success({ description: "点「开始玩」，她就会进到游戏里；托盘「小游戏」和她面板上的 ⌂ 也能打开。", title: `「${g.name}」下载好了` });
    else if (r.reason !== "canceled") toast.error({ description: r.text, title: updating ? `没能更新「${g.name}」` : `没能下载「${g.name}」` });
  };
  const play = async (g: StoreGameRow) => {
    const r = await api().gamePlay(g.id);
    if (!r || !r.ok) toast.error({ description: r?.reason === "no-pet" ? "先在桌面上领养一位角色。" : "请稍后再试。", title: `没能打开「${g.name}」` });
    else setSt((s) => (s ? { ...s, last: g.id } : s));
  };
  const remove = async (g: StoreGameRow) => {
    const ok = await ask(`删除小游戏「${g.name}」？`, "游戏文件会被删掉，进度（今日小事、收集到的东西）会保留；之后可以在商店重新下载。", "删除小游戏", true);
    if (!ok) return;
    const r = await api().gameRemove(g.id);
    if (r.store) setSt(r.store);
    setMap((m) => {
      const { [g.id]: _gone, ...rest } = m;
      return rest;
    });
    if (r.ok) toast.success(`已删除小游戏「${g.name}」`);
    else toast.error({ description: r.text, title: `没能删除「${g.name}」` });
  };
  if (!st) return null;
  if (!st.games.length) return <Alert description="目前没有可以下载的小游戏。" title="商店里还没有小游戏" type="info" />;
  return (
    <Flexbox gap={16}>
      <Flexbox align="center" gap={12} horizontal justify="space-between" wrap="wrap">
        <Text fontSize={12} style={{ flex: 1, minWidth: 280 }} type="secondary">
          小游戏是一个个可以下载的场景，她会在里面自己走动、做事，你可以调时段和天气，陪她完成每天的小事（完成会加好感）。游戏只有图片和配置，由应用自带的引擎来玩；源码都在开源仓库里，有新版本时这里会提示更新。
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
          <GameCard
            g={g}
            key={g.id}
            last={st.last === g.id}
            onDownload={() => start(g)}
            onPlay={() => play(g)}
            onRemove={() => remove(g)}
            p={map[g.id]}
          />
        ))}
      </div>
    </Flexbox>
  );
};
