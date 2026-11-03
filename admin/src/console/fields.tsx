/**
 * One control per setting, chosen by the schema type (core/settings-schema.js):
 * - instant two-state / choice items (Switch, Segmented, Select, Slider) save on change (P-05: switches only
 *   for items that apply at once); success is a quiet inline 已保存 (A22 / FORM-03, C-17), failure a toast;
 * - numbers save when you leave the field or press Enter, checked first (A20 / FORM-01: the same way as the
 *   switches, no 保存 button); out of range stays red and is not saved;
 * - text and URL are drafts with a 保存 button; an unsaved draft asks before the page is left (A20, S-6 / P-04);
 * - keys are write-only (InputPassword, never filled from the store), the API token is masked.
 * Every editable field offers 恢复默认 when it differs from its default; it is undone from the toast, not confirmed
 * (A24 / FORM-05, W-07).
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

import { api, at, reasonText, type FieldDef, type HotkeyStatus } from './api';
import { askAsync, NoPet, SavedHint, useLeaveGuard } from './common';
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

/** The sentence a save is announced with (screen readers; SavedHint shows only 已保存). */
export const savedText = (f: FieldDef, v: unknown) => `已保存：${f.label} → ${formatValue(f, v)}`;

/** A22: a save's inline confirmation — a tick per save, the sentence for screen readers. */
const useSaved = () => {
  const [saved, setSaved] = useState<{ full: string; tick: number }>({ full: '', tick: 0 });
  return [saved, (full: string) => setSaved((s) => ({ full, tick: s.tick + 1 }))] as const;
};

/**
 * 恢复默认 for one field (A21 / FORM-02: the default is said in this button's tooltip, only while the value
 * differs; A24 / FORM-05: no confirmation — the toast offers 撤销 for 5 s).
 */
export const ResetButton = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const save = useSave();
  if (!(field.live || field.restart) || field.default === undefined || same(value, field.default)) return null;
  const before = value;
  return (
    <Tooltip title={`恢复默认：${formatValue(field, field.default)}`}>
      <ActionIcon
        aria-label={`恢复默认：${formatValue(field, field.default)}`}
        data-reset={field.key}
        icon={RotateCcw}
        onClick={async () => {
          const r = await save(field.key, field.default);
          if (!r.ok) return toast.error({ description: reasonText(r), title: `没能恢复「${field.label}」的默认值` });
          toast.success({
            actions: [
              {
                label: '撤销',
                onClick: async () => {
                  const u = await save(field.key, before);
                  if (!u.ok) toast.error({ description: reasonText(u), title: `没能撤销「${field.label}」` });
                },
              },
            ],
            duration: 5000,
            id: `reset:${field.key}`,
            title: `${field.label}：已恢复默认（${formatValue(field, field.default)}）`,
          });
        }}
        size="small"
      />
    </Tooltip>
  );
};

const InstantControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const save = useSave();
  const [busy, setBusy] = useState(false);
  const [saved, markSaved] = useSaved();
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
    // A23 (FORM-04, P-05): a high-risk switch asks before it goes on; off never asks
    if (field.confirmOn && v === true && !(await ask(field.confirmOn.title, field.confirmOn.content, field.confirmOn.okText, true))) return;
    editing.current += 1;
    setBusy(true);
    setLocal(v);
    try {
      const r = await save(field.key, v);
      // A22: saved → 已保存 next to it (a restart item also gets the window's 重启后生效 banner, Shell)
      if (r.ok) markSaved(savedText(field, r.value));
      else {
        setLocal(value);
        toast.error({ description: reasonText(r), title: `没能保存「${field.label}」` });
      }
    } finally {
      editing.current -= 1;
      setBusy(false);
    }
  };
  const data = { 'data-key': field.key };
  const hint = <SavedHint full={saved.full} tick={saved.tick} />;
  switch (field.type) {
    case 'switch':
      return (
        <Flexbox align="center" gap={8} horizontal>
          {hint}
          <Switch {...data} aria-label={field.label} checked={!!local} loading={busy} onChange={(c: boolean) => commit(c)} />
        </Flexbox>
      );
    // Select / Segmented do not pass data-* / aria-* through: the wrapper carries the key and the name
    case 'segmented':
      return (
        <Flexbox align="center" gap={8} horizontal>
          {hint}
          <div {...data} aria-label={field.label} role="group">
            <Segmented disabled={busy} onChange={(v) => commit(v)} options={field.options ?? []} value={String(local)} />
          </div>
        </Flexbox>
      );
    case 'select':
      return (
        <Flexbox align="center" gap={8} horizontal>
          {hint}
          <div {...data} aria-label={field.label} role="group">
            <Select disabled={busy} onChange={(v) => commit(v)} options={field.options ?? []} style={{ width: 240 }} value={local as string} />
          </div>
        </Flexbox>
      );
    case 'slider': {
      const percent = field.format === 'percent';
      const n = Number(local);
      return (
        <Flexbox align="center" gap={8} horizontal>
        {hint}
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
        </Flexbox>
      );
    }
    default:
      return null;
  }
};

/**
 * number: checked as you type, saved when you leave the field or press Enter (A20 / FORM-01) — no 保存 button.
 * text / url: a draft, checked as you type, saved with 保存 (or Enter); unsaved, it holds the page (S-6).
 */
