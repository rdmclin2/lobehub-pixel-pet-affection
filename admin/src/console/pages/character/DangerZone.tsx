/**
 * 详情页底的 DangerZone（B05 / CHAR-05）与角色模块的危险确认。确认走实施包 A 的共享件 `askAsync`（02-plan §2
 * S-7：在弹窗里执行，失败原因写在弹窗里、弹窗不关，成功才关闭），这里只把成功结果写成 toast。
 */
import { Button, createStaticStyles, cssVar, Flexbox, Text, toast } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import type { ReactNode } from 'react';

import { reasonText } from '../../api';
import { askAsync } from '../../common';

export interface AskDangerOptions {
  desc: ReactNode;
  okText: string;
  /** 执行；`ok: false` 时 `error`（否则 `reasonText(r)`）写在弹窗里；成功时 `done` 是 toast 的结果文案。 */
  run: () => Promise<{ done?: string; error?: string; ok: boolean; r?: any }>;
  title: string;
}

/** 不可逆操作：确认 + 在弹窗里执行（S-7），成功后 toast 写实际结果。 */
export const askDanger = async (o: AskDangerOptions) => {
  const res = await askAsync({
    content: o.desc,
    danger: true,
    okText: o.okText,
    run: async () => {
      const out = await o.run();
      return out.ok ? { done: out.done, ok: true } : { ok: false, reason: out.error || reasonText(out.r) };
    },
    title: o.title,
  });
  if (res?.ok && res.done) toast.success(res.done);
  return res;
};

/** 旧接口：`ask.ask(opts)`；弹窗由共享件挂在 ModalHost 上，`modal` 留空。 */
export const useAskAsync = () => ({ ask: (o: AskDangerOptions) => void askDanger(o), modal: null });

const styles = createStaticStyles(({ css }) => ({
  row: css`
    padding-block: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    &:first-child {
      padding-block-start: 0;
      border-block-start: 0;
    }
  `,
}));

export interface DangerItem {
  /** 写清删除什么、保留什么（F2 / F5 状态设计）。 */
  desc: string;
  key: string;
  label: string;
  onClick: () => void;
  /** 按钮上的 data-*，e2e 与旧选择器沿用 */
  data: Record<string, string>;
}

/**
 * DangerZone：页底单独一区（P-05「高风险项单独一区」、P-03「危险操作不和普通操作同色同位」），每项一行：
 * 说明在左、danger 按钮在右。没有可做的危险操作时整块不出现。
 */
export const DangerZone = ({ items }: { items: DangerItem[] }) => {
  if (!items.length) return null;
  return (
    <Surface data-danger-zone description="这里的操作不能撤销，确认后在弹窗里执行，结果写在弹窗或提示里。" title="危险操作">
      <Flexbox>
        {items.map((it) => (
          <Flexbox align="center" className={styles.row} data-danger-item={it.key} gap={16} horizontal justify="space-between" key={it.key}>
            <Flexbox gap={2} style={{ minWidth: 0 }}>
              <Text strong>{it.label}</Text>
              <Text fontSize={12} type="secondary">
                {it.desc}
              </Text>
            </Flexbox>
            <Button danger onClick={it.onClick} style={{ flex: 'none' }} {...it.data}>
              {it.label}
            </Button>
          </Flexbox>
        ))}
      </Flexbox>
    </Surface>
  );
};
