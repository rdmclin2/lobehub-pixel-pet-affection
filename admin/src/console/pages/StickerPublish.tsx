// 上架到商店 (T-10796; docs/stickers-design.md §5.2 方案 C): an owner puts a character's 「我的」 set on the
// community shelf of 商店 → 表情包, and sees what they put up.
//
//   PublishButton      角色 → 表情包 → 「我的」: opens the form — 名称, 简介, 授权, 「我有权发布这些图片」. main packs the
//                      set and sends it to the sticker market with the owner's LobeHub login; the market names the
//                      author from that account and keeps it 审核中 until the maintainer approves it.
//   MyPublished        商店 → 表情包 → 我上架的: each set with its review state (审核中 / 已上架 / 未通过 + why),
//                      the version others get now, 查看 and 下架.
import { Alert, Button, Checkbox, Empty, Flexbox, Input, Modal, Select, Skeleton, Tag, Text, TextArea, toast, Tooltip } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { RotateCw, Store, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, type MyStickerSet, type RosterRow } from '../api';
import { ask } from '../fields';

const STATE: Record<MyStickerSet['state'], { color: string; text: string }> = {
  pending: { color: 'orange', text: '审核中' },
  published: { color: 'green', text: '已上架' },
  rejected: { color: 'red', text: '未通过' },
  removed: { color: 'default', text: '已下架' },
};

export const StateTag = ({ s }: { s: MyStickerSet }) => (
  <Tag color={STATE[s.state].color} data-publish-state={s.state}>
    {STATE[s.state].text}
  </Tag>
);

export const PublishButton = ({ c, count }: { c: RosterRow; count: number }) => {
  const speciesId = c.base;
  const [info, setInfo] = useState<{ configured: boolean; licenses: string[]; publishedId: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ description: '', license: '', name: '', rights: false });

  const loadInfo = useCallback(async () => {
    const r = await api().stickerStore.publishInfo(speciesId);
    setInfo(r);
    return r;
  }, [speciesId]);
  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  const start = async () => {
    const r = await loadInfo();
    setDraft({ description: '', license: r.licenses[0] ?? '', name: `${c.nameZh}的表情包`, rights: false });
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api().stickerStore.publish(speciesId, draft);
      if (!r.ok) return void setError(r.text || '没能上架');
      setOpen(false);
      await loadInfo();
      if (r.state === 'published') toast.success({ description: '其他人现在可以在 商店 → 表情包 里看到并获取它。', title: `「${r.set.name}」已上架` });
      else toast.success({ description: '审核通过后会出现在 商店 → 表情包，进度可以在「我上架的」里看到。', title: `「${r.set.name}」已提交上架（v${r.version}）` });
    } finally {
      setBusy(false);
    }
  };

  const off = info && !info.configured;
  const updating = !!info?.publishedId;
  const button = (
    <Button data-sticker-publish disabled={!info || off || count === 0} icon={Upload} onClick={start}>
      {updating ? '更新上架' : '上架到商店'}
    </Button>
  );
  return (
    <>
      {off ? <Tooltip title="表情包社区商店还没有配置（PIXELPET_STICKER_MARKET_URL）">{button}</Tooltip> : button}
      <Modal
        cancelText="取消"
        confirmLoading={busy}
        destroyOnHidden
        okButtonProps={{ disabled: !draft.name.trim() || !draft.license || !draft.rights }}
        okText={updating ? '提交新版本' : '提交上架'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        open={open}
        title={updating ? `更新已上架的「我的」表情包（${count} 张）` : `把「我的」表情包上架到商店（${count} 张）`}
      >
        <Flexbox data-sticker-publish-form gap={12}>
          <Text type="secondary">
            {`上架后由维护者审核，通过后所有人都能在 商店 → 表情包 里看到，并获取给自己的角色。作者显示为你的 LobeHub 账号名。${updating ? '这次会提交一个新版本，审核通过前别人拿到的仍是上一版。' : ''}`}
          </Text>
          <Flexbox gap={6}>
            <Text strong>名称</Text>
            <Input data-publish-name maxLength={30} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} value={draft.name} />
          </Flexbox>
          <Flexbox gap={6}>
            <Text strong>简介</Text>
            <TextArea autoSize={{ maxRows: 4, minRows: 2 }} data-publish-desc maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="这组表情包适合什么场合、是什么风格" value={draft.description} />
          </Flexbox>
          <Flexbox gap={6}>
            <Text strong>授权方式</Text>
            <Select data-publish-license onChange={(v) => setDraft((d) => ({ ...d, license: String(v) }))} options={(info?.licenses ?? []).map((l) => ({ label: l, value: l }))} value={draft.license || undefined} />
            <Text fontSize={12} type="secondary">
              获取的人按这个授权使用这些图片。
            </Text>
          </Flexbox>
          <Checkbox checked={draft.rights} data-publish-rights onChange={(v) => setDraft((d) => ({ ...d, rights: !!v }))}>
            我拥有这些图片的发布权，内容适合全年龄
          </Checkbox>
          {error && <Alert data-publish-error description={error} title="没能上架" type="error" />}
        </Flexbox>
      </Modal>
    </>
  );
};

