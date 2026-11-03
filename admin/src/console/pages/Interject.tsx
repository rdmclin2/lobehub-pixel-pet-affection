/**
 * 玩法 → 她怎么陪你 → 插个嘴 `#/interject` (core/interject.js, docs/interject.md §5)。C05 / INT-01：从「主动搭话与好感」
 * 拆出来的独立页（页名 = 入口名，W-02）。C06 / INT-02：关闭时只留一句说明，不渲染两张表（P-05「配置项只在开启后出现」）。
 * C07 / INT-03：读取失败在表格位置显示 LoadFailed（K-05「失败不是零条」）。C08 / INT-04：清空 / 删除走 askAsync，按 ok 反馈（C-15）。
 *
 * Below the schema cards, what the
 * feature has learned and done — the rules her owner's reactions settled (别插嘴 / 说得好 above a remark,
 * 「别打扰」 in the chat box, remarks left unanswered) and the recent decisions with the decision model's
 * probability. Data, not settings: a rule can be switched off (kept, matches nothing) or deleted; the records
 * can be cleared. Updates live through `onInterject` (a new decision, feedback, a new rule).
 */
import { Button, Flexbox, Switch, Table, Tag, Text, toast } from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, reasonText, type InterjectDecision, type InterjectRule } from '../api';
import { ResetPageButton, SettingsForm } from '../SettingsForm';
import { useStore } from '../store';
import { askAsync, asResult, LoadFailed } from '../common';

const RECENT = 20;

const ORIGIN: Record<string, string> = {
  engaged: '你接过话（累计）',
  ignored: '没人理（连续 3 次）',
  like: '点了「说得好」',
  manual: '手动添加',
  mute: '让她别插嘴',
};

const SOURCE: Record<string, string> = { api: '外部程序', chatDraft: '聊天框草稿', clipboard: '剪贴板', voice: '语音输入' };

// why a decision ended the way it did, in the owner's words (core/interject.js prefilter / verdict reasons)
const REASON: Record<string, string> = {
  aborted: '你发出了消息，判断中止',
  confident: '概率够高',
  'confident-no': '概率很低',
  cooldown: '刚插过嘴（冷却中）',
  'decide-budget': '这一小时判断次数用完',
  duplicate: '重复的输入',
  error: '决策模型调用失败',
  'hourly-cap': '这一小时插嘴次数用完',
  invalid: '决策模型没给出概率',
  'moment-passed': '时机过了（你已经在和她聊）',
  'pet-just-spoke': '她刚说过话',
  'quiet-hours': '勿扰时段',
  refused: '决策模型拒答',
  rule: '命中「别插嘴」规则',
  sensitive: '像密码 / 密钥，跳过',
  sleeping: '她在睡觉',
  'speak-failed': '没说出口',
  timeout: '判断超时',
  'too-short': '太短',
  uncertain: '拿不准，不说',
  'uncertain-allowed': '拿不准，但命中「可以插嘴」规则',
};

const time = (t?: number) => (t ? new Date(t).toLocaleString('zh-CN', { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'numeric' }) : '--');

const Outcome = ({ d }: { d: InterjectDecision }) => {
  if (d.verdict === 'interject') return <Tag color="success">插了一句</Tag>;
  if (d.stage === 'prefilter') return <Tag>没去判断</Tag>;
  if (d.stage === 'error') return <Tag color="warning">判断失败</Tag>;
  return <Tag>没说</Tag>;
};

const FEEDBACK: Record<string, { color?: string; text: string }> = {
  engaged: { color: 'processing', text: '你接了话' },
  ignored: { text: '没人理' },
  like: { color: 'success', text: '说得好' },
  mute: { color: 'error', text: '别插嘴' },
};

