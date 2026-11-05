/**
 * 商店 → 小游戏 (docs/mini-games.md §7): the store's game packs (core/catalog.js listGames + core/game-store.js
 * storeRows). A game is data only — pictures and a manifest — played by the app's own engine in the game window;
 * 下载 puts it in userData/games/<id>/, 开始玩 opens the game window with her in it (her desktop window hides),
 * 删除 takes it away again. Progress arrives as `catalog-progress`.
 */
import { Alert, Button, createStaticStyles, cssVar, Flexbox, Progress, Tag, Text, toast } from "@lobehub/ui";
import { Download, Gamepad2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, type DownloadProgress, type StoreGameRow } from "../api";
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
}));

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
  return (
    <article className={storeStyles.card} data-game-state={state} data-store-game={g.id}>
      <div className={styles.art}>
        {g.picture ? (
          <img alt={g.name} src={`../renderer/${g.picture}`} />
        ) : (
          <div className={styles.noArt}>
            <Gamepad2 size={40} />
          </div>
        )}
        <span className={styles.ribbon}>
          {state === "installed" ? (
            <Tag color="success" data-game-downloaded={g.id}>
              已下载
            </Tag>
          ) : state === "downloading" ? (
            <Tag color="processing" data-game-downloading={g.id}>
              下载中
            </Tag>
          ) : (
            <Tag data-game-not-downloaded={g.id}>未下载</Tag>
          )}
        </span>
      </div>
      <Flexbox flex={1} gap={8} padding={12}>
        <Flexbox gap={2}>
          <Text ellipsis strong>
            {g.name}
          </Text>
          <Text data-store-game-meta={g.id} fontSize={12} type="secondary">
            {[g.sizeLabel, g.version && `v${g.version}`, last && "上次玩的"].filter(Boolean).join(" · ")}
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
        <Text ellipsis fontSize={12} title={g.credit} type="secondary">
          {g.credit}
        </Text>
        {!live && state === "remote" && g.error && (
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
        <Flexbox align="center" gap={8} horizontal justify="flex-end" style={{ marginBlockStart: "auto" }}>
          {state === "installed" ? (
            <>
              <Button data-game-remove={g.id} icon={Trash2} onClick={onRemove} size="small">
                删除
              </Button>
              <Button data-game-play={g.id} icon={Gamepad2} onClick={onPlay} size="small" type="primary">
                开始玩
              </Button>
            </>
          ) : state === "downloading" ? (
            <Button data-game-download-cancel={g.id} disabled={installing} onClick={() => api().gameDownloadCancel(g.id)} size="small">
              取消
            </Button>
          ) : (
            <Button data-game-download={g.id} icon={Download} onClick={onDownload} size="small" type="primary">
              下载
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    </article>
  );
};

export const GamesShelf = () => {
  const [rows, setRows] = useState<StoreGameRow[] | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [map, setMap] = useState<Record<string, DownloadProgress>>({});
  const load = useCallback(async () => {
    const r = await api().gameStore();
    setRows(r.games);
    setLast(r.last);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      api().onCatalogProgress((p) => {
        setRows((rs) => {
          if (rs && rs.some((g) => g.id === p.id)) {
            setMap((m) => ({ ...m, [p.id]: p }));
            if (p.state === "done" || p.state === "failed") setTimeout(load, 0);
          }
          return rs;
        });
      }),
    [load],
  );
  const start = async (g: StoreGameRow) => {
    setMap((m) => ({ ...m, [g.id]: { id: g.id, received: 0, state: "downloading", total: g.bytes } }));
    const r = await api().gameDownload(g.id);
    if (r.store) setRows(r.store.games);
    if (r.ok) toast.success({ description: "点「开始玩」，她就会进到游戏里；托盘「小游戏」和她面板上的 ⌂ 也能打开。", title: `「${g.name}」下载好了` });
    else if (r.reason !== "canceled") toast.error({ description: r.text, title: `没能下载「${g.name}」` });
  };
  const play = async (g: StoreGameRow) => {
    const r = await api().gamePlay(g.id);
    if (!r || !r.ok) toast.error({ description: r?.reason === "no-pet" ? "先在桌面上领养一位角色。" : "请稍后再试。", title: `没能打开「${g.name}」` });
    else setLast(g.id);
  };
  const remove = async (g: StoreGameRow) => {
    const ok = await ask(`删除小游戏「${g.name}」？`, "游戏文件会被删掉，进度（今日小事、收集到的东西）会保留；之后可以在商店重新下载。", "删除小游戏", true);
    if (!ok) return;
    const r = await api().gameRemove(g.id);
    if (r.store) setRows(r.store.games);
    setMap((m) => {
      const { [g.id]: _gone, ...rest } = m;
      return rest;
    });
    if (r.ok) toast.success(`已删除小游戏「${g.name}」`);
    else toast.error({ description: r.text, title: `没能删除「${g.name}」` });
  };
  if (!rows) return null;
  if (!rows.length) return <Alert description="目前没有可以下载的小游戏。" title="商店里还没有小游戏" type="info" />;
  return (
    <Flexbox gap={16}>
      <Text fontSize={12} type="secondary">
        小游戏是一个个可以下载的场景，她会在里面自己走动、做事，你可以调时段和天气，陪她完成每天的小事（完成会加好感）。游戏只有图片和配置，由应用自带的引擎来玩。
      </Text>
      <div className={styles.grid} data-store-games>
        {rows.map((g) => (
          <GameCard
            g={g}
            key={g.id}
            last={last === g.id}
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
