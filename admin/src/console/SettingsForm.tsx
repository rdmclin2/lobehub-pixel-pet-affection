import { Button, toast } from '@lobehub/ui';
import { Form, useForm } from '@lobehub/ui/form';
import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

import { api, at, reasonText, type FieldDef } from './api';
import { FieldControl, FieldDesc } from './fields';
import { useStore } from './store';

/** LobeHub /settings FORM_STYLE: label column at least 34% / 240 px, content max 1024. */
export const FORM_STYLE = { itemMinWidth: 'max(34%, 240px)', style: { maxWidth: 1024, width: '100%' } } as const;

const visible = (f: FieldDef, settings: any) => !f.dependsOn || at(settings, f.dependsOn.key) === f.dependsOn.value;

export const fieldsOf = (fields: FieldDef[], page: string, opts: { internal?: boolean } = {}) =>
  fields.filter((f) => f.page === page && (opts.internal || !f.internal));

/**
 * The settings of one page as LobeHub-style form cards: `Form itemsType="group" variant="filled"`, one group
 * per schema card, label + description on the left and the control on the right. Fields whose master switch
 * is off are folded away (P-05). `extra` adds a node to a card's header by card title. `cards` keeps only those
 * cards, in the schema's order (A13 / PG-01: 朗读 shows the chosen engine's card, the others fold away).
 */
export const SettingsForm = ({
  page,
  extra,
  internal,
  after,
  cards: only,
}: {
  after?: Record<string, ReactNode>;
  cards?: string[];
  extra?: Record<string, ReactNode>;
  internal?: boolean;
  page: string;
}) => {
  const { schema, settings } = useStore();
  // the controls are bound to the store (each one saves itself), so the form holds no values of its own
  const form = useForm({ initialValues: {} });
  const fields = fieldsOf(schema.fields, page, { internal });
  const cards: string[] = [];
  // a card whose every field is folded away (its master switch is off) is not drawn as an empty header (P-05, INT-02)
  for (const f of fields) if (!cards.includes(f.card) && (!only || only.includes(f.card)) && visible(f, settings)) cards.push(f.card);
  if (!cards.length) return null;
  return (
    <Form
      {...FORM_STYLE}
      collapsible={false}
      data-settings-page={page}
      form={form}
      items={cards.map((card) => ({
        children: [
          ...fields
            .filter((f) => f.card === card)
            .map((f) => ({
              children: <FieldControl field={f} />,
              desc: <FieldDesc field={f} />,
              hidden: !visible(f, settings),
              label: f.label,
              layout: 'horizontal' as const,
              minWidth: undefined,
            })),
          ...(after?.[card] ? [{ children: after[card], label: '', layout: 'vertical' as const }] : []),
        ],
        extra: extra?.[card],
        key: card,
        title: card,
      }))}
      itemsType="group"
      variant="filled"
    />
  );
};

/**
 * 恢复本页默认: every changed key of the page back to its default. A24 (FORM-05, W-07): it can be undone, so no
 * confirmation — the toast lists what changed and offers 撤销 for 5 s.
 */
export const ResetPageButton = ({ page, keys }: { keys?: string[]; page: string }) => {
  const { schema, settings, merge } = useStore();
  const fields = schema.fields.filter((f) => (keys ? keys.includes(f.key) : f.page === page) && (f.live || f.restart) && f.default !== undefined);
  const changed = fields.filter((f) => JSON.stringify(at(settings, f.key) ?? null) !== JSON.stringify(f.default ?? null));
  if (!fields.length) return null;
  return (
    <Button
      data-reset-page={page}
      disabled={!changed.length}
      icon={RotateCcw}
      onClick={async () => {
        const before = changed.map((f) => [f.key, at(settings, f.key)] as const);
        const r = await api().reset(changed.map((f) => f.key));
        merge({ settings: r.settings });
        if (!r.ok) return toast.error({ description: reasonText(r.results?.find((x) => !x.ok)), title: '有几项没有恢复默认' });
        toast.success({
          actions: [
            {
              label: '撤销',
              onClick: async () => {
                let last: any = null;
                for (const [k, v] of before) last = await api().set(k, v);
                if (last?.settings) merge({ settings: last.settings });
              },
            },
          ],
          description: changed.map((f) => f.label).join('、'),
          duration: 5000,
          id: `reset-page:${page}`,
          title: `已恢复 ${changed.length} 项默认设置`,
        });
      }}
    >
      恢复本页默认
    </Button>
  );
};
