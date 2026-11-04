/**
 * 设置 → LobeHub 与本机 → 文件夹与系统权限 (T-5075, main/permissions.js, docs/permissions.md).
 * The same rows as the onboarding's 授权 page: macOS permissions one at a time (麦克风 for 语音输入; with 本机能力 on
 * also 下载 / 桌面 / 文稿), then the folders her local tools may use and 允许运行命令. Shown only when there is
 * something to show: on Linux / Windows with 本机能力 off the card is not drawn at all.
 */
import { ActionIcon, Alert, Button, Empty, Flexbox, Switch, Tag, Text, toast } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { FolderPlus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, type PermStatus } from '../api';
import { ask } from '../fields';
import { useStore } from '../store';

type TagColor = 'error' | 'success' | 'warning' | undefined;
const STATE: Record<string, { color: TagColor; text: string }> = {
  denied: { color: 'error', text: '已拒绝' },
  granted: { color: 'success', text: '已授权' },
  missing: { color: undefined, text: '找不到这个文件夹' },
  'not-determined': { color: undefined, text: '未授权' },
  restricted: { color: 'warning', text: '受系统限制' },
  unknown: { color: undefined, text: '未授权 / 未知' },
};
const DESC: Record<string, string> = {
  desktop: '让她读桌面上的文件。授权后自动加入下面的列表。',
  documents: '让她读“文稿”里的文件。授权后自动加入下面的列表。',
  downloads: '让她读你放在“下载”里的文件。授权后自动加入下面的列表。',
  microphone: '语音输入要用。只在你按住说话时录音。',
};

const PermRow = ({ kind, label, state, onChange }: { kind: string; label: string; onChange: (s: PermStatus) => void; state: string }) => {
  const [busy, setBusy] = useState(false);
  const s = STATE[state] ?? STATE.unknown;
  const refused = state === 'denied' || state === 'restricted';
  return (
    <Flexbox align="center" data-perm={kind} data-state={state} gap={12} horizontal>
      <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
        <Text weight={500}>{label}</Text>
        <Text fontSize={12} type="secondary">
          {DESC[kind]}
        </Text>
      </Flexbox>
      <Tag color={s.color}>{s.text}</Tag>
      {refused && (
        <Button data-perm-settings={kind} onClick={() => api().permOpenSettings(kind)} size="small">
          去系统设置
        </Button>
      )}
      {!refused && state !== 'granted' && state !== 'missing' && (
        <Button
          data-perm-ask={kind}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api().permRequest(kind);
              onChange(r);
              if (r.result === 'granted') toast.success(`${label}：已授权`);
              else if (r.result) toast.info(`${label}：没有授权，可以之后去系统设置里打开`);
            } finally {
              setBusy(false);
            }
          }}
          size="small"
        >
          授权
        </Button>
      )}
    </Flexbox>
  );
};

export const PermissionsCard = () => {
  const { view, settings } = useStore();
  const [st, setSt] = useState<PermStatus | null>(null);
  const refresh = useCallback(() => {
    api().permStatus().then(setSt, () => setSt(null));
  }, []);
  // again when the list changes elsewhere (the pet window's 授权 page) or the owner comes back from System Settings
  const localKey = JSON.stringify(settings.local ?? null);
  useEffect(refresh, [refresh, localKey, view?.local?.enabled]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  if (!st) return null;
  const localOn = !!view?.local?.enabled;
  if (!st.mac && !localOn) return null;
  const { folders, limited, allowCommands } = st.local;
  return (
    <Surface data-card="permissions" title="文件夹与系统权限">
      <Flexbox gap={16}>
        {st.mac && (
          <Flexbox gap={12}>
            <PermRow kind="microphone" label="麦克风" onChange={setSt} state={st.mic ?? 'unknown'} />
            {localOn && st.folders.map((f) => <PermRow key={f.id} kind={f.id} label={`“${f.label}”文件夹`} onChange={setSt} state={f.status} />)}
          </Flexbox>
        )}
        {localOn && (
          <Flexbox gap={8}>
            <Flexbox align="center" gap={12} horizontal>
              <Flexbox flex={1} gap={2}>
                <Text weight={500}>AI 可读的文件夹</Text>
                <Text fontSize={12} type="secondary">
                  她的本机工具只能读写这些文件夹（软链接和 .. 会先解析）。你拖给她的文件不受这个限制，只能读。
                </Text>
              </Flexbox>
              <Button data-folders-add icon={FolderPlus} onClick={async () => setSt(await api().aiFoldersAdd())} size="small">
                添加文件夹…
              </Button>
            </Flexbox>
            {view?.local?.warning && <Alert title={view.local.warning} type="warning" />}
            {!limited && <Alert title="目前不限制：她能读写你账号能访问的所有文件。添加第一个文件夹后，就只能用列表里的文件夹。" type="warning" />}
            {limited && folders.length === 0 && <Empty description="还没有文件夹：她暂时读不了任何文件。" />}
            {folders.map((f) => (
              <Flexbox align="center" data-folder={f} gap={8} horizontal key={f}>
                <Text code ellipsis style={{ flex: 1, minWidth: 0 }}>
                  {f}
                </Text>
                <ActionIcon icon={X} onClick={async () => setSt(await api().aiFoldersSet({ remove: f }))} size="small" title={`移除 ${f}`} />
              </Flexbox>
            ))}
          </Flexbox>
        )}
        {localOn && limited && (
          <Flexbox align="center" gap={12} horizontal>
            <Flexbox flex={1} gap={2}>
              <Text weight={500}>允许运行命令</Text>
              <Text fontSize={12} type="secondary">
                命令的工作目录必须在上面的文件夹里，但命令本身不受文件夹限制，能访问你账号能访问的所有文件。
              </Text>
            </Flexbox>
            <Switch
              aria-label="允许运行命令"
              checked={allowCommands}
              data-key="local.allowCommands"
              onChange={async (next: boolean) => {
                if (next && !(await ask('允许她运行命令？', '命令不受文件夹限制，能访问你账号能访问的所有文件。只在你信任当前模型和设定时打开。', '允许运行命令', true))) return;
                setSt(await api().aiFoldersSet({ allowCommands: next }));
                toast.success(`允许运行命令：${next ? '开' : '关'}`);
              }}
            />
          </Flexbox>
        )}
      </Flexbox>
    </Surface>
  );
};
