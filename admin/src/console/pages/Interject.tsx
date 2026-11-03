/**
 * 玩法 → 主动搭话与好感 → 插个嘴 (core/interject.js, docs/interject.md §5): below the schema cards, what the
 * feature has learned and done — the rules her owner's reactions settled (别插嘴 / 说得好 above a remark,
 * 「别打扰」 in the chat box, remarks left unanswered) and the recent decisions with the decision model's
 * probability. Data, not settings: a rule can be switched off (kept, matches nothing) or deleted; the records
 * can be cleared. Updates live through `onInterject` (a new decision, feedback, a new rule).
 */
import { Alert, Button, Flexbox, Switch, Table, Tag, Text, toast } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, reasonText, type InterjectDecision, type InterjectRule } from '../api';
import { ask } from '../fields';
import { useStore } from '../store';

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

export const InterjectData = () => {
  const { settings } = useStore();
  const enabled = !!settings.interject?.enabled;
  const [rules, setRules] = useState<InterjectRule[] | null>(null);
  const [decisions, setDecisions] = useState<InterjectDecision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([api().interjectRules(), api().interjectDecisions(RECENT)]);
      setRules(r.rules);
      setDecisions([...d.decisions].reverse()); // newest first
      setError(null);
    } catch (e) {
      setError(String((e as Error).message || e)); // keep what was shown: a failed refresh does not empty the lists
    }
  }, []);
  useEffect(() => {
    load();
    return api().onInterject(() => load());
  }, [load]);

  const toggle = async (r: InterjectRule, on: boolean) => {
    setBusy(r.id);
    try {
      const res = await api().interjectSetRule(r.id, !on);
      if (!res.ok) toast.error(reasonText(res));
      else toast.success(on ? '规则已启用' : '规则已停用：保留在列表里，但不再生效');
      await load();
    } finally {
      setBusy(null);
    }
  };
  const remove = async (r: InterjectRule) => {
    if (!(await ask('删除这条规则？', `「${r.note}」删除后，她对这类输入会重新由决策模型判断。`, '删除规则', true))) return;
    const res = await api().interjectDeleteRule(r.id);
    if (!res.ok) toast.error(reasonText(res));
    else toast.success('规则已删除');
    await load();
  };
  const clear = async () => {
    if (!(await ask('清空判断记录？', '只删除下面的记录（概率、结果和摘要），规则保留。', '清空记录', true))) return;
    await api().interjectClearDecisions();
    toast.success('判断记录已清空');
    await load();
  };

  return (
    <>
      {error && <Alert closable description={error} onClose={() => setError(null)} title="插个嘴的规则和记录没有读出来" type="warning" />}
      <Surface
        bleed
        data-interject-rules
        description={
          enabled
            ? '你的反应会沉淀成规则：点「别插嘴」或在聊天框说「别打扰」→ 这类输入以后不再判断；点「说得好」或接过两次话 → 拿不准时也可以说。'
            : '插个嘴关着时规则不生效，但会保留。'
        }
        title={`沉淀的规则${rules ? ` · ${rules.length} 条` : ''}`}
      >
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
          loading={rules === null && !error}
          locale={{ emptyText: '还没有规则：她插嘴后，点气泡上方的「别插嘴」或「说得好」就会记下一条。' }}
          pagination={false}
          rowKey="id"
          size="small"
        />
      </Surface>
      <Surface
        bleed
        data-interject-decisions
        extra={
          <Flexbox gap={8} horizontal>
            <Button icon={RefreshCw} onClick={() => load()} size="small">
              刷新
            </Button>
            <Button disabled={!decisions?.length} icon={Trash2} onClick={clear} size="small">
              清空记录
            </Button>
          </Flexbox>
        }
        description="每次判断都留一条：决策模型给的概率、最后说没说、为什么。只保存输入的前 24 个字，剪贴板只记字数。"
        title={`最近 ${RECENT} 次判断`}
      >
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
          loading={decisions === null && !error}
          locale={{ emptyText: enabled ? '还没有判断记录：在她的聊天框里打一句、停下来不发送试试。' : '还没有判断记录。打开上面的「插个嘴」后，她才会开始听。' }}
          pagination={false}
          rowKey="id"
          size="small"
        />
      </Surface>
    </>
  );
};
