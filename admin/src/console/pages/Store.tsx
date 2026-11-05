/**
 * 商店 (docs/characters.md 「内置与下载」, docs/vrm-dance.md §11): what can be downloaded. One tab per kind of
 * thing — 角色 (pixel / Live2D / VRM characters), 舞蹈 and 语音包. Downloaded characters stay listed here as 已下载
 * (→ her page) and show up in 角色图鉴; downloaded dances go into 舞蹈 (玩法 → 舞蹈) and can be danced from here;
 * downloaded 语音包 (core/voice-store.js, docs/voice-packs.md §7) go into userData/voicepacks/ and are listed in
 * 设置 → 语音包, where they can be picked.
 */
import { Alert, Button, Flexbox, Progress, Segmented, Tag, Text, toast } from "@lobehub/ui";
import { PageHeader, PageTabs } from "@lobehub/ui/dashboard";
import { Download, Music, Play, Square, Trash2, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type DownloadProgress, type StoreDanceRow, type StoreVoiceRow } from "../api";
import { ask } from "../fields";
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

const GENDER_NAME: Record<string, string> = { female: "女声", male: "男声" };

/**
 * One 风格语音包 in 商店 → 语音包: name, 风格, 音色说明 (description + engine voice), size, lines, 署名, 试听; and its
 * state — 未下载 (下载) / 下载中 (progress, 取消) / 已下载 (删除). The state is main's (core/voice-store.js
 * deriveState, 已下载 read from disk), overlaid with the live `catalog-progress` while a download runs.
 */
