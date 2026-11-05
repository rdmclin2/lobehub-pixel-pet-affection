/**
 * 设置 → LobeHub 与本机 → 文件夹与系统权限 (T-5075, main/permissions.js, docs/permissions.md).
 * Drawn like LobeHub Desktop's onboarding permissions step (src/features/DesktopOnboarding/steps/PermissionsStep.tsx):
 * one outlined Block of rows — a 40px outlined icon box, title, secondary hint, and on the right a check (granted),
 * a spinner (the system prompt is open) or a small action; a granted row is tinted. macOS permissions one at a time
 * (麦克风 for 语音输入; with 本机能力 on also 下载 / 桌面 / 文稿), then the folders her local tools may use and
 * 允许运行命令. On Linux / Windows with 本机能力 off the card is not drawn at all.
 */
import { ActionIcon, Alert, Block, Button, Flexbox, Icon, Switch, Text, cssVar, toast } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import type { LucideIcon } from 'lucide-react';
import { Check, FileText, Folder, FolderDown, FolderOpen, FolderPlus, Loader2Icon, Mic, Monitor, Terminal, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { api, type PermStatus } from '../api';
import { ask } from '../fields';
import { useStore } from '../store';

const META: Record<string, { desc: string; icon: LucideIcon }> = {
  desktop: { desc: '让她读桌面上的文件，授权后自动加入下面的列表', icon: Monitor },
  documents: { desc: '让她读“文稿”里的文件，授权后自动加入下面的列表', icon: FileText },
  downloads: { desc: '让她读你放在“下载”里的文件，授权后自动加入下面的列表', icon: FolderDown },
  microphone: { desc: '用于语音输入：按住说话时才录音', icon: Mic },
};
// what the hint says instead, by state (granted keeps the plain description)
const HINT: Record<string, string> = {
  denied: '已拒绝：只能在系统设置里打开',
  missing: '这台电脑上没有这个文件夹',
  pending: '在系统弹窗中选择允许',
  restricted: '受系统限制：只能在系统设置里打开',
};

const IconBox = ({ icon }: { icon: LucideIcon }) => (
  <Block align="center" height={40} justify="center" style={{ flex: 'none' }} variant="outlined" width={40}>
    <Icon color={cssVar.colorTextDescription} icon={icon} size={20} />
  </Block>
);

/** One row of the list: icon box, title + hint, and what goes on the right. */
const Row = ({ icon, title, hint, hintColor, right, tinted, onClick, ...data }: { [k: `data-${string}`]: string; hint: ReactNode; hintColor?: string; icon: LucideIcon; onClick?: () => void; right?: ReactNode; tinted?: 'granted' | 'pending'; title: ReactNode }) => (
  <Block
    align="center"
    clickable={!!onClick}
    gap={16}
    horizontal
    onClick={onClick}
    paddingBlock={8}
    paddingInline={12}
    style={{
      background: tinted === 'granted' ? cssVar.colorFillSecondary : tinted === 'pending' ? cssVar.colorPrimaryBg : undefined,
      boxShadow: tinted === 'pending' ? `inset 0 0 0 1px ${cssVar.colorPrimaryBorder}` : undefined,
    }}
    variant="borderless"
    {...data}
  >
    <IconBox icon={icon} />
    <Flexbox gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Text weight={500}>{title}</Text>
      <Text color={hintColor ?? cssVar.colorTextSecondary} fontSize={12}>
        {hint}
      </Text>
    </Flexbox>
    {right}
  </Block>
);

const PermRow = ({ kind, label, state, onChange }: { kind: string; label: string; onChange: (s: PermStatus) => void; state: string }) => {
  const [busy, setBusy] = useState(false);
  const shown = busy ? 'pending' : state;
  const refused = shown === 'denied' || shown === 'restricted';
  const actionable = !refused && !['granted', 'missing', 'pending'].includes(shown);
  const request = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api().permRequest(kind);
      onChange(r);
      if (r.result === 'granted') toast.success(`${label}：已授权`);
      else if (r.result) toast.info(`${label}：没有授权，可以之后去系统设置里打开`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      data-perm={kind}
      data-state={shown}
      hint={HINT[shown] ?? META[kind].desc}
      hintColor={refused ? cssVar.colorError : undefined}
      icon={META[kind].icon}
      onClick={actionable ? request : undefined}
      right={
        shown === 'granted' ? (
          <Icon aria-label="已授权" color={cssVar.colorSuccess} icon={Check} size={20} />
        ) : shown === 'pending' ? (
          <Flexbox align="center" gap={6} horizontal style={{ color: cssVar.colorPrimaryText, flex: 'none', fontSize: 13 }}>
            <Icon icon={Loader2Icon} size={14} spin />
            等待授权
          </Flexbox>
        ) : refused ? (
          <Button
            data-perm-settings={kind}
            onClick={(e) => {
              e.stopPropagation();
              api().permOpenSettings(kind);
            }}
            size="small"
          >
            去系统设置
          </Button>
        ) : actionable ? (
          <Button
            data-perm-ask={kind}
            onClick={(e) => {
              e.stopPropagation();
              request();
            }}
            size="small"
          >
            授权
          </Button>
        ) : null
      }
      tinted={shown === 'granted' ? 'granted' : shown === 'pending' ? 'pending' : undefined}
      title={label}
    />
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
      <Flexbox gap={12}>
        {view?.local?.warning && <Alert title={view.local.warning} type="warning" />}
        {localOn && !limited && <Alert title="目前不限制：她能读写你账号能访问的所有文件。添加第一个文件夹后，就只能用列表里的文件夹。" type="warning" />}
        {st.mac && (
          <Block gap={4} padding={4} variant="outlined">
            <PermRow kind="microphone" label="麦克风" onChange={setSt} state={st.mic ?? 'unknown'} />
            {localOn && st.folders.map((f) => <PermRow key={f.id} kind={f.id} label={`“${f.label}”文件夹`} onChange={setSt} state={f.status} />)}
          </Block>
        )}
        {localOn && (
          <Block gap={4} padding={4} variant="outlined">
            <Row
              hint="她的本机工具只能读写这些文件夹（软链接和 .. 会先解析）。你拖给她的文件不受限制，只能读。"
              icon={FolderOpen}
              right={
                <Button data-folders-add icon={FolderPlus} onClick={async () => setSt(await api().aiFoldersAdd())} size="small">
                  添加文件夹
                </Button>
              }
              title="AI 可读的文件夹"
            />
            <Flexbox gap={0} style={{ paddingBottom: 4, paddingInline: '68px 12px' }}>
              {limited && folders.length === 0 && (
                <Text fontSize={12} style={{ lineHeight: '28px' }} type="secondary">
                  还没有文件夹：她暂时读不了任何文件
                </Text>
              )}
              {folders.map((f) => (
                <Flexbox align="center" data-folder={f} gap={8} horizontal key={f} style={{ minHeight: 28 }}>
                  <Icon color={cssVar.colorTextDescription} icon={Folder} size={14} />
                  <Text ellipsis fontSize={13} style={{ flex: 1, minWidth: 0 }}>
                    {f}
                  </Text>
                  <ActionIcon icon={X} onClick={async () => setSt(await api().aiFoldersSet({ remove: f }))} size="small" title={`移除 ${f}`} />
                </Flexbox>
              ))}
            </Flexbox>
            {limited && (
              <Row
                hint="命令的工作目录必须在上面的文件夹里，但命令本身不受文件夹限制，能访问你账号能访问的所有文件。"
                icon={Terminal}
                right={
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
                }
                title="允许运行命令"
              />
            )}
          </Block>
        )}
      </Flexbox>
    </Surface>
  );
};