/** The page: the 插个嘴 switch card first; sources / budget / thresholds and the two tables only while it is on (C06). */
export const InterjectPage = () => {
  const { schema, settings } = useStore();
  const enabled = !!settings.interject?.enabled;
  const p = schema.pages.interject;
  return (
    <>
      <PageHeader action={<ResetPageButton page="interject" />} description={p?.description} title={p?.title ?? '插个嘴'} />
      {/* C06 / INT-02: off → only the switch card; 来源 / 额度与时段 / 判断 appear once it is on (P-05) */}
      <SettingsForm cards={enabled ? undefined : ['插个嘴']} page="interject" />
      {enabled ? (
        <InterjectData />
      ) : (
        <Surface data-interject-off description="打开上面的「插个嘴」后，这里列出沉淀的规则和最近的判断记录。关着时已有的规则保留、不生效。" title="规则与判断记录" />
      )}
    </>
  );
};

/** What 插个嘴 has learned and done (only shown while it is on). */
export const InterjectData = () => {
  const [rules, setRules] = useState<InterjectRule[] | null>(null);
  const [decisions, setDecisions] = useState<InterjectDecision[] | null>(null);
  // each table answers for its own read (K-05「读失败由数据所在的表面负责」)
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const why = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    // a failed refresh keeps what was shown (stale rows + a note), a failed first read shows LoadFailed
    await Promise.all([
      api().interjectRules().then((r) => {
          setRules(r.rules);
          setRulesError(null);
        }, (e) => setRulesError(why(e))),
      api().interjectDecisions(RECENT).then((d) => {
          setDecisions([...d.decisions].reverse()); // newest first
          setDecisionsError(null);
        }, (e) => setDecisionsError(why(e))),
    ]);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    return api().onInterject(() => load());
  }, [load]);

  // 启用 / 停用 is instant: the switch itself shows the result (S-5), only a failure says something (S-4)
  const toggle = async (r: InterjectRule, on: boolean) => {
    setBusy(r.id);
    try {
      const res = await api().interjectSetRule(r.id, !on);
      if (!res.ok) toast.error({ description: reasonText(res), title: on ? '没能启用这条规则' : '没能停用这条规则' });
      await load();
    } finally {
      setBusy(null);
    }
  };
  const remove = async (r: InterjectRule) => {
    const done = await askAsync({
      content: `「${r.note}」删除后，她对这类输入会重新由决策模型判断。`,
      danger: true,
      okText: '删除规则',
      run: async () => asResult(await api().interjectDeleteRule(r.id)),
      title: '删除这条规则？',
    });
    if (done) toast.success('规则已删除');
    await load();
  };
  const clear = async () => {
    const n = decisions?.length ?? 0;
    const done = await askAsync({
      content: '只删除下面的记录（概率、结果和摘要），规则保留。删除后不能恢复。',
      danger: true,
      okText: '清空记录',
      run: async () => {
        const res = await api().interjectClearDecisions();
        return res && res.ok ? { ok: true } : { ok: false, reason: `没能清空判断记录：${reasonText(res)}。记录没有改动，可以稍后再试。` };
      },
      title: '清空判断记录？',
    });
    if (done) toast.success(`判断记录已清空：删除了 ${n} 条`);
    await load();
  };
  const staleNote = (e: string | null, has: boolean) =>
    e && has ? (
      <Text data-refresh-failed fontSize={12} type="warning">
        刷新没成功，下面是上次读到的：{e}
      </Text>
    ) : null;

  return (
    <>
      <Surface
        bleed
        data-interject-rules
        description="你的反应会沉淀成规则：点「别插嘴」或在聊天框说「别打扰」→ 这类输入以后不再判断；点「说得好」或接过两次话 → 拿不准时也可以说。"
        extra={staleNote(rulesError, !!rules)}
        title={`沉淀的规则${rules ? ` · ${rules.length} 条` : ''}`}
      >
        {rules === null && rulesError ? (
          <LoadFailed onRetry={load} reason={rulesError} what="沉淀的规则" />
        ) : (
        <Table
          columns={[
            {
              key: 'note',
              render: (_: unknown, r: InterjectRule) => (
                <Flexbox align="center" gap={8} horizontal>
                  <Tag color={r.effect === 'block' ? 'error' : 'success'}>{r.effect === 'block' ? '别插嘴' : '可以插嘴'}</Tag>
                  <Text type={r.disabled ? 'secondary' : undefined}>{r.note.replace(/^(别插嘴|可以插嘴)：/, '')}</Text>
                  {r.disabled && <Tag>已停用</Tag>}
                </Flexbox>
              ),
              title: '规则',
            },
            { dataIndex: 'origin', key: 'origin', render: (v: string) => ORIGIN[v] ?? v, title: '来源', width: 150 },
            { dataIndex: 'hits', key: 'hits', render: (v: number) => `${v} 次`, title: '命中', width: 80 },
            { dataIndex: 'createdAt', key: 'createdAt', render: (v: number) => time(v), title: '创建时间', width: 130 },
            {
              key: 'op',
              render: (_: unknown, r: InterjectRule) => (
                <Flexbox align="center" gap={8} horizontal>
                  <Switch aria-label={`${r.disabled ? '启用' : '停用'}规则：${r.note}`} checked={!r.disabled} data-rule-toggle={r.id} loading={busy === r.id} onChange={(on) => toggle(r, on)} size="small" />
                  <Button aria-label={`删除规则：${r.note}`} data-rule-delete={r.id} icon={Trash2} onClick={() => remove(r)} size="small" type="text" />
                </Flexbox>
              ),
              title: '启用 / 删除',
              width: 120,
            },
          ]}
          dataSource={rules ?? []}
          loading={rules === null}
          locale={{ emptyText: '还没有规则：她插嘴后，点气泡上方的「别插嘴」或「说得好」就会记下一条。' }}
          pagination={false}
          rowKey="id"
          size="small"
        />
        )}
      </Surface>
      <Surface
        bleed
        data-interject-decisions
        extra={
          <Flexbox align="center" gap={8} horizontal>
            {staleNote(decisionsError, !!decisions)}
            <Button icon={RefreshCw} loading={loading} onClick={() => load()} size="small">
              刷新
            </Button>
            <Button data-interject-clear disabled={!decisions?.length} icon={Trash2} onClick={clear} size="small">
              清空记录
            </Button>
          </Flexbox>
        }
        description="每次判断都留一条：决策模型给的概率、最后说没说、为什么。只保存输入的前 24 个字，剪贴板只记字数。"
        title={`最近 ${RECENT} 次判断`}
      >
        {decisions === null && decisionsError ? (
          <LoadFailed onRetry={load} reason={decisionsError} what="判断记录" />
        ) : (
        <Table
          columns={[
            { dataIndex: 'at', key: 'at', render: (v: number) => time(v), title: '时间', width: 120 },
            { dataIndex: 'source', key: 'source', render: (v: string) => SOURCE[v] ?? v, title: '来源', width: 100 },
            { dataIndex: 'summary', key: 'summary', render: (v: string, d: InterjectDecision) => <Text ellipsis={{ tooltip: d.said ? `她说：${d.said}` : v }}>{v}</Text>, title: '输入摘要' },
            { dataIndex: 'probability', key: 'p', render: (v: number | null) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '--'), title: '概率', width: 70 },
            {
              key: 'outcome',
              render: (_: unknown, d: InterjectDecision) => (
                <Flexbox gap={2}>
                  <Flexbox align="center" gap={4} horizontal>
                    <Outcome d={d} />
                    {d.feedback && FEEDBACK[d.feedback] && <Tag color={FEEDBACK[d.feedback].color}>{FEEDBACK[d.feedback].text}</Tag>}
                  </Flexbox>
                  <Text fontSize={12} type="secondary">
                    {REASON[d.reason] ?? d.reason}
                  </Text>
                </Flexbox>
              ),
              title: '是否插嘴',
              width: 220,
            },
          ]}
          dataSource={decisions ?? []}
          loading={decisions === null}
          locale={{ emptyText: '还没有判断记录：在她的聊天框里打一句、停下来不发送试试。' }}
          pagination={false}
          rowKey="id"
          size="small"
        />
        )}
      </Surface>
    </>
  );
};
