/**
 * Shared states for every page (docs/admin-audit/02-plan.md §2, A00 / A11). One way to say each thing, so the
 * pages stop writing their own:
 * - NoPet (S-2③, HOME-04 / TOG-05 / FORM-04): the pet is not awake yet → the one next step, 打开桌宠窗口 (M-06 缺能力 A, W-04)
 * - LoadFailed (S-3, K-05「失败不是零条」): a read that failed says why and offers 重试 where the data would be
 * - askAsync (S-7, C-15): an irreversible action runs inside its confirmation; the dialog closes only when it worked,
 *   a failure is written in the dialog (PG-03)
 * - SavedHint (S-5, C-17 / FORM-03): an instant setting saved → a quiet 已保存 next to it, not a toast
 * - useLeaveGuard (S-6, P-04 / FORM-01): an unsaved Key / URL / text draft asks before the page is left
 */
import { Alert, Button, confirmModal, createStaticStyles, cssVar, Empty, Flexbox, Icon, Modal, Text } from '@lobehub/ui';
import { Check, CloudOff, PawPrint, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { api, reasonText } from '../api';

const styles = createStaticStyles(({ css }) => ({
  // visually hidden, still read by screen readers (and by the e2e toast matcher): the full 「已保存：X → Y」
  srOnly: css`
    position: absolute;

    overflow: hidden;

    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;

    white-space: nowrap;

    clip-path: inset(50%);
  `,
  saved: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;

    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorSuccess};
    white-space: nowrap;
  `,
  box: css`
    padding: 16px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
}));

// ---- NoPet ---------------------------------------------------------------------------------------------------
/** The pet is not awake: say what that blocks and offer the one way forward (打开桌宠窗口). */
export const NoPet = ({ what, compact }: { compact?: boolean; what?: string }) => {
  const open = (
    <Button data-no-pet-open icon={PawPrint} onClick={() => api().showPet()} size={compact ? 'small' : undefined} type={compact ? 'default' : 'primary'}>
      打开桌宠窗口
    </Button>
  );
  if (compact)
    return (
      <Flexbox align="center" data-no-pet gap={8} horizontal wrap="wrap">
        <Text type="secondary">{what ?? '唤醒桌宠后才能用'}</Text>
        {open}
      </Flexbox>
    );
  return (
    <div className={styles.box} data-no-pet>
      <Empty
        action={open}
        description={`${what ?? '这一页的内容'}要等她醒来才有。在桌宠窗口里选一位角色并唤醒她，她就会出现在这里。`}
        icon={PawPrint}
        title="还没有唤醒桌宠"
      />
    </div>
  );
};

// ---- LoadFailed ----------------------------------------------------------------------------------------------
/** A read failed: what could not be read, why, and 重试 — shown where the data would be, never as 「还没有…」. */
export const LoadFailed = ({ what, reason, onRetry }: { onRetry?: () => void; reason?: string; what: string }) => (
  <div className={styles.box} data-load-failed>
    <Empty
      action={
        onRetry && (
          <Button data-retry icon={RotateCw} onClick={onRetry}>
            重试
          </Button>
        )
      }
      description={`${reason ? `原因：${reason}。` : ''}可以稍后重试；一直失败时打开 关于与数据 → 打开错误日志 看看。`}
      icon={CloudOff}
      title={`没能读取${what}`}
    />
  </div>
);

// ---- askAsync ------------------------------------------------------------------------------------------------
export interface AskResult {
  /** what to say when it worked (the actual outcome: 「删除了 3 个 agent」) */
  done?: string;
  ok: boolean;
  /** why it did not work (written in the dialog) */
  reason?: string;
}

interface AskOpts {
  cancelText?: string;
  content: ReactNode;
  danger?: boolean;
  okText: string;
  run: () => Promise<AskResult>;
  title: ReactNode;
}
interface AskEntry {
  id: number;
  open: boolean;
  opts: AskOpts;
  resolve: (r: AskResult | null) => void;
}

// the dialogs askAsync opened, rendered by <AskHost /> (mounted once next to ModalHost, design/DesignProvider)
let asks: AskEntry[] = [];
let askSeed = 0;
const askListeners = new Set<() => void>();
const setAsks = (next: AskEntry[]) => {
  asks = next;
  askListeners.forEach((l) => l());
};

/**
 * One askAsync dialog (S-7, C-15). While `run` is in flight (C04 / C08 follow-up): 确认 shows loading, 取消 is
 * disabled, and the ✕ / Esc / a click outside cannot close it — the outcome is not known yet, so leaving would hide
 * it. A failure is written in the dialog (it stays open: try again or cancel); it closes only on success.
 */
