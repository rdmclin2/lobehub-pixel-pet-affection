/** Every settings page (P-05): PageHeader + SettingsForm cards from the schema + page extras. */
import { Accordion, Alert, Button, Empty, Flexbox, Table, Tag, Text, toast } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { FolderOpen, LogOut, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { api, reasonText } from '../api';
import { askAsync, NoPet } from '../common';
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

// ---- plain settings pages ---------------------------------------------------------------------------------
export const SimpleSettingsPage = ({ page }: { page: string }) => (
  <>
    <Header page={page} />
    <SettingsForm page={page} />
  </>
);

// ---- 主动搭话与好感 ---------------------------------------------------------------------------------------
/** C05 / INT-01: 主动行为 + 好感度 only; 插个嘴 (its cards and both tables) is its own page `#/interject` (pages/Interject.tsx). */
export const ProactivePage = () => <SimpleSettingsPage page="proactive" />;

// ---- 桌宠行为 ---------------------------------------------------------------------------------------------
/** C11 / TOG-04: just the schema cards; 找回桌宠 lives once, in 和她互动 → 桌面上的她 (pages/Together.tsx). */
export const BehaviorPage = () => <SimpleSettingsPage page="behavior" />;

// ---- 朗读与音效 ---------------------------------------------------------------------------------------------
const ENGINE_NAME: Record<string, string> = { elevenlabs: 'ElevenLabs', fish: 'Fish Audio', local: '本地语音服务', minimax: 'MiniMax' };
/** schema card of each engine's own settings */
const ENGINE_CARD: Record<string, string> = { elevenlabs: 'ElevenLabs', fish: 'Fish Audio', local: '本地语音服务', minimax: 'MiniMax' };
const ENGINES = ['fish', 'minimax', 'elevenlabs', 'local'];
const TTS_REASON: Record<string, string> = {
  'no-key': '没有 Key：在下面填上这个引擎的 API Key',
  'no-endpoint': '没有地址：填上本地语音服务的地址',
  'no-voice': '她在这个引擎上没有配音色',
  'no-pet': '桌宠还没唤醒，没有角色可以试听',
  timeout: '超时：检查端点是否可访问，或换回官方地址',
  network: '连不上：检查网络或端点地址',
  auth: 'Key 无效：检查是否复制完整',
  'rate-limit': '请求太频繁：等一分钟再试',
  quota: '额度用完了：到引擎后台看看余额',
  system: '现在选的是系统语音，不经过引擎',
  fallback: '没有能用的引擎',
};
const ttsReason = (r: any) => (r?.tried?.length ? r.tried.map((t: string) => t.replace(/：(\S+)$/, (_m: string, k: string) => `：${TTS_REASON[k] ?? k}`)).join('；') : TTS_REASON[r?.reason] ?? reasonText(r));

/**
 * 试听 (A14 / PG-02, P-05「用户在决定：改完是否生效」): one fixed line through the engine the settings pick, played
 * here; the result is written in the 引擎 card — 「可用 · 820 ms」 or why not and what to do.
 */
const TtsTry = ({ onResult }: { onResult: (r: { ok: boolean; text: string }) => void }) => {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      data-tts-test
      icon={Play}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api().ttsTest();
          if (r.ok && r.audio) {
            const url = URL.createObjectURL(new Blob([r.audio as BlobPart], { type: r.mime || 'audio/mpeg' }));
            const a = new Audio(url);
            a.onended = () => URL.revokeObjectURL(url);
            a.play().catch(() => {});
          }
          onResult(r.ok ? { ok: true, text: `可用 · ${r.label} · ${r.cached ? '缓存命中' : `${r.latencyMs} ms`}` } : { ok: false, text: `失败：${ttsReason(r)}` });
        } catch (e) {
          onResult({ ok: false, text: `失败：${String((e as Error).message ?? e)}` });
        } finally {
          setBusy(false);
        }
      }}
      size="small"
    >
      试听
    </Button>
  );
};

/**
 * A13 (PG-01, P-05「关闭的功能也铺满配置项」, M-08): 声音 → 引擎 → only the engine that reads now (for 自动, the
 * one her character uses) → the others folded, one line each with its Key state → 缓存与统计.
 */
