/**
 * 商店 (docs/characters.md 「内置与下载」, docs/vrm-dance.md §11): what can be downloaded. One tab per kind of
 * thing — 角色 (pixel / Live2D / VRM characters) and 舞蹈. Downloaded characters stay listed here as 已下载
 * (→ her page) and show up in 角色图鉴; downloaded dances go into 舞蹈 (玩法 → 舞蹈) and can be danced from here.
 */
import { Alert, Button, Flexbox, Progress, Segmented, Tag, Text, toast } from "@lobehub/ui";
import { PageHeader, PageTabs } from "@lobehub/ui/dashboard";
import { Download, Music, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, type DownloadProgress, type StoreDanceRow } from "../api";
import { useStore } from "../store";
import { SpriteStage } from "../stage/SpriteStage";
import { CatalogGrid, downloading, KIND_NAME, storeStyles } from "./Characters";
import { clock } from "./Dances";

const CharactersShelf = () => {
  const { catalog: cat, view } = useStore();
  const catalog = cat ?? [];
  const [show, setShow] = useState<"all" | "remote" | "installed">("all");
  const [kind, setKind] = useState("all");
  const remote = catalog.filter((d) => !d.installed).length;
  const kinds = [...new Set(catalog.map((d) => d.kind))];
  const items = catalog.filter(
    (d) =>
      (show === "all" || (show === "installed" ? d.installed : !d.installed)) &&
      (kind === "all" || d.kind === kind),
  );
  if (!catalog.length)
    return (
      <Alert
        description="目前没有可以下载的角色。"
        title="商店里还没有角色"
        type="info"
      />
    );
  return (
    <Flexbox gap={16}>
      <Flexbox
        align="center"
        gap={8}
        horizontal
        justify="space-between"
        wrap="wrap"
      >
        <div data-store-filter>
          <Segmented
            onChange={(v) => setShow(v as typeof show)}
            options={[
              { label: `全部 ${catalog.length}`, value: "all" },
              { label: `未下载 ${remote}`, value: "remote" },
              {
                label: `已下载 ${catalog.length - remote}`,
                value: "installed",
              },
            ]}
            size="small"
            value={show}
          />
        </div>
        <div data-store-kind>
          <Segmented
            onChange={(v) => setKind(String(v))}
            options={[
              { label: "全部类型", value: "all" },
              ...kinds.map((k) => ({
                label: `${KIND_NAME[k] ?? k} ${catalog.filter((d) => d.kind === k).length}`,
                value: k,
              })),
            ]}
            size="small"
            value={kind}
          />
        </div>
      </Flexbox>
      {!view && (
        <Alert
          description="先在桌宠窗口里选一位角色并完成唤醒；下载的角色会出现在角色图鉴里，在那里结识和切换。"
          showIcon
          title="还没有唤醒桌宠"
          type="info"
        />
      )}
      <CatalogGrid items={items} />
    </Flexbox>
  );
};

