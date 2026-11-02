/** Every settings page (P-05): PageHeader + SettingsForm cards from the schema + page extras. */
import { Alert, Button, Flexbox, Table, Tag, Text, toast } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { api, reasonText } from '../api';
import { ask } from '../fields';
import { ResetPageButton, SettingsForm } from '../SettingsForm';
import { useStore } from '../store';

const Header = ({ page, action }: { action?: ReactNode; page: string }) => {
  const { schema } = useStore();
  const p = schema.pages[page];
  return (
    <PageHeader
      action={
        <Flexbox gap={8} horizontal>
          {action}
          <ResetPageButton page={page} />
        </Flexbox>
      }
      description={p?.description}
      title={p?.title ?? page}
    />
  );
};

const Row = ({ label, children }: { children: ReactNode; label: string }) => (
  <Flexbox align="baseline" gap={12} horizontal>
    <Text style={{ flex: 'none', width: 120 }} type="secondary">
      {label}
    </Text>
    <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
  </Flexbox>
);

const on = (b: boolean) => <Tag color={b ? 'success' : undefined}>{b ? '开' : '关'}</Tag>;

const UPDATE_TEXT: Record<string, string> = {
  checking: '正在检查…',
  disabled: '开发版（从源码运行）不会自动更新',
  downloading: '正在下载新版本…',
  error: '检查失败',
  idle: '还没检查过',
  latest: '已是最新版本',
  manual: '需要手动下载新版本',
  ready: '新版本已下载，重启即可更新',
};

// ---- plain settings pages ---------------------------------------------------------------------------------
export const SimpleSettingsPage = ({ page }: { page: string }) => (
  <>
    <Header page={page} />
    <SettingsForm page={page} />
  </>
);

// ---- 桌宠行为 ---------------------------------------------------------------------------------------------
/** The schema cards plus 找回桌宠 (⋯ → 回到右下角 / the tray's 显示桌宠, for a pet covered or off screen). */
export const BehaviorPage = () => {
  const { view } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Header page="behavior" />
      <SettingsForm page="behavior" />
      <Surface description="她被窗口挡住、跑到屏幕外，或者换了显示器找不到时：让她出现并回到主屏幕右下角（同桌宠窗口 ⋯ → 回到右下角）。" title="位置">
        <Flexbox horizontal>
          <Button
            data-place-pet
            disabled={!view}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api().placePet();
                if (r && r.ok) toast.success('她回到右下角了');
                else toast.error(reasonText(r));
              } finally {
                setBusy(false);
              }
            }}
          >
            找回桌宠（回到右下角）
          </Button>
        </Flexbox>
      </Surface>
    </>
  );
};

// ---- 朗读 -------------------------------------------------------------------------------------------------
export const TtsPage = () => {
  const { settings, merge } = useStore();
  const st = settings.ttsStatus;
  const eng = (id: string) => {
    const e = st?.engines?.[id];
    if (!e) return null;
    return (
      <Flexbox gap={4} horizontal>
        <Tag color={e.ready ? 'success' : undefined}>{e.ready ? '可用' : '未就绪'}</Tag>
        {e.lastError && <Tag color="error">上次失败：{e.lastError}</Tag>}
      </Flexbox>
    );
  };
  return (
    <>
      <Header page="tts" />
      {!settings.prefs?.voice && <Alert title="朗读关着：打开「朗读回复」后，下面的引擎设置才会用上。" type="info" />}
      <SettingsForm extra={{ 'Fish Audio': eng('fish'), MiniMax: eng('minimax'), 本地语音服务: eng('local') }} page="tts" />
      <Surface
        extra={
          <Button
            icon={Trash2}
            onClick={async () => {
              if (!(await ask('清空语音缓存？', '下次朗读同一句话时会重新请求引擎。', '清空缓存', true))) return;
              const s = await api().ttsClearCache();
              merge({ settings: s });
              toast.success('语音缓存已清空');
            }}
            size="small"
          >
            清空缓存
          </Button>
        }
        title="缓存与统计"
      >
        <Flexbox gap={8}>
          <Row label="缓存">{st ? `${st.cache.count} 条 · ${(st.cache.bytes / 1024 / 1024).toFixed(1)} MB` : '--'}</Row>
          <Row label="Key 存储">{st ? (st.encrypted ? '系统加密（safeStorage）' : '本机文件（权限 0600）') : '--'}</Row>
          <Row label="语音包命中">{st?.stats?.packHits ?? 0} 次</Row>
        </Flexbox>
      </Surface>
    </>
  );
};

// ---- 语音输入 ---------------------------------------------------------------------------------------------
export const AsrPage = () => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  return (
    <>
      <Header
        action={
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(await api().asrTest());
              } finally {
                setBusy(false);
              }
            }}
          >
            测试连接
          </Button>
        }
        page="asr"
      />
      {result && (
        <Alert
          closable
          description={(result.results ?? []).map((r: any) => `${r.provider}：${r.ok ? `可用（${r.ms} ms）` : r.reason}`).join('；') || reasonText(result)}
          onClose={() => setResult(null)}
          title={result.ok ? '连接正常' : '连接没有成功'}
          type={result.ok ? 'success' : 'warning'}
        />
      )}
      <SettingsForm page="asr" />
    </>
  );
};