export const TtsPage = () => {
  const { settings, merge, roster } = useStore();
  const st = settings.ttsStatus;
  const cur = roster.find((c) => c.current);
  const picked: string = settings.tts?.provider ?? 'auto';
  // 自动 = her character's own engine (core/tts.js defaultEngine)
  const auto = picked === 'auto';
  const active = auto ? ((cur?.voice?.tts as any)?.default && ENGINES.includes((cur?.voice?.tts as any).default) ? (cur!.voice!.tts as any).default : 'fish') : picked;
  const activeCard = ENGINE_CARD[active];
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const eng = (id: string) => {
    const e = st?.engines?.[id];
    if (!e) return null;
    // Cloud engines need a key; the local one is ready once it has an address (its key is optional).
    const noKey = id !== 'local' && !e.hasKey;
    return (
      <Flexbox gap={4} horizontal>
        <Tag color={e.ready ? 'success' : noKey ? 'warning' : undefined}>{e.ready ? '可用' : noKey ? '未设置 Key' : '未就绪'}</Tag>
        {e.lastError && <Tag color="error">上次失败：{TTS_REASON[e.lastError] ?? e.lastError}</Tag>}
      </Flexbox>
    );
  };
  const others = ENGINES.filter((id) => ENGINE_CARD[id] !== activeCard);
  return (
    <>
      <Header page="tts" />
      <SettingsForm page="tts" cards={['声音']} />
      {!settings.prefs?.voice && <Alert title="朗读关着：打开「朗读回复」后才会用到下面的引擎。" type="info" />}
      <SettingsForm
        after={{
          引擎: (
            <Flexbox data-engine-active={active} gap={4}>
              {auto && activeCard && (
                <Text fontSize={12} type="secondary">
                  {cur ? `${cur.met?.name ?? cur.nameZh}用的是 ${ENGINE_NAME[active]}，下面是它的设置。` : `自动：用角色自己的引擎（默认 ${ENGINE_NAME[active]}）。`}
                </Text>
              )}
              {active !== 'local' && st?.engines?.[active] && !st.engines[active].hasKey && (
                <Text data-engine-no-key fontSize={12} type="warning">
                  {ENGINE_NAME[active]} 还没设置 Key：在下方「{activeCard}」里填写 API Key 后才能用它朗读。
                </Text>
              )}
              {test && (
                <Text data-tts-test-result={test.ok ? 'ok' : 'fail'} fontSize={12} type={test.ok ? 'success' : 'danger'}>
                  试听{test.text}
                </Text>
              )}
            </Flexbox>
          ),
        }}
        cards={['引擎']}
        extra={{ 引擎: <TtsTry onResult={setTest} /> }}
        page="tts"
      />
      {activeCard && <SettingsForm cards={[activeCard]} extra={{ [activeCard]: eng(active) }} page="tts" />}
      {/* Accordion does not pass data-* through: the wrapper carries the hook */}
      <div data-other-engines>
        <Accordion
          items={[
          {
            children: (
              <SettingsForm cards={others.map((id) => ENGINE_CARD[id])} extra={Object.fromEntries(others.map((id) => [ENGINE_CARD[id], eng(id)]))} page="tts" />
            ),
            key: 'others',
            title: (
              <Flexbox gap={4}>
                <Text strong>其他引擎</Text>
                <Text fontSize={12} type="secondary">
                  {others.map((id) => `${ENGINE_NAME[id]} · ${id === 'local' ? (st?.engines?.local?.ready ? '已设置地址' : '未设置地址') : st?.engines?.[id]?.hasKey ? '已设置 Key' : '未设置 Key'}`).join('　')}
                </Text>
              </Flexbox>
            ),
          },
        ]}
          variant="outlined"
        />
      </div>
      <Surface
        extra={
          <Button
            data-clear-cache
            icon={Trash2}
            onClick={async () => {
              // A16 (PG-03 同批): runs in the dialog, answers with what main really did (S-7)
              const done = await askAsync({
                content: '下次朗读同一句话时会重新请求引擎。',
                danger: true,
                okText: '清空缓存',
                run: async () => {
                  const s = await api().ttsClearCache();
                  if (!s || !s.ttsStatus) return { ok: false, reason: reasonText(s) };
                  merge({ settings: s });
                  return { ok: true };
                },
                title: '清空语音缓存？',
              });
              if (done) toast.success({ id: 'tts-cache', title: '语音缓存已清空' });
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
/** A14 (PG-02): 测试连接 sits in the 语音输入 card and writes its result there (no closable page-top Alert). */
export const AsrPage = () => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  return (
    <>
      <Header page="asr" />
      <SettingsForm
        after={{
          语音输入: result ? (
            <Flexbox data-asr-test-result={result.ok ? 'ok' : 'fail'} gap={2}>
              <Text fontSize={12} strong type={result.ok ? 'success' : 'danger'}>
                {result.ok ? '连接正常' : '连接没有成功'}
              </Text>
              <Text fontSize={12} type="secondary">
                {(result.results ?? []).map((r: any) => `${r.provider}：${r.ok ? `可用（${r.ms} ms）` : r.reason}`).join('；') || reasonText(result)}
              </Text>
            </Flexbox>
          ) : undefined,
        }}
        extra={{
          语音输入: (
            <Button
              data-asr-test
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setResult(await api().asrTest());
                } catch (e) {
                  setResult({ ok: false, message: String((e as Error).message ?? e) });
                } finally {
                  setBusy(false);
                }
              }}
              size="small"
            >
              测试连接
            </Button>
          ),
        }}
        page="asr"
      />
    </>
  );
};

// ---- 语音包 -----------------------------------------------------------------------------------------------
/**
 * A19 (PG-08, W-04 首次使用): the empty state says where a pack goes and in what form, with the folder one click
 * away. 重新读取 reports only after main answered (S-4 / S-5). 导入语音包… is not in this round: it needs a new
 * file-copy IPC in main (02-plan §4 PG-08 部分不做).
 */
export const VoicePacksPage = () => {
  const { settings, roster, merge, dataDir } = useStore();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const packs: any[] = settings.ttsStatus?.packs ?? [];
  const where = `${dataDir ?? '数据目录'}/voicepacks`;
  return (
    <>
      <PageHeader
        action={
          <Flexbox gap={8} horizontal>
            <Button icon={FolderOpen} onClick={() => api().openVoicePacksFolder()}>
              打开文件夹
            </Button>
            <Button
              data-reload-voicepacks
              icon={RefreshCw}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const before = packs.length;
                try {
                  const r = await api().reloadVoicePacks();
                  merge({ settings: r.settings });
                  setErrors(r.errors);
                  const n = (r.settings.ttsStatus?.packs ?? []).length;
                  toast.success({ id: 'voicepacks', title: `已重新读取：${n} 个语音包${n > before ? `（新增 ${n - before} 个）` : ''}` });
                } catch (e) {
                  toast.error({ description: String((e as Error).message ?? e), title: '没能重新读取语音包' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              重新读取
            </Button>
          </Flexbox>
        }
        description="提前录好的台词：命中时直接播放，不用请求引擎。自定义语音包放在数据目录的 voicepacks 里，同一个角色时覆盖内置的。"
        title="语音包"
      />
      {errors.length > 0 && <Alert description={errors.join('\n')} title={`有 ${errors.length} 个语音包没读进来`} type="warning" />}
      <Surface bleed title={`共 ${packs.length} 个`}>
        <Table
          columns={[
            { key: 'c', render: (_: unknown, p: any) => roster.find((c) => c.base === p.character)?.nameZh ?? p.character, title: '角色', width: 100 },
            { dataIndex: 'name', key: 'name', title: '名称' },
            { dataIndex: 'engine', key: 'engine', render: (v: string) => <Tag>{v}</Tag>, title: '引擎', width: 110 },
            { dataIndex: 'lines', key: 'lines', render: (v: number) => `${v} 句`, title: '句数', width: 90 },
            { dataIndex: 'builtIn', key: 'b', render: (v: boolean) => (v ? '内置' : '自定义'), title: '来源', width: 90 },
            { dataIndex: 'credit', key: 'credit', render: (v: string) => <Text ellipsis fontSize={12} type="secondary">{v || '--'}</Text>, title: '署名', width: 220 },
          ]}
          dataSource={packs}
          locale={{
            emptyText: (
              <Empty
                action={
                  <Button icon={FolderOpen} onClick={() => api().openVoicePacksFolder()} type="primary">
                    打开 voicepacks 文件夹
                  </Button>
                }
                data-voicepacks-empty
                description={`把语音包文件夹（里面有 manifest.json 和音频文件）放进 ${where}，再点「重新读取」。`}
                title="还没有语音包"
              />
            ),
          }}
          pagination={false}
          rowKey="id"
        />
      </Surface>
    </>
  );
};

// ---- 账号与连接 (A04 / PG-05: only the account and space; 本机能力 is on 成人向与本机能力) ----
export const ConnectionPage = () => {
  const { view } = useStore();
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
      {/* 重新开始对话 moved to 聊天 → ⋯ (C04 / HUB-03); 本机能力 to 成人向与本机能力 (A04 / PG-05) */}
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

// ---- 成人向与本机能力 (A04 / HUB-02: both high-risk switches, then the fixed rules) ----
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
const RELEASES = 'https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases';
const when = (t?: number) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? '刚刚检查' : s < 3600 ? `${Math.round(s / 60)} 分钟前检查` : `${new Date(t).toLocaleString('zh-CN')} 检查`;
};

/**
 * A15 (PG-04, W-05): the result of 检查更新 is a line in the 版本 card that says what happened, when, and what you
 * can do next — 已是最新 / 发现新版本 / 下载新版本 / 没能检查 + 原因 + 重试 + 打开下载页.
 */
const UpdateResult = ({ busy, onRetry }: { busy: boolean; onRetry: () => void }) => {
  const { update, version } = useStore();
  const s: string = update?.status ?? 'idle';
  if (busy || s === 'checking') return <Text data-update-result="checking" type="secondary">正在检查…</Text>;
  const at = when(update?.checkedAt);
  const line: Record<string, { text: string; type?: 'danger' | 'secondary' | 'success' | 'warning' }> = {
    disabled: { text: '开发版（从源码运行）不检查更新', type: 'secondary' },
    downloading: { text: `发现 v${update?.version}，正在后台下载`, type: 'warning' },
    error: { text: `没能检查更新${update?.error ? `：${update.error}` : ''}。检查网络能否打开 GitHub，或直接去下载页`, type: 'danger' },
    idle: { text: '上次检查：还没有检查过', type: 'secondary' },
    latest: { text: `已是最新版本 v${version}${at ? ` · ${at}` : ''}`, type: 'success' },
    manual: { text: `有新版本 v${update?.version}：这里不能自动替换，需要下载安装${update?.error ? `（${update.error}）` : ''}`, type: 'warning' },
    ready: { text: `v${update?.version} 已下载好，重启即可更新`, type: 'success' },
  };
  const l = line[s] ?? { text: s, type: 'secondary' };
  return (
    <Flexbox align="center" data-update-result={s} gap={8} horizontal wrap="wrap">
      <Text type={l.type}>{l.text}</Text>
      {s === 'error' && (
        <>
          <Button onClick={onRetry} size="small">
            重试
          </Button>
          <Button onClick={() => api().openLink(RELEASES)} size="small" type="text">
            打开下载页
          </Button>
        </>
      )}
    </Flexbox>
  );
};

export const UpdatePage = () => {
  const { update, version } = useStore();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      await api().checkUpdate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Header page="update" />
      <SettingsForm page="update" />
      <Surface title="版本">
        <Flexbox gap={12}>
          <Row label="当前版本">
            <Text code>{version}</Text>
          </Row>
          <Row label="检查结果">
            <UpdateResult busy={busy} onRetry={check} />
          </Row>
          <Flexbox gap={8} horizontal>
            <Button data-check-update loading={busy} onClick={check}>
              检查更新
            </Button>
            {update?.status === 'ready' && (
              <Button
                onClick={async () => {
                  // W-06: restarting loses what is unsent; say so before
                  if (await ask('现在重启并更新？', '应用会关闭再打开；还没发出去的消息会丢失。', '重启并更新')) api().installUpdate();
                }}
                type="primary"
              >
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

// ---- 关于与数据 -------------------------------------------------------------------------------------------
/**
 * A07 / A18 (SH-06, PG-07): 显示 (主题 + 硬件加速, from the schema) → 数据目录 (data dir and error log; the 角色包 /
 * 语音包 folders are on their own pages) → 素材署名, folded → 退出应用 (TOG-04 落位). The irreversible actions
 * moved to 隐私与安全 → 重置与放生 (A16).
 */
export const AboutPage = () => {
  const { roster, dataDir } = useStore();
  const bases = roster.filter((c, i, all) => all.findIndex((x) => x.base === c.base) === i);
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
          </Flexbox>
        </Flexbox>
      </Surface>
      <div data-credits>
      <Accordion
        items={[
          {
            children: (
              <Flexbox gap={8}>
                {bases.map((c) => (
                  <Flexbox gap={2} key={c.base}>
                    <Text strong>{c.nameZh}</Text>
                    {c.credits.map((x) => (
                      <Text fontSize={12} key={x} type="secondary">
                        {x}
                      </Text>
                    ))}
                  </Flexbox>
                ))}
              </Flexbox>
            ),
            key: 'credits',
            title: `素材署名（${bases.length} 位角色）`,
          },
        ]}
        variant="outlined"
      />
      </div>
      <Surface description="关掉桌宠和这个设置窗口。进度和设置都已保存，下次打开接着来。" title="退出应用">
        <div>
          <Button
            data-app-quit
            icon={LogOut}
            onClick={async () => {
              if (!(await ask('退出桌宠？', '桌宠和设置窗口都会关闭。进度和设置都已保存。', '退出', true))) return;
              await api().quit();
            }}
          >
            退出应用
          </Button>
        </div>
      </Surface>
    </>
  );
};

// ---- 重置与放生 -------------------------------------------------------------------------------------------
/**
 * A16 (PG-03 P0, PG-07, HUB-02): the two irreversible actions on a page whose name says so, each card saying what
 * goes and what stays. Confirmed and run in one dialog (askAsync, C-15): 进行中 until main answers, a failure
 * written in the dialog, success reported with the real outcome (how many agents were deleted).
 */
export const ResetPage = () => {
  const { merge, view } = useStore();
  const release = async (deleteAgent: boolean) => {
    const done = await askAsync({
      cancelText: '先不了',
      content: deleteAgent
        ? '会删除本机进度和聊天记录，并在 LobeHub 里删除每位角色的 agent（含 LobeHub 里的聊天记录）。设置和导入的角色包保留。不能撤销。'
        : '只删除本机的进度和聊天记录，LobeHub 里的 agent 保留。设置和导入的角色包保留。不能撤销。',
      danger: true,
      okText: deleteAgent ? '放生并删除 agent' : '仅重置本地',
      run: async () => {
        const r = await api().release({ deleteAgent });
        if (!r || r.ok === false) return { ok: false, reason: `${reasonText(r)}。本机数据没有改动` };
        merge(await api().state());
        if (!deleteAgent) return { done: '已重置本地：进度和聊天记录已清除', ok: true };
        const failed = r.failed ? `；${r.failed} 个没删掉，可以到 LobeHub 里手动删除` : '';
        return { done: `已放生：清除了本机进度和聊天记录，删除了 ${r.deleted ?? 0} 个 agent${failed}`, ok: true };
      },
      title: deleteAgent ? '放生并删除 agent？' : '仅重置本地？',
    });
    if (done?.done) toast.success({ id: 'release', title: done.done });
  };
  return (
    <>
      <Header page="reset" />
      {!view && <NoPet compact what="桌宠还没唤醒：没有可以重置的进度。" />}
      <Surface description="删除：本机的进度、好感和聊天记录。保留：LobeHub 里的 agent、设置（settings.json）和导入的角色包。" title="仅重置本地">
        <div>
          <Button danger data-release="local" disabled={!view} onClick={() => release(false)}>
            仅重置本地
          </Button>
        </div>
      </Surface>
      <Surface description="删除：本机的进度、好感和聊天记录，以及 LobeHub 里每位角色的 agent（含那里的聊天记录）。保留：设置和导入的角色包。" title="放生并删除 agent">
        <div>
          <Button danger data-release="agent" disabled={!view} onClick={() => release(true)}>
            放生并删除 agent
          </Button>
        </div>
      </Surface>
    </>
  );
};
