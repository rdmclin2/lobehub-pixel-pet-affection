/**
 * One control per setting, chosen by the schema type (core/settings-schema.js):
 * - instant two-state / choice items (Switch, Segmented, Select, Slider) save on change (P-05: switches only
 *   for items that apply at once) with a toast;
 * - typed values (number, text, URL) are drafts with a 保存 button, checked here first and again in main;
 * - keys are write-only (InputPassword, never filled from the store), the API token is masked.
 * Every editable field offers 恢复默认 when it differs from its default.
 */
import {
  ActionIcon,
  Button,
  CopyButton,
  Flexbox,
  HotkeyInput,
  Input,
  InputNumber,
  InputPassword,
  Segmented,
  Select,
  Slider,
  Switch,
  Tag,
  Text,
  Tooltip,
  confirmModal,
  toast,
} from '@lobehub/ui';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, at, type FieldDef, type HotkeyStatus } from './api';
import { useSave, useStore } from './store';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
const MAC_SYM: Record<string, string> = { Alt: '⌥', AltGr: '⌥', Command: '⌘', CommandOrControl: '⌘', Control: '⌃', Shift: '⇧', Super: '⌘' };
const PC_NAME: Record<string, string> = { Alt: 'Alt', AltGr: 'AltGr', Command: 'Win', CommandOrControl: 'Ctrl', Control: 'Ctrl', Shift: 'Shift', Super: 'Win' };
/** An Electron accelerator as the owner reads it: ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere (core/hotkey.js labelFor). */
export const acceleratorLabel = (acc: string, mac = IS_MAC) => {
  if (!acc) return '';
  const parts = acc.split('+');
  const key = parts.pop() ?? '';
  return mac ? `${parts.map((p) => MAC_SYM[p] ?? p).join('')}${key}` : [...parts.map((p) => PC_NAME[p] ?? p), key].join('+');
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const formatValue = (f: FieldDef, v: unknown): string => {
  if (f.type === 'hotkey') return typeof v === 'string' && v ? acceleratorLabel(v) : '不用快捷键';
  if (v === null || v === undefined || v === '') return '--';
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (f.format === 'percent' && typeof v === 'number') return pct(v);
  if (f.format === 'time' && typeof v === 'number') return new Date(v).toLocaleString('zh-CN');
  const o = f.options?.find((x) => x.value === v);
  if (o) return o.label;
  if (Array.isArray(v)) return v.length ? v.join('、') : '无';
  return `${v}${f.unit ?? ''}`;
};

/** confirmModal as a promise (the button texts are passed explicitly: project rule R-03). */
export const ask = (title: ReactNode, content: ReactNode, okText: string, danger = false) =>
  new Promise<boolean>((resolve) => {
    confirmModal({
      cancelText: '取消',
      content,
      okButtonProps: danger ? { danger: true } : undefined,
      okText,
      onCancel: () => resolve(false),
      onOk: () => resolve(true),
      title,
    });
  });

/** Client-side check (main checks again): the reason in the same words as main. */
export const checkDraft = (f: FieldDef, raw: string): { error?: string; value?: unknown } => {
  if (f.type === 'number') {
    if (raw.trim() === '') return { error: '请填写一个数字' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: '请填写一个数字' };
    if ((f.step ?? 1) >= 1 && !Number.isInteger(n)) return { error: '需要整数' };
    if (f.min !== undefined && n < f.min) return { error: `不能小于 ${f.min}${f.unit ?? ''}` };
    if (f.max !== undefined && n > f.max) return { error: `不能大于 ${f.max}${f.unit ?? ''}` };
    return { value: n };
  }
  if (f.type === 'url') {
    const v = raw.trim();
    if (!v) return { value: '' };
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return { error: '不是一个完整的地址（例如 https://example.com）' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: '只支持 https（本机或局域网可以用 http）' };
    if (u.username || u.password) return { error: '地址里不能带账号密码' };
    return { value: v };
  }
  if (f.type === 'text') {
    const v = raw.trim();
    if (f.maxLength && v.length > f.maxLength) return { error: `最多 ${f.maxLength} 字` };
    if (f.pattern && v && !new RegExp(f.pattern).test(v)) return { error: '格式不对：只能用字母、数字和 . _ : / -' };
    return { value: v };
  }
  return { value: raw };
};

const savedToast = (f: FieldDef, v: unknown, restart?: boolean) =>
  restart ? toast.warning({ description: '重启应用后生效', title: `已保存：${f.label}` }) : toast.success(`已保存：${f.label} → ${formatValue(f, v)}`);

/** 恢复默认 for one field. */
export const ResetButton = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const save = useSave();
  if (!(field.live || field.restart) || field.default === undefined || same(value, field.default)) return null;
  return (
    <ActionIcon
      data-reset={field.key}
      icon={RotateCcw}
      onClick={async () => {
        const r = await save(field.key, field.default);
        if (r.ok) toast.success(`${field.label}：已恢复默认（${formatValue(field, field.default)}）`);
        else toast.error(r.message || '没有恢复成功');
      }}
      size="small"
      title={`恢复默认：${formatValue(field, field.default)}`}
    />
  );
};

const InstantControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const save = useSave();
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(value);
  // while the owner is still moving the slider (or a save is on its way) the stored value must not snap the
  // control back; it follows the store again once the edit is saved
  const editing = useRef(0);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    if (!editing.current) setLocal(value);
  }, [value]);
  useEffect(() => () => { if (keyTimer.current) clearTimeout(keyTimer.current); }, []);
  const commit = async (v: unknown) => {
    editing.current += 1;
    setBusy(true);
    setLocal(v);
    try {
      const r = await save(field.key, v);
      if (r.ok) savedToast(field, r.value, r.restart);
      else {
        setLocal(value);
        toast.error({ description: r.message || r.reason, title: `${field.label} 没有保存` });
      }
    } finally {
      editing.current -= 1;
      setBusy(false);
    }
  };
  const data = { 'data-key': field.key };
  switch (field.type) {
    case 'switch':
      return <Switch {...data} aria-label={field.label} checked={!!local} loading={busy} onChange={(c: boolean) => commit(c)} />;
    // Select / Segmented do not pass data-* / aria-* through: the wrapper carries the key and the name
    case 'segmented':
      return (
        <div {...data} aria-label={field.label} role="group">
          <Segmented disabled={busy} onChange={(v) => commit(v)} options={field.options ?? []} value={String(local)} />
        </div>
      );
    case 'select':
      return (
        <div {...data} aria-label={field.label} role="group">
          <Select disabled={busy} onChange={(v) => commit(v)} options={field.options ?? []} style={{ width: 240 }} value={local as string} />
        </div>
      );
    case 'slider': {
      const percent = field.format === 'percent';
      const n = Number(local);
      return (
        <Flexbox
          align="center"
          gap={12}
          horizontal
          // arrow keys move the thumb; the value is saved once the keys rest for a moment (as on pointer release)
          onKeyUp={(e) => {
            if (!/^(Arrow|Home|End|Page)/.test(e.key)) return;
            if (keyTimer.current) clearTimeout(keyTimer.current);
            else editing.current += 1;
            keyTimer.current = setTimeout(() => {
              keyTimer.current = null;
              editing.current -= 1;
              commit(Number(localRef.current));
            }, 350);
          }}
          style={{ width: 300 }}
          {...data}
        >
          <Slider
            // stays usable while a value is being saved: the next step simply saves after it
            max={field.max}
            min={field.min}
            onChange={(v: number) => setLocal(v)}
            onChangeComplete={(v: number) => commit(v)}
            step={field.step}
            style={{ flex: 1 }}
            value={n}
          />
          <Text style={{ minWidth: 48, textAlign: 'end' }} type="secondary">
            {percent ? pct(n) : n}
          </Text>
        </Flexbox>
      );
    }
    default:
      return null;
  }
};