const VoiceCard = ({
  v,
  p,
  playing,
  onDownload,
  onPlay,
  onRemove,
}: {
  onDownload: () => void;
  onPlay: () => void;
  onRemove: () => void;
  p?: DownloadProgress;
  playing: boolean;
  v: StoreVoiceRow;
}) => {
  // 'done' arrives a moment before the refreshed row says installed: stay on 正在安装… instead of flashing 未下载
  const settling = p?.state === "done" && v.state !== "installed";
  const live = downloading(p) || settling;
  const state = live ? "downloading" : v.state;
  const pct = live
    ? p && p.total
      ? Math.min(100, Math.floor(((p.received ?? 0) / p.total) * 100))
      : 0
    : (v.percent ?? 0);
  const installing = live ? p?.state === "installing" || settling : !!v.installing;
  return (
    <article className={storeStyles.card} data-store-voice={v.id} data-voice-state={state}>
      <Flexbox flex={1} gap={8} padding={12}>
        <Flexbox align="flex-start" gap={8} horizontal justify="space-between">
          <Flexbox gap={2} style={{ minWidth: 0 }}>
            <Text ellipsis strong>
              {v.name}
            </Text>
            <Text data-store-voice-meta={v.id} fontSize={12} type="secondary">
              {[`${v.lines} 句`, v.sizeLabel, v.version && `v${v.version}`].filter(Boolean).join(" · ")}
            </Text>
          </Flexbox>
          {state === "installed" ? (
            <Tag color="success" data-voice-downloaded={v.id}>
              已下载
            </Tag>
          ) : state === "downloading" ? (
            <Tag color="processing" data-voice-downloading={v.id}>
              下载中
            </Tag>
          ) : (
            <Tag data-voice-not-downloaded={v.id}>未下载</Tag>
          )}
        </Flexbox>
        <Flexbox align="center" gap={6} horizontal wrap="wrap">
          <Tag color="purple" data-store-voice-style={v.id}>
            {v.styleLabel}
          </Tag>
          {v.gender && <Tag>{GENDER_NAME[v.gender] ?? v.gender}</Tag>}
        </Flexbox>
        <Text data-store-voice-desc={v.id} fontSize={13}>
          {v.description}
        </Text>
        <Text data-store-voice-timbre={v.id} fontSize={12} type="secondary">
          {`音色：${v.engine === "minimax" ? "MiniMax" : v.engine} ${v.voiceId}`}
        </Text>
        <Text data-store-voice-credit={v.id} ellipsis fontSize={12} title={v.credit} type="secondary">
          {v.credit || "署名见语音包说明"}
        </Text>
        {!live && state === "remote" && p?.state === "failed" && p.reason !== "canceled" && (
          <Text data-voice-download-error={v.id} fontSize={12} type="danger">
            {p.text ?? "下载失败，请重试"}
          </Text>
        )}
        {state === "downloading" && (
          <Flexbox data-voice-download-progress={v.id} gap={4}>
            <Progress percent={pct} showInfo={false} size="small" />
            <Text fontSize={12} type="secondary">
              {installing ? "正在安装…" : `已下载 ${pct}%`}
            </Text>
          </Flexbox>
        )}
        <Flexbox
          align="center"
          gap={8}
          horizontal
          justify="space-between"
          style={{ marginBlockStart: "auto" }}
        >
          <Button
            data-voice-sample={v.id}
            icon={playing ? Square : Volume2}
            onClick={onPlay}
            size="small"
            title={`试听：${v.sample.text}`}
          >
            {playing ? "停止" : "试听"}
          </Button>
          {state === "installed" ? (
            <Button data-voice-remove={v.id} icon={Trash2} onClick={onRemove} size="small">
              删除
            </Button>
          ) : state === "downloading" ? (
            <Button
              data-voice-download-cancel={v.id}
              disabled={installing}
              onClick={() => api().voiceDownloadCancel(v.id)}
              size="small"
            >
              取消
            </Button>
          ) : (
            <Button data-voice-download={v.id} icon={Download} onClick={onDownload} size="small">
              下载
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    </article>
  );
};

const VoicesShelf = () => {
  const { merge } = useStore();
  const [rows, setRows] = useState<StoreVoiceRow[] | null>(null);
  const [map, setMap] = useState<Record<string, DownloadProgress>>({});
  const [show, setShow] = useState<"all" | "remote" | "installed">("all");
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const load = useCallback(async () => {
    const r = await api().voiceStore();
    setRows(r.voicePacks);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      api().onCatalogProgress((p) => {
        if (!p.id.startsWith("style-")) return;
        setMap((m) => ({ ...m, [p.id]: p }));
        if (p.state === "done" || p.state === "failed") load();
      }),
    [load],
  );
  useEffect(() => () => audio.current?.pause(), []);
  const play = (v: StoreVoiceRow) => {
    audio.current?.pause();
    if (playing === v.id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(`../renderer/${v.sample.file}`);
    audio.current = a;
    a.onended = () => setPlaying((x) => (x === v.id ? null : x));
    a.play().then(
      () => setPlaying(v.id),
      () => {
        setPlaying(null);
        toast.error({ description: "试听文件读不出来，请重新安装应用后再试。", title: "没能试听" });
      },
    );
  };
  const done = (r: Awaited<ReturnType<ReturnType<typeof api>["voiceDownload"]>>) => {
    if (r.store) setRows(r.store.voicePacks);
    if (r.settings) merge({ settings: r.settings });
  };
  const start = async (v: StoreVoiceRow) => {
    setMap((m) => ({ ...m, [v.id]: { id: v.id, received: 0, state: "downloading", total: v.bytes } }));
    const r = await api().voiceDownload(v.id);
    done(r);
    if (r.ok) toast.success({ description: "在 设置 → 语音包 里可以选用它。", title: `「${v.name}」下载好了` });
    else if (r.reason !== "canceled") toast.error({ description: r.text, title: `没能下载「${v.name}」` });
  };
  const remove = async (v: StoreVoiceRow) => {
    const ok = await ask(
      `删除语音包「${v.name}」？`,
      "删除后用到它的角色会自动改回默认语音包；之后可以在商店重新下载。",
      "删除语音包",
      true,
    );
    if (!ok) return;
    const r = await api().voiceRemove(v.id);
    done(r);
    setMap((m) => {
      const { [v.id]: _gone, ...rest } = m;
      return rest;
    });
    if (r.ok) toast.success(`已删除语音包「${v.name}」`);
    else toast.error({ description: r.text, title: `没能删除「${v.name}」` });
  };
  if (!rows) return null;
  if (!rows.length)
    return <Alert description="目前没有可以下载的语音包。" title="商店里还没有语音包" type="info" />;
  const isInstalled = (v: StoreVoiceRow) => v.state === "installed" && !downloading(map[v.id]);
  const installed = rows.filter(isInstalled).length;
  const items = rows.filter(
    (v) => show === "all" || (show === "installed" ? isInstalled(v) : !isInstalled(v)),
  );
  return (
    <Flexbox gap={16}>
      <div data-store-voice-filter>
        <Segmented
          onChange={(x) => setShow(x as typeof show)}
          options={[
            { label: `全部 ${rows.length}`, value: "all" },
            { label: `未下载 ${rows.length - installed}`, value: "remote" },
            { label: `已下载 ${installed}`, value: "installed" },
          ]}
          size="small"
          value={show}
        />
      </div>
      <Text fontSize={12} type="secondary">
        风格语音包是提前录好的通用台词，任何角色都能用。试听不用下载；下载好的语音包会出现在 设置 → 语音包，在那里或角色的语音页选用。
      </Text>
      {items.length ? (
        <div className={storeStyles.grid} data-store-voices>
          {items.map((v) => (
            <VoiceCard
              key={v.id}
              onDownload={() => start(v)}
              onPlay={() => play(v)}
              onRemove={() => remove(v)}
              p={map[v.id]}
              playing={playing === v.id}
              v={v}
            />
          ))}
        </div>
      ) : (
        <Text data-store-voice-empty type="secondary">
          {show === "installed" ? "还没有下载语音包。" : "全部语音包都下载好了。"}
        </Text>
      )}
    </Flexbox>
  );
};

type Shelf = "characters" | "dances" | "voices";

const SHELVES: Shelf[] = ["characters", "dances", "voices"];

/** `initial`: the shelf a link opens (`#/store/voices`, e.g. from a character's 语音包 picker). */
export const StorePage = ({ initial }: { initial?: string }) => {
  // one tab per kind of thing on sale
  const [tab, setTab] = useState<Shelf>(SHELVES.includes(initial as Shelf) ? (initial as Shelf) : "characters");
  return (
    <>
      <PageHeader
        description="下载更多内容。下载好的角色会出现在角色图鉴里，舞蹈会出现在 玩法 → 舞蹈，语音包会出现在 设置 → 语音包；不需要了可以在她的页面、舞蹈页或这里删除。"
        title="商店"
      />
      <PageTabs
        label="商店分类"
        onChange={setTab}
        tabs={[
          { content: <CharactersShelf />, label: "角色", value: "characters" },
          { content: <DancesShelf />, label: "舞蹈", value: "dances" },
          { content: <VoicesShelf />, label: "语音包", value: "voices" },
        ]}
        value={tab}
      />
    </>
  );
};