// ---- 语音包 -----------------------------------------------------------------------------------------------
export const VoicePacksPage = () => {
  const { settings, roster, merge } = useStore();
  const [errors, setErrors] = useState<string[]>([]);
  const packs: any[] = settings.ttsStatus?.packs ?? [];
  return (
    <>
      <PageHeader
        action={
          <Flexbox gap={8} horizontal>
            <Button icon={FolderOpen} onClick={() => api().openVoicePacksFolder()}>
              打开文件夹
            </Button>
            <Button
              icon={RefreshCw}
              onClick={async () => {
                const r = await api().reloadVoicePacks();
                merge({ settings: r.settings });
                setErrors(r.errors);
                toast.success(`已重新读取：${(r.settings.ttsStatus?.packs ?? []).length} 个语音包`);
              }}
            >
              重新读取
            </Button>
          </Flexbox>
        }
        description="提前录好的台词：命中时直接播放，不用请求引擎。自定义语音包放在数据目录的 voicepacks 里，同一个角色时覆盖内置的。"
        title="语音包"
      />
      {errors.length > 0 && <Alert description={errors.join('\n')} title="有语音包没读进来" type="warning" />}
      <Surface bleed title={`共 ${packs.length} 个`}>
        <Table
          columns={[
            { key: 'c', render: (_: unknown, p: any) => roster.find((c) => c.id === p.character)?.nameZh ?? p.character, title: '角色', width: 100 },
            { dataIndex: 'name', key: 'name', title: '名称' },
            { dataIndex: 'engine', key: 'engine', render: (v: string) => <Tag>{v}</Tag>, title: '引擎', width: 110 },
            { dataIndex: 'lines', key: 'lines', render: (v: number) => `${v} 句`, title: '句数', width: 90 },
            { dataIndex: 'builtIn', key: 'b', render: (v: boolean) => (v ? '内置' : '自定义'), title: '来源', width: 90 },
            { dataIndex: 'credit', key: 'credit', render: (v: string) => <Text ellipsis fontSize={12} type="secondary">{v || '--'}</Text>, title: '署名', width: 220 },
          ]}
          dataSource={packs}
          pagination={false}
          rowKey="id"
        />
      </Surface>
    </>
  );
};

// ---- LobeHub 与本机 ---------------------------------------------------------------------------------------
export const ConnectionPage = () => {
  const { view, merge } = useStore();
  const [who, setWho] = useState<any>(undefined);
  useEffect(() => {
    api().whoami().then(setWho, () => setWho(null));
  }, []);
  return (
    <>
      <Header page="connection" />
      <Surface title="LobeHub 账号">
        <Flexbox gap={8}>
          <Row label="登录">{who === undefined ? '读取中…' : who ? `${who.username || who.name || who.email || who.id || '已登录'}` : '未登录（唤醒时会引导登录）'}</Row>
          <Row label="空间">{view?.space ? (view.space.personal ? '个人空间' : view.space.name) : '--'}（唤醒时选定，之后不能改）</Row>
        </Flexbox>
      </Surface>
      <SettingsForm page="connection" />
      <Surface title="话题">
        <Flexbox align="center" gap={12} horizontal justify="space-between">
          <Text type="secondary">让当前角色在一个新的 LobeHub 话题里继续。旧话题保留在 LobeHub，好感和聊天记录不变。</Text>
          <Button
            disabled={!view}
            onClick={async () => {
              const r = await api().newTopic();
              if (r && r.view) merge({ view: r.view });
              if (r && r.ok) toast.success('下一句会开一个新话题');
              else toast.error(reasonText(r));
            }}
          >
            重新开始话题
          </Button>
        </Flexbox>
      </Surface>
    </>
  );
};

// ---- 对外接口 ---------------------------------------------------------------------------------------------
export const ApiPage = () => {
  const { apiStatus, settings } = useStore();
  return (
    <>
      <Header page="api" />
      <SettingsForm
        extra={{ '对外接口（本机 HTTP）': <Tag color={apiStatus?.listening ? 'success' : undefined}>{apiStatus?.listening ? `监听中 127.0.0.1:${apiStatus.port}` : apiStatus?.error ? `没有启动：${apiStatus.error}` : '未监听'}</Tag> }}
        page="api"
      />
      <Surface title="怎么用">
        <Flexbox gap={4}>
          <Text code>{`curl -H "Authorization: Bearer <令牌>" http://127.0.0.1:${settings.api?.port ?? 7340}/state`}</Text>
          <Text fontSize={12} type="secondary">
            路由：GET /state · POST /say · POST /anim · POST /throw · POST /chat。只接受本机请求。
          </Text>
        </Flexbox>
      </Surface>
    </>
  );
};

