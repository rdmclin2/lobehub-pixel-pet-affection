/**
 * 聊天 (T-2765): the settings window's own AI chat (docs/admin-chat.md), shaped like LobeHub's chat page —
 * sessions on the left, the conversation in the middle, the input card at the bottom. Everything lives in main
 * (`petAdmin.chat`): this page keeps only what is on screen, so a reload or a trip to another page reads the
 * sessions, messages and pictures back from there.
 */
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  confirmModal,
  createStaticStyles,
  cssVar,
  Empty,
  Flexbox,
  Icon,
  Image,
  PreviewGroup,
  Select,
  Spin,
  Tag,
  Text,
  toast,
  Tooltip,
} from '@lobehub/ui';
import { ChatInputActionBar, ChatInputAreaInner, ChatItem, ChatSendButton, LoadingDots } from '@lobehub/ui/chat';
import { ArrowDown, Bot, Eraser, Eye, ImagePlus, MessageCirclePlus, MessagesSquare, RotateCw, Trash2, User, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api, type ChatMessage, type ChatModel, type ChatSessionSummary } from '../api';

const ACTIVE_KEY = 'pixelpet.adminChat.session';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const styles = createStaticStyles(({ css }) => ({
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
    padding-block: 4px 12px;
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

    & [data-session-delete] {
      opacity: 0;
    }

    &:hover [data-session-delete],
    &:focus-within [data-session-delete],
    &[aria-current='true'] [data-session-delete] {
      opacity: 1;
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

/** The reply being written: deltas carry the whole text so far. */
interface Live {
  messageId: string | null;
  sessionId: string;
  text: string;
}

const chat = () => api().chat;

const clock = (t: number) => {
  const d = new Date(t);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
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

export const ChatPage = () => {
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const [live, setLive] = useState<Live | null>(null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const model = models.find((m) => m.key === selected) ?? null;
  const labelOf = useCallback(
    (key: string | null | undefined) => (key ? (models.find((m) => m.key === key)?.label ?? key.split(':').pop() ?? key) : ''),
    [models],
  );
  const busy = !!live;
  const liveHere = live && live.sessionId === activeId ? live : null;
  const active = sessions.find((s) => s.id === activeId) ?? null;

  const refreshSessions = useCallback(async () => {
    const r = await chat().listSessions();
    if (r.ok) setSessions(r.sessions);
    return r.ok ? r.sessions : [];
  }, []);

  const loadModels = useCallback(async (force = false) => {
    setModelsLoading(true);
    try {
      const r = await chat().listModels(force);
      setModels(r.models ?? []);
      setSelected(r.selected ?? r.models?.[0]?.key ?? null);
      setModelError(r.error ?? (r.models?.length ? null : '没有可用的聊天模型：先在 LobeHub 里启用一个对话模型。'));
    } catch (e) {
      setModelError(String((e as Error)?.message ?? e));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  /** Open a session: its whole history (and pictures) comes back from main; a reply still running keeps streaming. */
  const open = useCallback(async (id: string | null) => {
    setActiveId(id);
    activeRef.current = id;
    stick.current = true;
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
    if (!id) {
      setMessages([]);
      setLoadingSession(false);
      return;
    }
    setMessages([]);
    setLoadingSession(true);
    const r = await chat().getSession(id);
    if (activeRef.current !== id) return;
    setLoadingSession(false);
    if (!r.ok || !r.session) {
      setMessages([]);
      toast.error(r.message ?? '这个会话没有打开');
      return;
    }
    setMessages(r.session.messages);
    if (r.session.streaming) setLive((l) => (l && l.sessionId === id ? l : { messageId: null, sessionId: id, text: '' }));
  }, []);

  // first visit, a reload or coming back from another page: everything is read again from main
  useEffect(() => {
    loadModels();
    (async () => {
      const list = await refreshSessions();
      const saved = localStorage.getItem(ACTIVE_KEY);
      await open(list.find((s) => s.id === saved)?.id ?? list[0]?.id ?? null);
    })();
  }, [loadModels, open, refreshSessions]);

  useEffect(() => {
    let seen: string | null = null;
    const offDelta = chat().onDelta((d) => {
      setLive({ messageId: d.messageId, sessionId: d.sessionId, text: d.text });
      // the first words of a reply: your message is saved by now, so the list shows its new title and count
      if (seen !== d.messageId) {
        seen = d.messageId;
        refreshSessions();
      }
    });
    const offDone = chat().onDone((d) => {
      if (activeRef.current === d.sessionId) setMessages((ms) => (ms.some((m) => m.id === d.message.id) ? ms : [...ms, d.message]));
      setLive((l) => (l && l.sessionId === d.sessionId ? null : l));
      refreshSessions();
    });
    return () => {
      offDelta();
      offDone();
    };
  }, [refreshSessions]);

  // stay at the bottom while she writes — unless you scrolled up to read
  // always instant: a smooth scroll would pass through "not at the bottom" and unstick itself mid-way
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [messages, liveHere?.text, activeId, loadingSession, toBottom]);
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

  const send = async (text: string, images: Pending[]) => {
    if (busy) return;
    const body = text.trim();
    if (!body && !images.length) return;
    if (images.length && model && !model.vision) {
      toast.warning(`「${model.label}」看不了图片：换一个标着「视觉」的模型，或者先移除图片`);
      return;
    }
    let sid = activeRef.current;
    if (!sid) {
      const c = await chat().createSession();
      sid = c.session.id;
      setSessions((s) => [c.session, ...s]);
      await open(sid);
    }
    const temp: ChatMessage = {
      attachments: images.map((i) => ({ id: i.key, mime: i.mime, name: i.name, size: i.size, url: i.dataUrl })),
      createdAt: Date.now(),
      id: `tmp_${Date.now()}`,
      model: selected ?? '',
      role: 'user',
      status: 'done',
      text: body,
    };
    stick.current = true;
    setMessages((ms) => [...ms, temp]);
    setInput('');
    setPending([]);
    setLive({ messageId: null, sessionId: sid, text: '' });
    const r = await chat().send({
      images: images.map((i) => (i.path ? { path: i.path } : { dataUrl: i.dataUrl, name: i.name })),
      model: selected ?? undefined,
      sessionId: sid,
      text: body,
    });
    const here = activeRef.current === sid;
    if (!r.message || !r.userMessage) {
      // refused before anything was saved: put what you wrote back
      setLive((l) => (l && l.sessionId === sid ? null : l));
      if (here) {
        setMessages((ms) => ms.filter((m) => m.id !== temp.id));
        setInput((v) => v || body);
        setPending((p) => (p.length ? p : images));
      }
      toast.error(r.error ?? '没有发出去');
      return;
    }
    const { message, userMessage } = r;
    if (here) {
      setMessages((ms) => {
        const next = ms.map((m) => (m.id === temp.id ? userMessage : m));
        return next.some((m) => m.id === message.id) ? next : [...next, message];
      });
    }
    setLive((l) => (l && l.sessionId === sid ? null : l));
    refreshSessions();
  };

  const stop = () => {
    if (live) chat().abort(live.sessionId);
  };

  /** 重试: the turn that failed is sent again (its words and pictures). */
  const retry = (assistantIndex: number) => {
    const user = [...messages.slice(0, assistantIndex)].reverse().find((m) => m.role === 'user');
    if (!user) return;
    send(
      user.text,
      user.attachments.filter((a) => a.url).map((a) => ({ dataUrl: a.url as string, key: `${a.id}-retry`, mime: a.mime, name: a.name, size: a.size })),
    );
  };

  const newSession = async () => {
    if (active && active.messageCount === 0 && messages.length === 0) return textRef.current?.focus();
    const c = await chat().createSession();
    if (!c.ok) return toast.error('没有新建成功');
    setSessions((s) => [c.session, ...s]);
    await open(c.session.id);
    textRef.current?.focus();
  };

  const removeSession = (s: ChatSessionSummary) =>
    confirmModal({
      cancelText: '取消',
      content: '会话里的消息和图片会一起删除，无法恢复。',
      okButtonProps: { danger: true },
      okText: '删除会话',
      onOk: async () => {
        const r = await chat().deleteSession(s.id);
        if (!r.ok) return toast.error('没有删除成功');
        if (live?.sessionId === s.id) setLive(null);
        const list = await refreshSessions();
        if (activeRef.current === s.id) await open(list[0]?.id ?? null);
        toast.success(`已删除「${s.title}」`);
      },
      title: `删除会话「${s.title}」？`,
    });

  const clearSession = () => {
    if (!activeId) return;
    confirmModal({
      cancelText: '取消',
      content: '这个会话里的消息和图片会被清空，会话本身保留。之后的对话不再带着之前的内容。',
      okButtonProps: { danger: true },
      okText: '清空消息',
      onOk: async () => {
        const id = activeId;
        if (live?.sessionId === id) await chat().abort(id);
        const r = await chat().clearSession(id);
        if (!r.ok) return toast.error(r.message ?? '没有清空成功');
        if (activeRef.current === id) setMessages([]);
        refreshSessions();
        toast.success('已清空');
      },
      title: '清空这个会话的消息？',
    });
  };

  const changeModel = async (key: string) => {
    const prev = selected;
    setSelected(key);
    const r = await chat().setModel(key);
    if (!r.ok) {
      setSelected(prev);
      toast.error(r.message ?? '没有切换成功');
    }
  };

  const modelOptions = useMemo(() => {
    // the same name from two providers: say whose it is
    const twice = new Set(models.filter((m, i) => models.findIndex((x) => x.label === m.label) !== i).map((m) => m.label));
    return models.map((m) => ({
      label: (
        <span className={styles.modelOption} data-model-option={m.key}>
          <span className={styles.ellipsis}>{m.label}</span>
          {twice.has(m.label) && (
            <Text fontSize={12} type="secondary">
              {m.providerId}
            </Text>
          )}
          {m.vision && (
            <Tag color="processing" icon={<Icon icon={Eye} />} size="small">
              视觉
            </Tag>
          )}
        </span>
      ),
      title: `${m.label}（${m.providerId}）`,
      value: m.key,
    }));
  }, [models]);

  const visionBlocked = pending.length > 0 && !!model && !model.vision;
  const canSend = !busy && (!!input.trim() || pending.length > 0) && !visionBlocked && !!selected;

  const renderMessage = (m: ChatMessage, i: number) => {
    const isUser = m.role === 'user';
    const pictures = m.attachments.length > 0 && (
      <PreviewGroup>
        <Flexbox data-message-images gap={8} horizontal justify={isUser ? 'flex-end' : 'flex-start'} wrap="wrap">
          {m.attachments.map((a) =>
            a.url ? (
              <Image alt={a.name} data-chat-image={a.id} height={128} key={a.id} objectFit="cover" preview src={a.url} variant="outlined" width={128} />
            ) : (
              <Tag key={a.id}>图片已丢失：{a.name}</Tag>
            ),
          )}
        </Flexbox>
      </PreviewGroup>
    );
    return (
      <ChatItem
        aboveMessage={isUser ? pictures : undefined}
        avatar={isUser ? USER_AVATAR : { avatar: <Icon icon={Bot} size={20} />, backgroundColor: cssVar.colorFillSecondary, title: labelOf(m.model) || 'AI' }}
        belowMessage={
          !isUser && (
            <Flexbox align="center" gap={8} horizontal paddingBlock={4}>
              <Text fontSize={12} type="secondary">
                {labelOf(m.model)}
              </Text>
              {m.status === 'aborted' && <Tag size="small">已停止</Tag>}
            </Flexbox>
          )
        }
        data-message-id={m.id}
        data-role={m.role}
        data-status={m.status}
        error={
          m.status === 'error'
            ? {
                action: (
                  <Button data-retry icon={RotateCw} onClick={() => retry(i)} size="small">
                    重试
                  </Button>
                ),
                description: m.error,
                showIcon: true,
                title: '回复没有完成',
                type: 'error',
              }
            : undefined
        }
        key={m.id}
        message={m.text || (m.status === 'aborted' ? '（还没说什么就停止了）' : '')}
        placement={isUser ? 'right' : 'left'}
        showTitle={false}
        time={m.createdAt}
        variant="bubble"
      />
    );
  };

  return (
    <div className={styles.root} data-chat-page>
      <aside aria-label="会话列表" className={styles.side}>
        <Flexbox align="center" horizontal justify="space-between" paddingBlock={12} paddingInline={16}>
          <Text strong>会话</Text>
          <ActionIcon data-new-session icon={MessageCirclePlus} onClick={newSession} title="新建会话" />
        </Flexbox>
        <div className={styles.sideList} data-session-list>
          {sessions.length === 0 ? (
            <Empty description="还没有会话，发一条消息就会建一个。" icon={MessagesSquare} />
          ) : (
            sessions.map((s) => (
              <div
                role="button"
                tabIndex={0}
                aria-current={s.id === activeId ? 'true' : undefined}
                className={styles.session}
                data-session={s.id}
                key={s.id}
                onClick={() => s.id !== activeId && open(s.id)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                    e.preventDefault();
                    if (s.id !== activeId) open(s.id);
                  }
                }}
              >
                <div className={styles.sessionText}>
                  <Flexbox align="center" gap={8} horizontal>
                    <Text className={styles.ellipsis} ellipsis>
                      {s.title}
                    </Text>
                    {live?.sessionId === s.id && <Spin size="small" />}
                  </Flexbox>
                  <Text className={styles.ellipsis} fontSize={12} type="secondary">
                    {s.preview || (s.messageCount ? `${s.messageCount} 条消息` : '还没有消息')}
                  </Text>
                </div>
                <Flexbox align="flex-end" gap={4}>
                  <Text fontSize={12} type="secondary">
                    {clock(s.updatedAt)}
                  </Text>
                  <ActionIcon
                    data-session-delete
                    icon={Trash2}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSession(s);
                    }}
                    size="small"
                    title="删除会话"
                  />
                </Flexbox>
              </div>
            ))
          )}
        </div>
      </aside>

      <section
        aria-label="对话"
        className={styles.main}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDrop={onDrop}
      >
        <header className={styles.header}>
          <Flexbox flex={1} style={{ minWidth: 0 }}>
            <Text className={styles.ellipsis} data-chat-title strong>
              {active?.title ?? '新会话'}
            </Text>
            <Text fontSize={12} type="secondary">
              {active ? `${active.messageCount} 条消息` : '发一条消息开始'}
            </Text>
          </Flexbox>
          <span data-model-select>
            <Select
              disabled={modelsLoading && !models.length}
              loading={modelsLoading}
              onChange={(v) => changeModel(v as string)}
              options={modelOptions}
              placeholder={modelsLoading ? '正在读取模型…' : '选择模型'}
              popupMatchSelectWidth={false}
              showSearch
              style={{ width: 240 }}
              value={selected ?? undefined}
            />
          </span>
          <ActionIcon icon={RotateCw} loading={modelsLoading} onClick={() => loadModels(true)} title="刷新模型列表" />
          <ActionIcon data-clear-session disabled={!activeId || !messages.length} icon={Eraser} onClick={clearSession} title="清空会话消息" />
        </header>

        {modelError && (
          <Flexbox paddingBlock={8} paddingInline={16}>
            <Alert
              action={
                <Button onClick={() => loadModels(true)} size="small">
                  重新读取
                </Button>
              }
              data-model-error
              description={modelError}
              showIcon
              title="模型列表没有读到"
              type="warning"
            />
          </Flexbox>
        )}

        <div className={styles.scroll} data-chat-scroll onScroll={onScroll} ref={scrollRef}>
          <div className={styles.messages} ref={contentRef}>
            {loadingSession ? (
              <Flexbox align="center" paddingBlock={48}>
                <Spin />
              </Flexbox>
            ) : messages.length === 0 && !liveHere ? (
              <Flexbox align="center" paddingBlock={64}>
                <Empty description="日常提问、写东西、看图都可以。会话保存在这台电脑上，和桌宠的对话互不影响。" icon={MessagesSquare} title="想聊点什么？" />
              </Flexbox>
            ) : (
              <Flexbox gap={0}>
                {messages.map(renderMessage)}
                {liveHere && (
                  <ChatItem
                    avatar={{ avatar: <Icon icon={Bot} size={20} />, backgroundColor: cssVar.colorFillSecondary, title: labelOf(selected) || 'AI' }}
                    belowMessage={
                      <Flexbox align="center" gap={8} horizontal paddingBlock={4}>
                        <Text fontSize={12} type="secondary">
                          {labelOf(selected)} · 正在生成
                        </Text>
                      </Flexbox>
                    }
                    data-role="assistant"
                    data-streaming
                    loading
                    markdownProps={{ animated: true }}
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

        {!atBottom && (
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

        <div className={styles.inputWrap}>
          <div className={styles.inputCard} data-chat-input data-dragging={dragging}>
            {visionBlocked && (
              <Flexbox paddingInline={12}>
                <Alert data-vision-warning showIcon title={`「${model?.label}」看不了图片：换一个标着「视觉」的模型，或者移除图片。`} type="warning" />
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
                        onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}
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
              placeholder={busy && !liveHere ? '另一个会话正在回复，结束或停止后再发…' : '输入消息，Enter 发送，Shift + Enter 换行；可以粘贴或拖入图片'}
              ref={textRef}
              value={input}
            />
            <ChatInputActionBar
              leftAddons={
                <ActionIcon
                  data-pick-images
                  disabled={pending.length >= MAX_IMAGES}
                  icon={ImagePlus}
                  onClick={pickImages}
                  title={model && !model.vision ? `添加图片（「${model.label}」看不了图片）` : `添加图片（最多 ${MAX_IMAGES} 张）`}
                />
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
      </section>
    </div>
  );
};
