/**
 * 聊天 (docs/admin-chat.md): talk with a character from the settings window, shaped like LobeHub's chat page —
 * characters on the left, her conversation in the middle, the input card at the bottom. One character is one
 * conversation: her own agent and topic, the same 聊天记录 as on the desktop, so there is no 新建 / 清空.
 * Everything lives in main (`petAdmin.chat`): this page keeps only what is on screen, and `#/chat/<id>` says
 * whose conversation is open, so a reload or a trip to another page reads it all back.
 */
import { ActionIcon, Alert, Button, createStaticStyles, cssVar, Empty, Flexbox, Icon, Image, PreviewGroup, Select, Spin, Tag, Text, toast, Tooltip } from '@lobehub/ui';
import { ChatInputActionBar, ChatInputAreaInner, ChatItem, ChatSendButton, LoadingDots } from '@lobehub/ui/chat';
import { ArrowDown, Eye, History, ImagePlus, MessagesSquare, Music, RotateCw, User, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import ChatLive from '../../../../src/core/chat-live.js';
import { api, reasonText, type ChatCharacter, type ChatDelta, type ChatMessage, type ChatMusicEvent, type ChatSticker, type RosterRow, type UserFace } from '../api';
import { clockOf, MusicCard } from './MusicCard';
import { CharacterAvatar, UserAvatar } from '../stage/CharacterAvatar';
import { useStore } from '../store';
import { StickerPicker } from './StickerPicker';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const PAGE = 40;
// The reply being written: still smoothed in (streamdown), but with the `realtime` preset (≈40 ms buffer, up to
// 180 字/s) instead of the default `balanced` (120 ms, 132 字/s), which fell ≈0.4 s behind LobeHub's ≈170 字/s
// on long replies (docs/admin-chat-latency.md R4). One object, so the live bubble's Markdown is not re-created per delta.
const STREAM_MARKDOWN = { animated: true, streamSmoothingPreset: 'realtime' } as const;

const styles = createStaticStyles(({ css }) => ({
  // a message that is only a 表情包 (docs/stickers-design.md §3.3): the picture fills its bubble (no text padding)
  stickerOnly: css`
    .lobe-chat-chat-item__message {
      overflow: hidden;
      padding: 0;
    }
  `,
  root: css`
    display: flex;
    flex: 1;
    min-height: 0;
    height: 100%;
  `,
  side: css`
    display: flex;
    flex: none;
    flex-direction: column;

    width: 264px;
    min-height: 0;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  sideList: css`
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding-block: 12px;
    padding-inline: 8px;
  `,
  session: css`
    cursor: pointer;

    display: flex;
    gap: 8px;
    align-items: center;

    width: 100%;
    padding-block: 8px;
    padding-inline: 12px;
    border: none;
    border-radius: ${cssVar.borderRadiusLG};

    color: ${cssVar.colorText};
    text-align: start;

    background: transparent;

    transition: background-color 150ms ease-out;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-current='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }

    &[data-met='false'] {
      color: ${cssVar.colorTextTertiary};
    }
  `,
  sessionText: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
  `,
  ellipsis: css`
    overflow: hidden;
    display: block;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  main: css`
    position: relative;

    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    min-height: 0;
  `,
  header: css`
    display: flex;
    flex: none;
    gap: 12px;
    align-items: center;

    height: 56px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  scroll: css`
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  `,
  messages: css`
    width: 100%;
    max-width: 880px;
    margin-inline: auto;
    padding-block: 16px 24px;
    padding-inline: 16px;
  `,
  toBottom: css`
    position: absolute;
    z-index: 2;
    inset-block-end: 196px;
    inset-inline-end: 24px;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 50%;

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  inputWrap: css`
    flex: none;
    width: 100%;
    max-width: 880px;
    margin-inline: auto;
    padding-block: 0 16px;
    padding-inline: 16px;
  `,
  inputCard: css`
    display: flex;
    flex-direction: column;
    gap: 4px;

    padding-block: 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
    box-shadow: ${cssVar.boxShadowTertiary};

    transition: border-color 150ms ease-out;

    &:focus-within {
      border-color: ${cssVar.colorBorder};
    }

    &[data-dragging='true'] {
      border-color: ${cssVar.colorPrimary};
      border-style: dashed;
    }

    & textarea {
      min-height: 48px;
      max-height: 240px;
    }
  `,
  thumbs: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-inline: 12px;
  `,
  thumb: css`
    position: relative;
  `,
  thumbRemove: css`
    position: absolute;
    z-index: 1;
    inset-block-start: -8px;
    inset-inline-end: -8px;

    border-radius: 50%;

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  sendBar: css`
    white-space: nowrap;
  `,
  avatar: css`
    overflow: hidden;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 40px;
    height: 40px;
    border-radius: 50%;

    background: ${cssVar.colorFillTertiary};
  `,
  earlier: css`
    display: flex;
    justify-content: center;
    padding-block: 4px 12px;
  `,
  modelOption: css`
    overflow: hidden;
    display: flex;
    gap: 8px;
    align-items: center;
  `,
}));

/** A picture waiting in the input card: from the file dialog (`path`) or pasted / dropped (`dataUrl` only). */
interface Pending {
  dataUrl: string;
  key: string;
  mime: string;
  name: string;
  path?: string;
  size: number;
}

/** The reply being written, put together from the deltas (increments, core/chat-live.js). */
interface Live {
  speciesId: string;
  text: string;
  turnId: string | null;
}

const chat = () => api().chat;

const clock = (t: number | null) => {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日`;
};

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const USER_AVATAR = { avatar: <Icon icon={User} size={20} />, backgroundColor: cssVar.colorFillSecondary, title: '你' };

const modelLabel = (row: RosterRow | undefined, key: string | null | undefined) => {
  if (!key) return '';
  const o = row?.model?.options.find((x) => x.key === key);
  return (o?.label as string | undefined) ?? key.split(':').pop() ?? key;
};

/** Her row in the roster for a conversation (her base): the look she is now, else her first one. */
const rowOf = (roster: RosterRow[], base: string | null): RosterRow | undefined =>
  base ? (roster.find((c) => c.base === base && c.current) ?? roster.find((c) => c.base === base)) : undefined;

const CharAvatar = ({ row, size = 40 }: { row: RosterRow | undefined; size?: number }) =>
  row ? <CharacterAvatar avatar={row.avatar} name={row.nameZh} preview={row.preview} silhouette={!row.met} size={size} /> : <span className={styles.avatar} style={{ height: size, width: size }} />;

/** A sticker in her conversation: the picture as is (no bubble), larger on click; its name when the file is gone. */
const StickerImage = ({ sticker, size }: { sticker: ChatSticker; size: number }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return <Tag data-sticker-missing>表情包已丢失：{sticker.label}</Tag>;
  return (
    <Image
      alt={sticker.label}
      data-chat-sticker={sticker.id ?? ''}
      height={size}
      objectFit="contain"
      onError={() => setFailed(true)}
      preview
      src={sticker.url}
      variant="borderless"
      width={size}
    />
  );
};

export const ChatPage = ({ id, navigate }: { id?: string; navigate: (p: string) => void }) => {
  const { roster, merge } = useStore();
  const [characters, setCharacters] = useState<ChatCharacter[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<Live | null>(null);
  // 音乐创作 (T-5090): this page's round is composing (compose_music running), or its last try failed
  const [composing, setComposing] = useState<ChatMusicEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // the owner's LobeHub avatar (T-2839), fetched by main once per visit; until then (and without one) the person icon
  const [me, setMe] = useState<UserFace | null>(null);
  useEffect(() => {
    let alive = true;
    const ask = api().userAvatar();
    ask.then((r) => alive && r && 'avatar' in r && setMe(r), () => {});
    return () => {
      alive = false;
    };
  }, []);
  const dropMe = useCallback(() => setMe(null), []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const liveRef = useRef<Live | null>(null);
  liveRef.current = live;

  // whose conversation: the one in the address, else the companion on the desktop. A conversation is her base's
  // (T-2764: 「大肥鱼 · 像素」 and 「大肥鱼 · Live2D」 share one agent and chat), so a character id in the address
  // (`#/chat/dafeiyu-live2d`) means her base's conversation
  const baseOf = (x: string | null | undefined) => (x ? (roster.find((c) => c.id === x)?.base ?? x) : null);
  const fallbackId = characters.find((c) => c.current)?.id ?? baseOf(roster.find((c) => c.current)?.id) ?? characters[0]?.id ?? null;
  const asked = baseOf(id);
  const activeId = asked && (characters.some((c) => c.id === asked) || roster.some((c) => c.base === asked)) ? asked : fallbackId;
  const activeRef = useRef<string | null>(activeId);
  activeRef.current = activeId;
  const row = rowOf(roster, activeId);
  const who = characters.find((c) => c.id === activeId);
  const met = !!row?.met;
  const name = who?.name ?? row?.nameZh ?? '';
  const m = row?.model ?? null;
  const currentModel = m?.options.find((o) => o.key === m.current) ?? null;
  const vision = currentModel ? currentModel.vision !== false : true;
  const busy = !!live;
  const liveHere = live && live.speciesId === activeId ? live : null;
  const composingHere = composing && liveHere && composing.speciesId === activeId ? composing : null;
  useEffect(() => chat().onMusic((e) => setComposing(e)), []);
  useEffect(() => {
    if (!live) setComposing(null);
  }, [live]);
  useEffect(() => {
    if (composing?.state !== 'composing') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [composing?.state]);

  const refreshCharacters = useCallback(async () => {
    const r = await chat().listCharacters();
    if (r.ok) setCharacters(r.characters);
    return r;
  }, []);

  /** The latest page of her conversation (at least as many as are on screen, so 查看更早 stays loaded). */
  const loadLatest = useCallback(async (sid: string, keep = 0) => {
    const r = await chat().history(sid, { limit: Math.max(PAGE, keep) });
    if (activeRef.current !== sid) return;
    setLoading(false);
    if (!r.ok) {
      setMessages([]);
      setHasMore(false);
      return;
    }
    setMessages(r.messages);
    setHasMore(r.hasMore);
    if (r.streaming) {
      const now = r.live;
      setLive((l) => (l && l.speciesId === sid && (!now || l.text.length >= now.text.length) ? l : { speciesId: sid, text: now?.text ?? '', turnId: now?.turnId ?? null }));
    }
  }, []);

  // first visit, a reload, another character or coming back from another page: read it all again from main
  useEffect(() => {
    refreshCharacters();
  }, [refreshCharacters]);
  useEffect(() => {
    if (!activeId) return;
    stick.current = true;
    setMessages([]);
    setHasMore(false);
    setLoading(true);
    setPending([]);
    loadLatest(activeId);
  }, [activeId, loadLatest]);

  const countRef = useRef(0);
  countRef.current = messages.length;
  useEffect(() => {
    // the deltas of one frame become one render (requestAnimationFrame); a piece that does not fit asks main for the text so far
    let queue: ChatDelta[] = [];
    let frame = 0;
    let resyncing = false;
    const resync = async (sid: string) => {
      if (resyncing) return;
      resyncing = true;
      try {
        const r = await chat().history(sid, { limit: 1 });
        const now = r.ok && r.streaming ? r.live : null;
        if (now) setLive((l) => (l && l.speciesId === sid && l.text.length > now.text.length && l.turnId === now.turnId ? l : { speciesId: sid, text: now.text, turnId: now.turnId }));
      } finally {
        resyncing = false;
      }
    };
    const flush = () => {
      frame = 0;
      const q = queue;
      queue = [];
      // no reply on the page (it ended: done, stopped or refused): a late piece must not bring the bubble back
      if (!q.length || !liveRef.current) return;
      const r = ChatLive.merge(liveRef.current, q);
      liveRef.current = r.live;
      setLive(r.live);
      if (r.resync) resync(q.at(-1)!.speciesId);
    };
    const offDelta = chat().onDelta((d) => {
      queue.push(d);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    const offDone = chat().onDone((d) => {
      if (activeRef.current === d.speciesId) setMessages((ms) => (ms.some((x) => x.id === d.message.id) ? ms : [...ms, d.message]));
      queue = queue.filter((x) => x.turnId !== d.turnId);
      if (liveRef.current?.speciesId === d.speciesId) liveRef.current = null;
      setLive((l) => (l && l.speciesId === d.speciesId ? null : l));
      refreshCharacters();
    });
    // her history moved: a round on the desktop, or this page's own round being saved
    const offChanged = chat().onChanged((d) => {
      refreshCharacters();
      const sid = activeRef.current;
      if (sid && (!d.speciesId || d.speciesId === sid) && !liveRef.current) loadLatest(sid, countRef.current);
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      offDelta();
      offDone();
      offChanged();
    };
  }, [loadLatest, refreshCharacters]);

  // stay at the bottom while she writes — unless you scrolled up to read
  // always instant: a smooth scroll would pass through "not at the bottom" and unstick itself mid-way
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [messages, liveHere?.text, activeId, loading, toBottom]);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => stick.current && toBottom());
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stick.current = near;
    setAtBottom(near);
  };

  /** 查看更早的消息: the page before the oldest one shown, keeping what you are looking at in place. */
  const loadEarlier = async () => {
    if (!activeId || !messages.length || loadingMore) return;
    const sid = activeId;
    const el = scrollRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    setLoadingMore(true);
    try {
      const r = await chat().history(sid, { before: messages[0].id, limit: PAGE });
      if (activeRef.current !== sid || !r.ok) return;
      stick.current = false;
      setMessages((ms) => [...r.messages.filter((x) => !ms.some((y) => y.id === x.id)), ...ms]);
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - fromBottom;
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const room = MAX_IMAGES - pending.length;
    if (room <= 0) return toast.warning(`一次最多发 ${MAX_IMAGES} 张图片`);
    const add: Pending[] = [];
    for (const f of images.slice(0, room)) {
      if (!IMAGE_TYPES.includes(f.type)) {
        toast.error(`「${f.name}」不是 PNG / JPG / WebP / GIF 图片`);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast.error(`「${f.name}」超过 10 MB`);
        continue;
      }
      add.push({ dataUrl: await readFile(f), key: `${f.name}-${f.size}-${Math.random()}`, mime: f.type, name: f.name || '粘贴的图片', size: f.size });
    }
    if (images.length > room) toast.warning(`一次最多发 ${MAX_IMAGES} 张图片，多出的没有加入`);
    if (add.length) setPending((p) => [...p, ...add].slice(0, MAX_IMAGES));
  };

  const pickImages = async () => {
    if (pending.length >= MAX_IMAGES) return toast.warning(`一次最多发 ${MAX_IMAGES} 张图片`);
    const r = await chat().pickImages();
    for (const x of r.rejected ?? []) toast.error(`「${x.name}」：${x.message}`);
    if (!r.ok || !r.images.length) return;
    const room = MAX_IMAGES - pending.length;
    if (r.images.length > room) toast.warning(`一次最多发 ${MAX_IMAGES} 张图片，多出的没有加入`);
    setPending((p) => [
      ...p,
      ...r.images.slice(0, room).map((i) => ({ dataUrl: i.dataUrl, key: i.path, mime: i.mime, name: i.name, path: i.path, size: i.size })),
    ]);
    textRef.current?.focus();
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  // `sticker`: one picked in the 表情包 panel — sent as its own message (text and pictures empty), the draft stays
  const send = async (text: string, images: Pending[], sticker: ChatSticker | null = null) => {
    if (busy || !activeId || !met) return;
    const body = text.trim();
    if (!body && !images.length && !sticker) return;
    if (images.length && !vision) {
      toast.warning(`「${currentModel?.label ?? '这个模型'}」看不了图片：换一个标着「视觉」的模型，或者先移除图片`);
      return;
    }
    const sid = activeId;
    const temp: ChatMessage = {
      attachments: images.map((i) => ({ id: i.key, mime: i.mime, name: i.name, size: i.size, url: i.dataUrl })),
      createdAt: Date.now(),
      id: `tmp_${Date.now()}`,
      model: m?.current ?? null,
      role: 'user',
      status: 'done',
      sticker,
      text: body,
      turnId: null,
      unsavedImages: 0,
      via: 'console',
    };
    stick.current = true;
    setMessages((ms) => [...ms, temp]);
    if (!sticker) {
      setInput('');
      setPending([]);
    }
    setLive({ speciesId: sid, text: '', turnId: null });
    const r = await chat().send({
      images: images.map((i) => (i.path ? { path: i.path } : { dataUrl: i.dataUrl, name: i.name })),
      speciesId: sid,
      ...(sticker && sticker.set && sticker.id ? { sticker: { id: sticker.id, set: sticker.set } } : {}),
      text: body,
    });
    const here = activeRef.current === sid;
    if (!r.userMessage) {
      // refused before anything was kept: put what you wrote back
      if (liveRef.current?.speciesId === sid) liveRef.current = null;
      setLive((l) => (l && l.speciesId === sid ? null : l));
      if (here) {
        setMessages((ms) => ms.filter((x) => x.id !== temp.id));
        if (!sticker) {
          setInput((v) => v || body);
          setPending((p) => (p.length ? p : images));
        }
      }
      toast.error(r.error ?? '没有发出去');
      return;
    }
    const { message, userMessage } = r;
    if (here) {
      setMessages((ms) => {
        const next = ms.filter((x) => x.id !== userMessage.id).map((x) => (x.id === temp.id ? userMessage : x));
        return !message || next.some((x) => x.id === message.id) ? next : [...next, message];
      });
    }
    if (liveRef.current?.speciesId === sid) liveRef.current = null;
    setLive((l) => (l && l.speciesId === sid ? null : l));
    refreshCharacters();
  };

  const stop = () => {
    if (live) chat().abort(live.speciesId);
  };

  /** 重试: the round that failed is sent again (its words and pictures). */
  const retry = (assistantIndex: number) => {
    const user = [...messages.slice(0, assistantIndex)].reverse().find((x) => x.role === 'user');
    if (!user) return;
    send(
      user.text,
      user.attachments.filter((a) => a.url).map((a) => ({ dataUrl: a.url as string, key: `${a.id}-retry`, mime: a.mime, name: a.name, size: a.size })),
      user.sticker ?? null,
    );
  };

  const changeModel = async (key: string) => {
    // only one of hers (the picker is rebuilt per character, so another one's pick never lands here)
    if (!row || !m?.options.some((o) => o.key === key) || key === m.current) return;
    const r = await api().setModel(key, row.id);
    if (r && r.view) merge({ view: r.view });
    if (!r || !r.ok) toast.error(reasonText(r));
  };

  const refreshModels = async () => {
    setRefreshing(true);
    try {
      const r = await api().refreshModels();
      if (r && r.view) merge({ view: r.view });
    } finally {
      setRefreshing(false);
    }
  };
  // her vendor's model list is loaded the first time someone needs it (as on her page → 模型)
  useEffect(() => {
    if (m && !m.loaded) api().refreshModels().then((r) => r && r.view && merge({ view: r.view }), () => {});
  }, [m?.loaded, merge]);

  // a 通用设定 character belongs to no vendor and may use every model (core/models.js optionsFor)
  const generic = row?.vendor === '通用';
  const modelOptions = useMemo(() => {
    const opts = m?.options ?? [];
    // the same name from two providers: say whose it is
    const twice = new Set(opts.filter((o, i) => opts.findIndex((x) => x.label === o.label) !== i).map((o) => o.label));
    return opts.map((o) => ({
      label: (
        <span className={styles.modelOption} data-model-option={o.key}>
          <span className={styles.ellipsis}>{o.label as string}</span>
          {twice.has(o.label) && (
            <Text fontSize={12} type="secondary">
              {o.providerId as string}
            </Text>
          )}
          {o.vision === true && (
            <Tag color="processing" icon={<Icon icon={Eye} />} size="small">
              视觉
            </Tag>
          )}
        </span>
      ),
      title: `${o.label as string}（${o.providerId as string}）`,
      value: o.key,
    }));
  }, [m?.options]);

  const visionBlocked = pending.length > 0 && !vision;
  const canSend = met && !busy && (!!input.trim() || pending.length > 0) && !visionBlocked;
  const herAvatar = { avatar: <CharAvatar row={row} size={32} />, backgroundColor: 'transparent', title: name };
  const userAvatar = me?.avatar ? { avatar: <UserAvatar name={me.name || '你'} onFail={dropMe} size={32} src={me.avatar} />, backgroundColor: 'transparent', title: me.name || '你' } : USER_AVATAR;

  const renderMessage = (x: ChatMessage, i: number) => {
    const isUser = x.role === 'user';
    const pictures = (x.attachments.length > 0 || x.unsavedImages > 0) && (
      <PreviewGroup>
        <Flexbox data-message-images gap={8} horizontal justify={isUser ? 'flex-end' : 'flex-start'} wrap="wrap">
          {x.attachments.map((a) =>
            a.url ? (
              <Image alt={a.name} data-chat-image={a.id} height={128} key={a.id} objectFit="cover" preview src={a.url} variant="outlined" width={128} />
            ) : (
              <Tag key={a.id}>图片已丢失：{a.name}</Tag>
            ),
          )}
          {x.unsavedImages > 0 && <Tag data-unsaved-images>在桌面发的 {x.unsavedImages} 张图片（没有保存）</Tag>}
        </Flexbox>
      </PreviewGroup>
    );
    // 表情包 (docs/stickers-design.md §3.3): a message that is only a sticker shows the picture instead of a bubble;
    // a reply with words and a sticker shows it under the words
    const onlySticker = !!x.sticker && !x.text && x.status === 'done';
    const sticker = x.sticker && <StickerImage key="sticker" sticker={x.sticker} size={onlySticker ? 120 : 96} />;
    return (
      <ChatItem
        aboveMessage={isUser ? pictures : undefined}
        avatar={isUser ? userAvatar : herAvatar}
        belowMessage={
          <Flexbox gap={8} paddingBlock={4}>
            {!isUser && (x.music?.length ?? 0) > 0 && (
              <Flexbox data-message-music gap={8}>
                {x.music!.map((mu) => (
                  <MusicCard key={mu.id} music={mu} />
                ))}
              </Flexbox>
            )}
            <Flexbox align="center" gap={8} horizontal justify={isUser ? 'flex-end' : 'flex-start'}>
            {!isUser && x.model && (
              <Text data-message-model fontSize={12} type="secondary">
                {modelLabel(row, x.model)}
              </Text>
            )}
            {x.via === 'desktop' && (
              <Tooltip title="这一轮是在桌宠的聊天框里聊的">
                <Tag size="small">桌面</Tag>
              </Tooltip>
            )}
            {x.status === 'aborted' && <Tag size="small">已停止</Tag>}
            </Flexbox>
          </Flexbox>
        }
        className={onlySticker ? styles.stickerOnly : undefined}
        data-message-id={x.id}
        data-role={x.role}
        data-sticker-message={x.sticker ? 'true' : undefined}
        data-status={x.status}
        error={
          x.status === 'error'
            ? {
                action: (
                  <Button data-retry icon={RotateCw} onClick={() => retry(i)} size="small">
                    重试
                  </Button>
                ),
                description: x.error,
                showIcon: true,
                title: '回复没有完成',
                type: 'error',
              }
            : undefined
        }
        key={x.id}
        message={x.text || (x.status === 'aborted' ? '（还没说什么就停止了）' : '')}
        placement={isUser ? 'right' : 'left'}
        renderMessage={x.sticker ? (content) => (onlySticker ? sticker : <Flexbox gap={8}>{content}{sticker}</Flexbox>) : undefined}
        showTitle={false}
        time={x.createdAt}
        variant="bubble"
      />
    );
  };

  const list = characters.length
    ? characters
    : [...new Set(roster.map((c) => c.base))].map((b) => {
        const c = rowOf(roster, b) as RosterRow;
        return { count: 0, current: roster.some((x) => x.base === b && x.current), id: b, lastAt: null, met: !!c.met, name: c.met?.name ?? c.nameZh, preview: '' };
      });
  const ordered = [...list].sort((a, b) => Number(b.met) - Number(a.met) || Number(b.current) - Number(a.current) || (b.lastAt ?? 0) - (a.lastAt ?? 0));

  return (
    <div className={styles.root} data-chat-page>
      <aside aria-label="角色" className={styles.side}>
        <div className={styles.sideList} data-character-list>
          {ordered.map((c) => {
            const r = rowOf(roster, c.id);
            return (
              <div
                role="button"
                tabIndex={0}
                aria-current={c.id === activeId ? 'true' : undefined}
                className={styles.session}
                data-character={c.id}
                data-met={c.met ? 'true' : 'false'}
                key={c.id}
                onClick={() => c.id !== activeId && navigate(`/chat/${c.id}`)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                    e.preventDefault();
                    if (c.id !== activeId) navigate(`/chat/${c.id}`);
                  }
                }}
              >
                <CharAvatar row={r} />
                <div className={styles.sessionText}>
                  <Flexbox align="center" gap={8} horizontal>
                    <Text className={styles.ellipsis} ellipsis>
                      {c.name}
                    </Text>
                    {c.current && <Tag size="small">{c.place || '在桌面'}</Tag>}
                    {live?.speciesId === c.id && <Spin size="small" />}
                  </Flexbox>
                  <Text className={styles.ellipsis} fontSize={12} type="secondary">
                    {!c.met ? '还没见过面' : c.preview || (c.count ? `${c.count} 条消息` : '还没聊过')}
                  </Text>
                </div>
                <Text fontSize={12} type="secondary">
                  {clock(c.lastAt)}
                </Text>
              </div>
            );
          })}
        </div>
      </aside>

      <section
        aria-label="对话"
        className={styles.main}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files') || !met) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDrop={onDrop}
      >
        <header className={styles.header}>
          <CharAvatar row={row} size={32} />
          <Flexbox flex={1} style={{ minWidth: 0 }}>
            <Text className={styles.ellipsis} data-chat-title strong>
              {name}
            </Text>
            <Text fontSize={12} type="secondary">
              {met ? `${who?.count ?? messages.length} 条消息 · 她记得最近 4 小时，问起以前的事会去翻聊天记录` : '还没见过面'}
            </Text>
          </Flexbox>
          {met && (
            <>
              <span data-model-select>
                <Select
                  key={activeId}
                  aria-label="模型"
                  disabled={!m?.options.length}
                  loading={!!m && !m.loaded}
                  onChange={(v) => changeModel(v as string)}
                  options={modelOptions}
                  placeholder={m?.loaded ? (generic ? '没有可用的模型' : `没有可用的 ${row?.vendor ?? ''} 模型`) : '正在读取模型…'}
                  popupMatchSelectWidth={false}
                  style={{ width: 240 }}
                  value={m?.current ?? undefined}
                />
              </span>
              <ActionIcon icon={RotateCw} loading={refreshing} onClick={refreshModels} title="刷新模型列表" />
            </>
          )}
        </header>

        {met && m?.loaded && !m.options.length && (
          <Flexbox paddingBlock={8} paddingInline={16}>
            <Alert data-model-error description={generic ? '你还没有启用任何对话模型，她先用原来的模型。' : `只能选 ${row?.vendor} 的模型；你还没有启用任何一个，她先用原来的模型。`} showIcon title="没有可选的模型" type="warning" />
          </Flexbox>
        )}

        <div className={styles.scroll} data-chat-scroll onScroll={onScroll} ref={scrollRef}>
          <div className={styles.messages} ref={contentRef}>
            {!met ? (
              <Flexbox align="center" paddingBlock={64}>
                <Empty
                  action={
                    row && (
                      <Button onClick={() => navigate(`/characters/${row.id}`)} type="primary">
                        去见她
                      </Button>
                    )
                  }
                  description="和她初次见面之后，她才有自己的 agent，才能在这里聊天。"
                  icon={MessagesSquare}
                  title={`还没见过${name}`}
                />
              </Flexbox>
            ) : loading ? (
              <Flexbox align="center" paddingBlock={48}>
                <Spin />
              </Flexbox>
            ) : messages.length === 0 && !liveHere ? (
              <Flexbox align="center" paddingBlock={64}>
                <Empty description="在这里说的话，她在桌面上也记得；聊天记录里也看得到。" icon={MessagesSquare} title={`和${name}说点什么？`} />
              </Flexbox>
            ) : (
              <Flexbox gap={0}>
                {hasMore && (
                  <div className={styles.earlier}>
                    <Button data-load-earlier icon={History} loading={loadingMore} onClick={loadEarlier} size="small" type="text">
                      查看更早的消息
                    </Button>
                  </div>
                )}
                {messages.map(renderMessage)}
                {liveHere && (
                  <ChatItem
                    avatar={herAvatar}
                    belowMessage={
                      <Flexbox gap={8} paddingBlock={4}>
                        {composingHere && (
                          <Flexbox align="center" data-music-status={composingHere.state} gap={8} horizontal wrap="wrap">
                            <Tag color={composingHere.state === 'failed' ? 'error' : composingHere.state === 'done' ? 'success' : 'processing'} icon={<Music size={12} />}>
                              {composingHere.state === 'composing'
                                ? `作曲中…${composingHere.title ? `《${composingHere.title}》` : ''} ${clockOf(Math.max(1000, now - (composingHere.startedAt ?? now))) || '0:01'}`
                                : composingHere.state === 'done'
                                  ? `写好了${composingHere.music?.title ? `《${composingHere.music.title}》` : ''}`
                                  : '这次没写成'}
                            </Tag>
                            <Text fontSize={12} type="secondary">
                              {composingHere.state === 'composing' ? '一首歌一般要 1–3 分钟，可以随时停止' : composingHere.state === 'failed' ? composingHere.error : '她在回你话'}
                            </Text>
                          </Flexbox>
                        )}
                        <Text fontSize={12} type="secondary">
                          {modelLabel(row, m?.current)}
                          {m?.current ? ' · ' : ''}正在回复
                        </Text>
                      </Flexbox>
                    }
                    data-role="assistant"
                    data-streaming
                    loading
                    markdownProps={STREAM_MARKDOWN}
                    message={liveHere.text}
                    placement="left"
                    renderMessage={(content) => (liveHere.text ? content : <LoadingDots />)}
                    showTitle={false}
                    variant="bubble"
                  />
                )}
              </Flexbox>
            )}
          </div>
        </div>

        {!atBottom && met && (
          <ActionIcon
            className={styles.toBottom}
            data-to-bottom
            icon={ArrowDown}
            onClick={() => {
              stick.current = true;
              setAtBottom(true);
              toBottom();
            }}
            title="回到最新消息"
          />
        )}

        {met && (
          <div className={styles.inputWrap}>
            <div className={styles.inputCard} data-chat-input data-dragging={dragging}>
              {visionBlocked && (
                <Flexbox paddingInline={12}>
                  <Alert data-vision-warning showIcon title={`「${currentModel?.label as string}」看不了图片：换一个标着「视觉」的模型，或者移除图片。`} type="warning" />
                </Flexbox>
              )}
              {pending.length > 0 && (
                <PreviewGroup>
                  <div className={styles.thumbs} data-pending-images>
                    {pending.map((p) => (
                      <div className={styles.thumb} data-pending-image={p.name} key={p.key}>
                        <Tooltip title={`${p.name} · ${kb(p.size)}`}>
                          <Image alt={p.name} height={64} objectFit="cover" preview src={p.dataUrl} variant="outlined" width={64} />
                        </Tooltip>
                        <ActionIcon
                          className={styles.thumbRemove}
                          data-remove-image
                          icon={X}
                          onClick={() => setPending((l) => l.filter((x) => x.key !== p.key))}
                          size="small"
                          title={`移除 ${p.name}`}
                        />
                      </div>
                    ))}
                  </div>
                </PreviewGroup>
              )}
              <ChatInputAreaInner
                aria-label="消息"
                autoSize={{ maxRows: 10, minRows: 2 }}
                data-chat-textarea
                loading={busy}
                onInput={setInput}
                onPaste={onPaste}
                onSend={() => canSend && send(input, pending)}
                placeholder={busy && !liveHere ? '另一个角色正在回复，结束或停止后再发…' : `和${name}说点什么，Enter 发送，Shift + Enter 换行；可以粘贴或拖入图片`}
                ref={textRef}
                value={input}
              />
              <ChatInputActionBar
                leftAddons={
                  <Flexbox gap={4} horizontal>
                    <ActionIcon
                      data-pick-images
                      disabled={pending.length >= MAX_IMAGES}
                      icon={ImagePlus}
                      onClick={pickImages}
                      title={!vision ? `添加图片（「${currentModel?.label as string}」看不了图片）` : `添加图片（最多 ${MAX_IMAGES} 张）`}
                    />
                    {activeId && (
                      <StickerPicker
                        disabled={busy}
                        name={name}
                        onAdd={() => row && navigate(`/characters/${row.id}/stickers`)}
                        onPick={(set, st) => send('', [], { id: st.id, label: st.label, set: set.id, url: st.url })}
                        speciesId={activeId}
                      />
                    )}
                  </Flexbox>
                }
                padding="0 8px"
                rightAddons={
                  <ChatSendButton
                    className={styles.sendBar}
                    data-send
                    loading={busy}
                    onSend={() => canSend && send(input, pending)}
                    onStop={stop}
                    paddingInline={0}
                    texts={{ send: '发送', stop: '停止', warp: '换行' }}
                  />
                }
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