/** One dance in 商店 → 舞蹈: cover, name, credit, length, 有音乐; 下载 / progress / 取消, or 已下载 → 让她跳. */
const DanceCard = ({
  d,
  p,
  vrm,
  onDownload,
}: {
  d: StoreDanceRow;
  onDownload: () => void;
  p?: DownloadProgress;
  vrm: boolean;
}) => {
  const busy = downloading(p);
  const pct =
    p && p.total
      ? Math.min(100, Math.round(((p.received ?? 0) / p.total) * 100))
      : 0;
  const play = async () => {
    const r = await api().dancePlay(d.id);
    if (r && r.ok) toast.success(`她开始跳《${d.name}》了`);
    else toast.error({ description: r?.message, title: "她现在跳不了" });
  };
  return (
    <article className={storeStyles.card} data-store-dance={d.id}>
      <div className={storeStyles.art}>
        <SpriteStage
          animate={false}
          height={184}
          name={d.name}
          preview={
            d.picture
              ? { pixelated: false, type: "image", url: `../renderer/${d.picture}` }
              : null
          }
        />
        <span className={storeStyles.ribbon}>
          {d.installed ? (
            <Tag color="success" data-dance-downloaded={d.id}>
              已下载
            </Tag>
          ) : (
            <Tag data-dance-not-downloaded={d.id}>未下载</Tag>
          )}
        </span>
      </div>
      <Flexbox flex={1} gap={8} padding={12}>
        <Flexbox gap={2}>
          <Text ellipsis strong>
            {d.name}
          </Text>
          <Text ellipsis fontSize={12} type="secondary">
            {d.credit || "动作作者见舞蹈说明"}
          </Text>
        </Flexbox>
        <Flexbox align="center" gap={6} horizontal wrap="wrap">
          <Text data-store-dance-meta={d.id} fontSize={12} type="secondary">
            {[clock(d.duration), d.sizeLabel].join(" · ")}
          </Text>
          {d.music ? (
            <Tag icon={<Music size={12} />}>有音乐</Tag>
          ) : (
            <Tag>无音乐</Tag>
          )}
        </Flexbox>
        {busy && (
          <Flexbox data-dance-download-progress={d.id} gap={4}>
            <Progress percent={pct} showInfo={false} size="small" />
            <Text fontSize={12} type="secondary">
              {p?.state === "installing" ? "正在安装…" : `已下载 ${pct}%`}
            </Text>
          </Flexbox>
        )}
        <Flexbox
          align="center"
          gap={8}
          horizontal
          justify="flex-end"
          style={{ marginBlockStart: "auto" }}
        >
          {d.installed ? (
            <Button
              data-store-dance-play={d.id}
              disabled={!vrm}
              icon={Play}
              onClick={play}
              size="small"
              title={vrm ? undefined : "换成 VRM 角色后可以跳"}
            >
              让她跳
            </Button>
          ) : busy ? (
            <Button
              data-dance-download-cancel={d.id}
              disabled={p?.state === "installing"}
              onClick={() => api().danceDownloadCancel(d.id)}
              size="small"
            >
              取消
            </Button>
          ) : (
            <Button
              data-dance-download={d.id}
              icon={Download}
              onClick={onDownload}
              size="small"
            >
              下载
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    </article>
  );
};

const DancesShelf = () => {
  const [state, setState] = useState<{
    dances: StoreDanceRow[];
    vrm: boolean;
  } | null>(null);
  const [map, setMap] = useState<Record<string, DownloadProgress>>({});
  const [show, setShow] = useState<"all" | "remote" | "installed">("all");
  const load = useCallback(async () => {
    const r = await api().danceStore();
    setState({ dances: r.dances, vrm: r.vrm });
    setMap((m) => ({
      ...Object.fromEntries(r.downloads.map((x) => [x.id, x])),
      ...m,
    }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      api().onCatalogProgress((p) => {
        if (!p.id.startsWith("dance-")) return;
        setMap((m) => ({ ...m, [p.id]: p }));
        if (p.state === "done") load();
      }),
    [load],
  );
  const start = async (d: StoreDanceRow) => {
    setMap((m) => ({ ...m, [d.id]: { id: d.id, received: 0, state: "downloading" } }));
    const r = await api().danceDownload(d.id);
    if (r && r.ok) toast.success(`《${d.name}》下载好了，可以让她跳`);
    else if (r && r.reason !== "canceled")
      toast.error({ description: r.text, title: `没能下载《${d.name}》` });
    load();
  };
  if (!state) return null;
  const dances = state.dances;
  if (!dances.length)
    return (
      <Alert description="目前没有可以下载的舞蹈。" title="商店里还没有舞蹈" type="info" />
    );
  const remote = dances.filter((d) => !d.installed).length;
  const items = dances.filter(
    (d) => show === "all" || (show === "installed" ? d.installed : !d.installed),
  );
  return (
    <Flexbox gap={16}>
      <div data-store-dance-filter>
        <Segmented
          onChange={(v) => setShow(v as typeof show)}
          options={[
            { label: `全部 ${dances.length}`, value: "all" },
            { label: `未下载 ${remote}`, value: "remote" },
            { label: `已下载 ${dances.length - remote}`, value: "installed" },
          ]}
          size="small"
          value={show}
        />
      </div>
      {!state.vrm && (
        <Alert
          description="舞蹈可以先下载好；只有 VRM 角色可以跳，换成 VRM 角色后在这里或桌宠工具栏的 ♪ 让她跳。"
          showIcon
          title="她现在不是 VRM 角色"
          type="info"
        />
      )}
      <Text fontSize={12} type="secondary">
        舞蹈动作和音乐来自 MMD 社区作者与原曲版权方，使用前请阅读每支舞附带的说明（下载后在 玩法 → 舞蹈 查看）。
      </Text>
      <div className={storeStyles.grid} data-store-dances>
        {items.map((d) => (
          <DanceCard
            d={d}
            key={d.id}
            onDownload={() => start(d)}
            p={map[d.id]}
            vrm={state.vrm}
          />
        ))}
      </div>
    </Flexbox>
  );
};

type Shelf = "characters" | "dances";

export const StorePage = () => {
  // one tab per kind of thing on sale; add 声音包 etc. here
  const [tab, setTab] = useState<Shelf>("characters");
  return (
    <>
      <PageHeader
        description="下载更多内容。下载好的角色会出现在角色图鉴里，舞蹈会出现在 玩法 → 舞蹈；不需要了可以在她的页面或舞蹈页删除。"
        title="商店"
      />
      <PageTabs
        label="商店分类"
        onChange={setTab}
        tabs={[
          { content: <CharactersShelf />, label: "角色", value: "characters" },
          { content: <DancesShelf />, label: "舞蹈", value: "dances" },
        ]}
        value={tab}
      />
    </>
  );
};