/** number / text / url: a draft, checked as you type, saved with 保存 (or Enter). */
const DraftControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const save = useSave();
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value === null || value === undefined ? '' : String(value));
    setServerError(null);
  }, [value]);
  const check = checkDraft(field, draft);
  const dirty = draft !== (value === null || value === undefined ? '' : String(value));
  const error = check.error ?? serverError;
  const submit = async () => {
    if (check.error || !dirty) return;
    setBusy(true);
    try {
      const r = await save(field.key, check.value);
      if (r.ok) {
        setServerError(null);
        savedToast(field, r.value, r.restart);
      } else {
        setServerError(r.message || r.reason || '没有保存');
        toast.error({ description: r.message || r.reason, title: `${field.label} 没有保存` });
      }
    } finally {
      setBusy(false);
    }
  };
  const input =
    field.type === 'number' ? (
      <InputNumber
        aria-label={field.label}
        data-key={field.key}
        // no min / max here: the field would clamp silently; out-of-range input is shown as an error instead
        onChange={(v) => setDraft(v === null ? '' : String(v))}
        onPressEnter={submit}
        aria-invalid={!!error}
        step={field.step}
        style={{ width: 160 }}
        suffix={field.unit}
        value={draft === '' || Number.isNaN(Number(draft)) ? null : Number(draft)}
      />
    ) : (
      <Input
        aria-label={field.label}
        data-key={field.key}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={submit}
        placeholder={field.placeholder}
        aria-invalid={!!error}
        style={{ width: 300 }}
        value={draft}
      />
    );
  return (
    <Flexbox gap={4} style={{ alignItems: 'flex-end' }}>
      <Flexbox align="center" gap={8} horizontal>
        {input}
        <Button data-save={field.key} disabled={!dirty || !!check.error} loading={busy} onClick={submit}>
          保存
        </Button>
      </Flexbox>
      {error && (
        <Text data-error={field.key} fontSize={12} type="danger">
          {error}
        </Text>
      )}
      {!error && dirty && (
        <Text fontSize={12} type="secondary">
          未保存的修改
        </Text>
      )}
    </Flexbox>
  );
};

/**
 * HotkeyInput draws `space` as lucide's ␣ icon; `Space` is not in its key map, so it is written out as text.
 * Only for showing: what is saved goes back through `fromShownKeys` (HotkeyInput format, main turns it into
 * the Electron accelerator `…+Space`).
 */
const toShownKeys = (keys: string) => keys.split('+').map((k) => (k === 'space' ? 'Space' : k)).join('+');
const fromShownKeys = (keys: string) => keys.split('+').map((k) => (k === 'Space' ? 'space' : k)).join('+');

/** 快捷键唤起语音对话: the state main reports for the shortcut (voice-hotkey.js), as a tag. */
const HOTKEY_STATE: Record<HotkeyStatus['state'], { color?: string; text: string }> = {
  conflict: { color: 'error', text: '被占用' },
  disabled: { text: '未启用' },
  invalid: { color: 'error', text: '组合无效' },
  ok: { color: 'success', text: '已生效' },
};

/**
 * 快捷键 (asr.hotkey): recorded with HotkeyInput (click, press the combination). Main checks it again and only
 * then registers it; an invalid one or one the app itself, the system or another app uses is not saved and the
 * reason stays under the field. Clear (×) = no shortcut; 恢复默认 brings the default back.
 */
const HotkeyControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const { settings, platform } = useStore();
  const save = useSave();
  const st: HotkeyStatus | null = settings?.hotkeyStatus ?? null;
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // HotkeyInput offers a recorded combination again on every render while the stored value stays the old one
  // (main refused it): each combination is sent once per recording, never in a loop
  const inflight = useRef<string | null>(null);
  const refused = useRef<string | null>(null);
  const acc = typeof value === 'string' ? value : '';
  const keys = st && st.accelerator === acc ? st.keys : '';
  const reserved = field.reserved ?? [];
  const commit = async (shown: string) => {
    const next = fromShownKeys(shown);
    if (next === keys || next === inflight.current || next === refused.current) return;
    inflight.current = next;
    setError(null);
    setConflict(null);
    setBusy(true);
    try {
      const r = await save(field.key, next);
      if (r.ok) toast.success(next ? `已保存：${field.label} → ${r.settings?.hotkeyStatus?.label ?? next}` : `${field.label}：已关闭`);
      else {
        refused.current = next;
        setError(r.message || r.reason || '没有保存');
        toast.error({ description: r.message || r.reason, title: `${field.label} 没有保存` });
      }
    } finally {
      inflight.current = null;
      setBusy(false);
    }
  };
  // a new recording: anything may be tried again
  const onFocus = () => {
    refused.current = null;
    setError(null);
    setConflict(null);
  };
  const tag = st ? HOTKEY_STATE[st.state] : null;
  const statusError = !error && st && (st.state === 'conflict' || st.state === 'invalid') ? st.message : null;
  return (
    <Flexbox gap={4} style={{ alignItems: 'flex-end' }}>
      <Flexbox align="center" gap={8} horizontal>
        {tag && (
          <Tag color={tag.color} data-hotkey-state={st?.state}>
            {tag.text}
          </Tag>
        )}
        <div aria-label={field.label} data-hotkey-keys={keys} data-key={field.key} role="group" style={{ width: 240 }}>
          <HotkeyInput
            allowClear
            disabled={busy}
            hotkeyConflicts={reserved.map((r) => r.keys)}
            isApple={platform === 'darwin'}
            onChange={(v: string) => commit(v)}
            onConflict={(k: string) => {
              const r = reserved.find((x) => x.keys === k);
              setConflict(r ? `「${r.label}」（${acceleratorLabel(r.accelerator)}）` : null);
            }}
            onFocus={onFocus}
            placeholder="点这里，然后按下新的组合"
            resetValue={field.defaultKeys && toShownKeys(field.defaultKeys)}
            texts={{
              clear: '清空（不用快捷键）',
              // the same wording as main's check (core/hotkey.js checkHotkey) and README / docs/asr.md
              conflicts: `和应用内的${conflict ?? '快捷键'}冲突，换一个组合`,
              invalidCombination: '组合无效，没有保存：至少要有一个修饰键（Ctrl / ⌘ / Alt），且只能有一个普通键',
              reset: '恢复默认',
            }}
            value={toShownKeys(keys)}
            variant="filled"
          />
        </div>
      </Flexbox>
      {(error || statusError) && (
        <Text data-error={field.key} fontSize={12} type="danger">
          {error || statusError}
        </Text>
      )}
      {!error && !statusError && st?.state === 'ok' && (
        <Text data-hotkey-hint={field.key} fontSize={12} type="secondary">
          在任何地方按 {st.label} 唤起她
        </Text>
      )}
    </Flexbox>
  );
};

const hasKeyFor = (settings: any, key: string): boolean => {
  const id = key.slice('keys.'.length);
  if (id === 'asrlocal') return !!settings?.asrStatus?.local?.hasKey;
  return !!settings?.ttsStatus?.engines?.[id]?.hasKey;
};