export const MyPublished = ({ onView }: { onView: (id: string) => void }) => {
  const [r, setR] = useState<Awaited<ReturnType<ReturnType<typeof api>['stickerStore']['mine']>> | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setR(await api().stickerStore.mine());
    } catch (e: any) {
      setR({ ok: false, reason: 'error', text: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const unpublish = async (s: MyStickerSet) => {
    if (!(await ask(`下架「${s.name}」？`, '下架后商店里不再显示它，别人也不能再获取；已经获取的人仍然可以继续使用。', '下架', true))) return;
    const x = await api().stickerStore.unpublish(s.id);
    if (x.ok) toast.success(`「${s.name}」已下架`);
    else toast.error(x.text || '没能下架');
    await load();
  };

  if (!r) return <Skeleton animated height={96} />;
  if (!r.ok)
    return (
      <div data-my-published-error>
        <Alert
          action={
            <Button icon={RotateCw} loading={loading} onClick={load} size="small">
              重试
            </Button>
          }
          description={r.text}
          title="读不到你上架的表情包"
          type={r.reason === 'auth' ? 'info' : 'error'}
        />
      </div>
    );
  if (!r.sets.length)
    return (
      <div data-my-published-empty>
        <Empty description="在 角色 → 表情包 → 我的 里点「上架到商店」，就能把你添加的表情包分享给其他人。" icon={Store} title="还没有上架表情包" />
      </div>
    );
  return (
    <Flexbox data-my-published gap={12}>
      <Flexbox align="center" horizontal justify="space-between">
        <Text fontSize={12} type="secondary">{`以 LobeHub 账号「${r.user?.name ?? ''}」上架的表情包`}</Text>
        <Button icon={RotateCw} loading={loading} onClick={load} size="small">
          刷新
        </Button>
      </Flexbox>
      {r.sets.map((s) => (
        <Surface key={s.id}>
          <Flexbox align="center" data-my-set={s.id} gap={12} horizontal justify="space-between" padding={16} wrap="wrap">
            <Flexbox gap={4}>
              <Flexbox align="center" gap={8} horizontal>
                <Text strong>{s.name}</Text>
                <StateTag s={s} />
              </Flexbox>
              <Text fontSize={12} type="secondary">
                {`${s.count} 张 · v${s.version} · ${s.license}${s.liveVersion && s.liveVersion !== s.version ? ` · 商店里现在是 v${s.liveVersion}` : ''}`}
              </Text>
              {s.state === 'pending' && <Text fontSize={12} type="secondary">等待维护者审核，通过后会出现在商店里。</Text>}
              {s.state === 'rejected' && <Text fontSize={12} type="danger">{`没有通过审核：${s.rejectReason}`}</Text>}
            </Flexbox>
            <Flexbox gap={8} horizontal>
              {s.liveVersion && (
                <Button onClick={() => onView(s.id)} size="small">
                  在商店查看
                </Button>
              )}
              <Button danger data-unpublish={s.id} onClick={() => unpublish(s)} size="small">
                下架
              </Button>
            </Flexbox>
          </Flexbox>
        </Surface>
      ))}
    </Flexbox>
  );
};
