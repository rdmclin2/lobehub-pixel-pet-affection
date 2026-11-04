/**
 * 音乐创作 (T-5090): a song compose_music saved, under her reply in 聊天 — play it here, open it with the system
 * player, show it in its folder, copy its path. The bytes come from main (`chat.musicAudio`, only files inside the
 * music folder) and play from a blob: URL (CSP media-src blob:).
 */
import {
  ActionIcon,
  Block,
  Button,
  CopyButton,
  createStaticStyles,
  cssVar,
  Flexbox,
  Progress,
  Tag,
  Text,
  toast,
} from "@lobehub/ui";
import {
  FolderOpen,
  Music,
  Pause,
  Play,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type ChatMusic } from "../api";

const styles = createStaticStyles(({ css }) => ({
  card: css`
    width: min(420px, 100%);
    padding-block: 12px;
    padding-inline: 12px;
  `,
  icon: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 40px;
    height: 40px;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};
  `,
  path: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-family: ${cssVar.fontFamilyCode};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

const REASONS: Record<string, string> = {
  forbidden: "这个文件不在音乐保存目录里，不能播放",
  invalid: "文件不对，可能被改过",
  missing: "文件找不到了：可能被移动或删除了",
  unplayable: "pcm 是裸音频，这里放不了，用「用系统播放器打开」",
};

export const clockOf = (ms: number | null | undefined) => {
  if (!ms || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const MusicCard = ({ music }: { music: ChatMusic }) => {
  const chat = api().chat;
  const audio = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState(
    music.durationMs ? music.durationMs / 1000 : 0,
  );
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const fail = (reason: string, message?: string) => {
    const text = message || REASONS[reason] || "播放失败";
    setProblem(text);
    toast.error(text);
  };

  const toggle = async () => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    let src = url;
    if (!src) {
      setLoading(true);
      try {
        const r = await chat.musicAudio(music.filePath);
        if (!r.ok) return fail(r.reason, r.message);
        src = URL.createObjectURL(
          new Blob([r.data as BlobPart], { type: r.mime }),
        );
        setUrl(src);
        el.src = src;
      } finally {
        setLoading(false);
      }
    }
    setProblem(null);
    el.play().catch(() => fail("invalid", "这首歌放不出来：文件可能损坏了"));
  };

  const open = async (reveal: boolean) => {
    const r = await (reveal
      ? chat.musicReveal(music.filePath)
      : chat.musicOpen(music.filePath));
    if (!r.ok) fail(r.reason, r.message);
  };

  const title = music.title || "新曲子";
  const total = clockOf(len * 1000);
  return (
    <Block
      className={styles.card}
      data-music-card={music.id}
      data-music-state={playing ? "playing" : "idle"}
      variant="outlined"
    >
      <Flexbox gap={8}>
        <Flexbox align="center" gap={12} horizontal>
          <span aria-hidden className={styles.icon}>
            <Music size={20} />
          </span>
          <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
            <Flexbox align="center" gap={8} horizontal>
              <Text ellipsis strong>
                {title}
              </Text>
              {music.instrumental && <Tag size="small">纯音乐</Tag>}
            </Flexbox>
            <Text fontSize={12} type="secondary">
              {[
                playing || pos
                  ? `${clockOf(pos * 1000) || "0:00"} / ${total || "--:--"}`
                  : total,
                music.format.toUpperCase(),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Flexbox>
          <ActionIcon
            aria-label={playing ? `暂停《${title}》` : `播放《${title}》`}
            data-music-play
            icon={playing ? Pause : Play}
            loading={loading}
            onClick={toggle}
            size="large"
            title={playing ? "暂停" : "播放"}
            variant="filled"
          />
        </Flexbox>
        <Progress
          percent={len ? Math.min(100, (pos / len) * 100) : 0}
          showInfo={false}
          size="small"
        />
        <Flexbox align="center" gap={4} horizontal wrap="wrap">
          <Button
            data-music-open
            icon={SquareArrowOutUpRight}
            onClick={() => open(false)}
            size="small"
            type="text"
          >
            用系统播放器打开
          </Button>
          <Button
            data-music-reveal
            icon={FolderOpen}
            onClick={() => open(true)}
            size="small"
            type="text"
          >
            在文件夹中显示
          </Button>
        </Flexbox>
        <Flexbox align="center" gap={4} horizontal>
          <Text
            className={styles.path}
            data-music-path
            fontSize={12}
            title={music.filePath}
            type="secondary"
          >
            {music.filePath}
          </Text>
          <CopyButton content={music.filePath} size="small" title="复制路径" />
        </Flexbox>
        {problem && (
          <Text data-music-problem fontSize={12} type="danger">
            {problem}
          </Text>
        )}
      </Flexbox>
      <audio
        onEnded={() => {
          setPlaying(false);
          setPos(0);
        }}
        onLoadedMetadata={(e) =>
          Number.isFinite(e.currentTarget.duration) &&
          setLen(e.currentTarget.duration)
        }
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        preload="none"
        ref={audio}
      />
    </Block>
  );
};