/** Write-only key: the stored value never comes back, only 已设置 / 未设置. */
const SecretControl = ({ field }: { field: FieldDef }) => {
  const { settings } = useStore();
  const save = useSave();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const has = hasKeyFor(settings, field.key);
  const bad = draft.trim() !== '' && !/^[\x21-\x7e]{8,256}$/.test(draft.trim());
  const write = async (v: string) => {
    setBusy(true);
    try {
      const r = await save(field.key, v);
      if (r.ok) {
        setDraft('');
        toast.success(v ? `${field.label} 已保存（不会回显）` : `${field.label} 已清除`);
      } else toast.error({ description: r.message, title: `${field.label} 没有保存` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Flexbox gap={4} style={{ alignItems: 'flex-end' }}>
      <Flexbox align="center" gap={8} horizontal>
        <Tag color={has ? 'success' : undefined} data-has-key={field.key}>
          {has ? '已设置' : '未设置'}
        </Tag>
        <InputPassword
          aria-label={field.label}
          autoComplete="off"
          data-key={field.key}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={has ? '已设置（不显示），输入新的会替换' : '填写 Key'}
          aria-invalid={bad}
          style={{ width: 260 }}
          value={draft}
        />
        <Button data-save={field.key} disabled={!draft.trim() || bad} loading={busy} onClick={() => write(draft.trim())}>
          保存
        </Button>
        {has && (
          <Button
            danger
            disabled={busy}
            onClick={async () => {
              if (await ask(`清除${field.label}？`, '清除后这个引擎不能再用，直到重新填写。', `清除${field.label}`, true)) write('');
            }}
          >
            清除
          </Button>
        )}
      </Flexbox>
      {bad && (
        <Text fontSize={12} type="danger">
          8–256 个可见 ASCII 字符，不能有空格
        </Text>
      )}
    </Flexbox>
  );
};

export const maskSecret = (v: string) => (v ? `${'•'.repeat(Math.max(8, v.length - 4))}${v.slice(-4)}` : '');

/** The local API token: masked, with show, copy and 换一个令牌. */
const TokenControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const { merge } = useStore();
  const [shown, setShown] = useState(false);
  const token = typeof value === 'string' ? value : '';
  if (!token) return <Text type="secondary">开启对外接口时自动生成</Text>;
  return (
    <Flexbox align="center" gap={8} horizontal>
      <Text code data-key={field.key} data-masked={String(!shown)}>
        {shown ? token : maskSecret(token)}
      </Text>
      <ActionIcon icon={shown ? EyeOff : Eye} onClick={() => setShown(!shown)} size="small" title={shown ? '隐藏' : '显示'} />
      <CopyButton content={token} size="small" />
      <Button
        onClick={async () => {
          if (!(await ask('换一个令牌？', '旧令牌立即失效，用到它的脚本需要改成新的。', '换一个令牌', true))) return;
          const r = await api().newApiToken();
          if (r && r.settings) merge({ settings: r.settings });
          toast.success('已换成新的令牌');
        }}
        size="small"
      >
        换一个令牌
      </Button>
    </Flexbox>
  );
};

const VisitorsControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const { roster } = useStore();
  const save = useSave();
  const list = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div aria-label={field.label} data-key={field.key} role="group">
    <Select
      mode="multiple"
      onChange={async (v) => {
        const ids = (Array.isArray(v) ? v : []) as string[];
        if (ids.length > (field.max ?? 3)) {
          toast.error(`最多 ${field.max} 位`);
          return;
        }
        const r = await save(field.key, ids);
        if (r.ok) toast.success(`同屏伙伴：${ids.length ? ids.map((id) => roster.find((c) => c.id === id)?.name ?? id).join('、') : '无'}`);
        else toast.error(r.message || '没有保存');
      }}
      options={roster.filter((c) => !c.current && c.base !== roster.find((x) => x.current)?.base).map((c) => ({ label: `${c.name ?? c.nameZh}（${c.vendor}）`, value: c.id }))}
      placeholder="选几位来串门"
      style={{ width: 360 }}
      value={list}
    />
    </div>
  );
};