const AskDialog = ({ entry }: { entry: AskEntry }) => {
  const { opts } = entry;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = (r: AskResult | null) => {
    setAsks(asks.map((a) => (a.id === entry.id ? { ...a, open: false } : a)));
    entry.resolve(r);
  };
  const ok = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    let r: AskResult;
    try {
      r = await opts.run();
    } catch (e) {
      r = { ok: false, reason: String((e as Error)?.message ?? e) };
    }
    setBusy(false);
    if (r.ok) close(r);
    else setErr(r.reason || '操作没有成功');
  };
  return (
    <Modal
      afterClose={() => setAsks(asks.filter((a) => a.id !== entry.id))}
      cancelButtonProps={{ disabled: busy }}
      cancelText={opts.cancelText ?? '取消'}
      closable={!busy}
      confirmLoading={busy}
      draggable={false}
      keyboard={!busy}
      maskClosable={!busy}
      okButtonProps={opts.danger ? { danger: true } : undefined}
      okText={opts.okText}
      onCancel={() => !busy && close(null)}
      onOk={ok}
      open={entry.open}
      title={opts.title}
      width={420}
    >
      <Flexbox data-ask-body data-ask-busy={busy ? 'true' : 'false'} gap={12}>
        <div>{opts.content}</div>
        {err && <Alert data-ask-error description={err} showIcon title="没有成功，什么都没有改动的部分保持原样" type="error" />}
      </Flexbox>
    </Modal>
  );
};

/** Where askAsync's dialogs render: mount once inside ConfigProvider (design/DesignProvider, next to ModalHost). */
export const AskHost = () => {
  const list = useSyncExternalStore(
    (l) => {
      askListeners.add(l);
      return () => askListeners.delete(l);
    },
    () => asks,
  );
  return (
    <>
      {list.map((a) => (
        <AskDialog entry={a} key={a.id} />
      ))}
    </>
  );
};

/**
 * An irreversible action confirmed and run in one dialog (S-7, C-15): 确认 shows 进行中 until `run` settles and the
 * dialog cannot be dismissed meanwhile; on failure the reason appears in the dialog and it stays open (try again or
 * cancel); it closes only on success. Resolves with the result that closed it, or null when cancelled.
 */
export const askAsync = (opts: AskOpts) =>
  new Promise<AskResult | null>((resolve) => {
    setAsks([...asks, { id: ++askSeed, open: true, opts, resolve }]);
  });

/** An IPC answer as an AskResult: `ok` from main, the reason in words. */
export const asResult = (r: any, done?: string): AskResult => (r && r.ok !== false ? { done, ok: true } : { ok: false, reason: reasonText(r) });

// ---- SavedHint -----------------------------------------------------------------------------------------------
/**
 * 已保存, next to the control, for 1.5 s after each save (`tick` changes per save). `full` is the whole sentence
 * (「已保存：梗图 → 关」) for screen readers: a polite live region, invisible.
 */
export const SavedHint = ({ tick, full }: { full?: string; tick: number }) => {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (!tick) return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), 1500);
    return () => clearTimeout(t);
  }, [tick]);
  return (
    <span aria-live="polite" data-saved-hint={on ? 'on' : 'off'} role="status">
      {on && (
        <span className={styles.saved}>
          <Icon icon={Check} size={12} />
          已保存
          {full && <span className={styles.srOnly}>{full}</span>}
        </span>
      )}
    </span>
  );
};

// ---- useLeaveGuard -------------------------------------------------------------------------------------------
const drafts = new Set<string>();
let asking = false;

/** Mark an unsaved draft (Key / URL / text) while `dirty`; leaving the page then asks first. */
export const useLeaveGuard = (id: string, dirty: boolean) => {
  useEffect(() => {
    if (dirty) drafts.add(id);
    else drafts.delete(id);
    return () => void drafts.delete(id);
  }, [id, dirty]);
};

const pathOf = (url: string) => (url.split('#')[1] ?? '').split('?')[0];

// Registered when this module loads, before any page listens: a hash change away from a page with drafts is put
// back at once (the page never sees it), then confirmed; 放弃修改 goes on to where you were going.
if (typeof window !== 'undefined')
  window.addEventListener('hashchange', (e) => {
    if (!drafts.size || asking || pathOf(e.oldURL) === pathOf(e.newURL)) return;
    const target = e.newURL;
    history.replaceState(history.state, '', e.oldURL);
    asking = true;
    confirmModal({
      cancelText: '留在这里',
      content: '这一页有没保存的修改（Key、地址或文字）。离开后这些修改会丢失。',
      okText: '放弃修改',
      onCancel: () => {
        asking = false;
      },
      onOk: () => {
        asking = false;
        drafts.clear();
        location.href = target;
      },
      title: '放弃未保存的修改？',
    });
  });