// ---- 内容与安全 -------------------------------------------------------------------------------------------
export const SafetyPage = () => (
  <>
    <Header page="safety" />
    <SettingsForm internal page="safety" />
    <Surface title="内容规则（不开放配置）">
      <Flexbox gap={4}>
        <Text type="secondary">· 对话不含露骨内容：内容防线和 system role 里的红线是写死的。</Text>
        <Text type="secondary">· Q 版角色和全年龄角色不会出现 18+ 外观。</Text>
        <Text type="secondary">· VRM 模型按授权限制：禁止性表现的模型不能用于 18+，不能再分发的模型不能导出。</Text>
      </Flexbox>
    </Surface>
  </>
);

// ---- 版本与更新 -------------------------------------------------------------------------------------------
export const UpdatePage = () => {
  const { update, version } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Header page="update" />
      <SettingsForm page="update" />
      <Surface title="版本">
        <Flexbox gap={12}>
          <Row label="当前版本">
            <Text code>{version}</Text>
          </Row>
          <Row label="状态">{UPDATE_TEXT[update?.status] ?? update?.status ?? '--'}{update?.version ? ` · ${update.version}` : ''}</Row>
          {update?.checkedAt && <Row label="上次检查">{new Date(update.checkedAt).toLocaleString('zh-CN')}</Row>}
          <Flexbox gap={8} horizontal>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api().checkUpdate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              检查更新
            </Button>
            {update?.status === 'ready' && (
              <Button onClick={() => api().installUpdate()} type="primary">
                立即更新
              </Button>
            )}
            {/* can't replace itself here (Linux, a translocated Mac…): the release page in the browser */}
            {update?.status === 'manual' && (
              <Button data-update-download onClick={() => api().installUpdate()} type="primary">
                下载新版本{update?.version ? ` v${update.version}` : ''}
              </Button>
            )}
          </Flexbox>
        </Flexbox>
      </Surface>
    </>
  );
};

// ---- 数据与关于 -------------------------------------------------------------------------------------------
export const AboutPage = () => {
  const { roster, merge, dataDir } = useStore();
  const release = async (deleteAgent: boolean) => {
    const ok = await ask(
      deleteAgent ? '放生并删除 agent？' : '仅重置本地？',
      deleteAgent ? '会删除本机进度和聊天记录，并在 LobeHub 里删除每位角色的 agent（含 LobeHub 里的聊天记录）。设置和导入的角色包保留。' : '只删除本机的进度和聊天记录，LobeHub 里的 agent 保留。设置和导入的角色包保留。',
      deleteAgent ? '放生并删除 agent' : '仅重置本地',
      true,
    );
    if (!ok) return;
    const r = await api().release({ deleteAgent });
    merge(await api().state());
    toast.success(deleteAgent ? `已放生，删除了 ${r?.deleted ?? 0} 个 agent` : '已重置本地进度');
  };
  return (
    <>
      <Header page="about" />
      <SettingsForm page="about" />
      <Surface description="settings.json（全部设置）、pet.json（进度与好感）、导入的角色包、语音缓存和错误日志都在这里。启动时用环境变量 PIXELPET_DATA_DIR 可以换一个目录（需要重启）。" title="数据目录">
        <Flexbox gap={12}>
        <Row label="位置">
          <Text code data-data-dir>
            {dataDir ?? '--'}
          </Text>
        </Row>
        <Flexbox gap={8} horizontal wrap="wrap">
          <Button data-open-data-dir icon={FolderOpen} onClick={() => api().openDataFolder()}>
            打开数据目录
          </Button>
          <Button icon={FolderOpen} onClick={() => api().openLog()}>
            打开错误日志
          </Button>
          <Button icon={FolderOpen} onClick={() => api().openPacksFolder()}>
            角色包文件夹
          </Button>
          <Button icon={FolderOpen} onClick={() => api().openVoicePacksFolder()}>
            语音包文件夹
          </Button>
        </Flexbox>
        </Flexbox>
      </Surface>
      <Surface title="素材署名">
        <Flexbox gap={8}>
          {roster.map((c) => (
            <Flexbox gap={2} key={c.id}>
              <Text strong>{c.nameZh}</Text>
              {c.credits.map((x) => (
                <Text fontSize={12} key={x} type="secondary">
                  {x}
                </Text>
              ))}
            </Flexbox>
          ))}
        </Flexbox>
      </Surface>
      <Surface description="不能撤销。设置（settings.json）和导入的角色包都会保留。" title="危险操作">
        <Flexbox gap={8} horizontal>
          <Button danger onClick={() => release(false)}>
            仅重置本地
          </Button>
          <Button danger onClick={() => release(true)}>
            放生并删除 agent
          </Button>
        </Flexbox>
      </Surface>
    </>
  );
};