const DraftControl = ({ field, value }: { field: FieldDef; value: unknown }) => {
  const save = useSave();
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, markSaved] = useSaved();
  const instant = field.type === 'number';
  useEffect(() => {
    setDraft(value === null || value === undefined ? '' : String(value));
    setServerError(null);
  }, [value]);
  const check = checkDraft(field, draft);
  const dirty = draft !== (value === null || value === undefined ? '' : String(value));
  const error = check.error ?? serverError;
  useLeaveGuard(`draft:${field.key}`, dirty && !instant);
  const inflight = useRef(false);
  const submit = async () => {
    // Enter then blur: one save
    if (check.error || !dirty || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      const r = await save(field.key, check.value);
      if (r.ok) {
        setServerError(null);
        markSaved(savedText(field, r.value));
      } else {
        // the reason stays under the field (where the value is); no second message in a toast
        setServerError(reasonText(r));
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };
  const input =
    field.type === 'number' ? (
      <InputNumber
        aria-label={field.label}
        data-key={field.key}
        // no min / max here: the field would clamp silently; out-of-range input is shown as an error instead
        onBlur={submit}
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
        <SavedHint full={saved.full} tick={saved.tick} />
        {input}
        {!instant && (
          <Button data-save={field.key} disabled={!dirty || !!check.error} loading={busy} onClick={submit}>
            保存
          </Button>
        )}
      </Flexbox>
      {error && (
        <Text data-error={field.key} fontSize={12} type="danger">
          {error}{instant ? '（没有保存）' : ''}
        </Text>
      )}
      {!error && dirty && !instant && (
        <Text data-unsaved={field.key} fontSize={12} type="secondary">
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
  const [saved, markSaved] = useSaved();
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
      if (r.ok) markSaved(next ? `已保存：${field.label} → ${r.settings?.hotkeyStatus?.label ?? next}` : `${field.label}：已关闭`);
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
        <SavedHint full={saved.full} tick={saved.tick} />
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
  const [saved, markSaved] = useSaved();
  useLeaveGuard(`secret:${field.key}`, draft.trim() !== '');
  const write = async (v: string) => {
    setBusy(true);
    try {
      const r = await save(field.key, v);
      // S-5: the tag turning 已设置 is the confirmation; 已保存 next to it, no toast
      if (r.ok) {
        setDraft('');
        markSaved(v ? `${field.label} 已保存（不会回显）` : `${field.label} 已清除`);
      } else toast.error({ description: reasonText(r), title: `没能保存「${field.label}」` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Flexbox gap={4} style={{ alignItems: 'flex-end' }}>
      <Flexbox align="center" gap={8} horizontal>
        <SavedHint full={saved.full} tick={saved.tick} />
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
        data-new-token
        onClick={async () => {
          // A23 (FORM-04): runs in the dialog, reports what really happened (S-7, C-15)
          const done = await askAsync({
            content: '旧令牌立即失效，用到它的脚本需要改成新的。',
            danger: true,
            okText: '换一个令牌',
            run: async () => {
              const r = await api().newApiToken();
              if (r && r.settings) merge({ settings: r.settings });
              return r && r.ok !== false && r.settings?.api?.token && r.settings.api.token !== token ? { ok: true } : { ok: false, reason: `${reasonText(r)}。旧令牌仍然有效` };
            },
            title: '换一个令牌？',
          });
          if (done) {
            setShown(true);
            setTimeout(() => setShown(false), 3000);
            toast.success({ id: 'api-token', title: '已换成新的令牌，旧令牌已失效' });
          }
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
  const [saved, markSaved] = useSaved();
  const on = !!value;
  return (
    <Flexbox align="center" gap={8} horizontal>
    <SavedHint full={saved.full} tick={saved.tick} />
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
          // A23 (FORM-04): only what main confirmed counts as done
          const now = !!(r && r.settings ? r.settings.adultContent : undefined);
          if (!r || r.ok === false || now !== next) toast.error({ description: r?.reason === 'age' || (next && !r?.settings?.ageConfirmed) ? '需要先确认已满 18 周岁' : reasonText(r), title: `没能${next ? '打开' : '关闭'}成人向内容` });
          else markSaved(`成人向内容：${next ? '开' : '关'}`);
        } finally {
          setBusy(false);
        }
      }}
    />
    </Flexbox>
  );
};

/** 本机能力 (pet.json): high risk, confirmed before it is switched on. */
const LocalControl = ({ field }: { field: FieldDef }) => {
  const { view, merge } = useStore();
  const save = useSave();
  const [busy, setBusy] = useState(false);
  const [saved, markSaved] = useSaved();
  const on = !!view?.local?.enabled;
  // A11 / A23 (FORM-04): not awake → say so and offer the way forward, not a grey line
  if (!view) return <NoPet compact what="唤醒桌宠后才能开启" />;
  return (
    <Flexbox align="center" gap={8} horizontal>
    <SavedHint full={saved.full} tick={saved.tick} />
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
          if (r.ok) markSaved(`本机能力：${next ? '开' : '关'}`);
          else toast.error({ description: reasonText(r), title: `没能${next ? '开启' : '关闭'}本机能力` });
        } finally {
          setBusy(false);
        }
      }}
    />
    </Flexbox>
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

/**
 * The description, plus 重启后生效 where that is true. A21 (FORM-02, C-17): no 「默认：xx」 tag on every row (the
 * default is in the 恢复默认 tooltip, shown only when the value differs) and no 「敏感」 tag (the masked / write-only
 * control already says it).
 */
export const FieldDesc = ({ field }: { field: FieldDef }) => (
  <Flexbox gap={4}>
    {field.desc && <span>{field.desc}</span>}
    {field.restart && (
      <Flexbox gap={4} horizontal wrap="wrap">
        <Tag color="warning" size="small">
          重启后生效
        </Tag>
      </Flexbox>
    )}
  </Flexbox>
);