/** 成人向内容: switching on goes through the same 18+ confirmation as the first launch. */
const AdultControl = ({ value }: { value: unknown }) => {
  const { settings, merge } = useStore();
  const [busy, setBusy] = useState(false);
  const on = !!value;
  return (
    <Switch
      aria-label="成人向内容"
      checked={on}
      data-key="adultContent"
      loading={busy}
      onChange={async (next: boolean) => {
        setBusy(true);
        try {
          let r;
          if (next && !settings.ageConfirmed) {
            const ok = await ask('确认你已年满 18 周岁？', '成人向外观和服饰只对已满 18 周岁的人开放。选择「我已满 18 周岁」即表示你确认自己已成年。', '我已满 18 周岁');
            if (!ok) return;
            r = await api().confirmAge(true);
          } else r = await api().setAdult(next);
          if (r && r.settings) merge({ settings: r.settings });
          if (r && r.ok === false) toast.error('需要先确认已满 18 周岁');
          else toast.success(`成人向内容：${next ? '开' : '关'}`);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
};

/** 本机能力 (pet.json): high risk, confirmed before it is switched on. */
const LocalControl = ({ field }: { field: FieldDef }) => {
  const { view, merge } = useStore();
  const save = useSave();
  const [busy, setBusy] = useState(false);
  const on = !!view?.local?.enabled;
  if (!view) return <Text type="secondary">唤醒桌宠后可用</Text>;
  return (
    <Switch
      aria-label={field.label}
      checked={on}
      data-key={field.key}
      loading={busy}
      onChange={async (next: boolean) => {
        if (next && !(await ask('开启本机能力？', '她将可以在这台电脑上读写文件、运行命令。只在你信任当前模型和设定时开启。', '开启本机能力', true))) return;
        setBusy(true);
        try {
          const r: any = await save(field.key, next);
          if (r.view) merge({ view: r.view });
          if (r.ok) toast.success(`本机能力：${next ? '开' : '关'}`);
          else toast.error(r.message || r.reason || '没有成功');
        } finally {
          setBusy(false);
        }
      }}
    />
  );
};

/** The control for one field, plus its 恢复默认 button. */
export const FieldControl = ({ field }: { field: FieldDef }) => {
  const { settings } = useStore();
  const value = at(settings, field.key);
  let control: ReactNode;
  switch (field.type) {
    case 'switch':
    case 'select':
    case 'segmented':
    case 'slider':
      control = <InstantControl field={field} value={value} />;
      break;
    case 'number':
    case 'text':
    case 'url':
      control = <DraftControl field={field} value={value} />;
      break;
    case 'hotkey':
      control = <HotkeyControl field={field} value={value} />;
      break;
    case 'secret':
      control = <SecretControl field={field} />;
      break;
    case 'token':
      control = <TokenControl field={field} value={value} />;
      break;
    case 'visitors':
      control = <VisitorsControl field={field} value={value} />;
      break;
    case 'adult':
      control = <AdultControl value={value} />;
      break;
    case 'local':
      control = <LocalControl field={field} />;
      break;
    default:
      control = (
        <Text data-key={field.key} type="secondary">
          {formatValue(field, value)}
        </Text>
      );
  }
  return (
    <Flexbox align="center" gap={4} horizontal>
      {control}
      <ResetButton field={field} value={value} />
    </Flexbox>
  );
};

/** Label line extras: 默认值, 重启后生效, 敏感. */
export const FieldDesc = ({ field }: { field: FieldDef }) => (
  <Flexbox gap={4}>
    {field.desc && <span>{field.desc}</span>}
    <Flexbox gap={4} horizontal wrap="wrap">
      {field.default !== undefined && field.type !== 'readonly' && field.type !== 'token' && field.type !== 'adult' && (
        <Tooltip title="恢复默认时用这个值">
          <Tag size="small">默认：{formatValue(field, field.default)}</Tag>
        </Tooltip>
      )}
      {field.restart && (
        <Tag color="warning" size="small">
          重启后生效
        </Tag>
      )}
      {field.sensitive && (
        <Tag color="processing" size="small">
          敏感 · 遮罩显示
        </Tag>
      )}
    </Flexbox>
  </Flexbox>
);
