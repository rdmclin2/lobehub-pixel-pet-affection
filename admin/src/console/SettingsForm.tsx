import { Button, Flexbox, toast } from '@lobehub/ui';
import { Form, useForm } from '@lobehub/ui/form';
import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

import { api, at, type FieldDef } from './api';
import { ask, FieldControl, FieldDesc, formatValue } from './fields';
import { useStore } from './store';

/** LobeHub /settings FORM_STYLE: label column at least 34% / 240 px, content max 1024. */
export const FORM_STYLE = { itemMinWidth: 'max(34%, 240px)', style: { maxWidth: 1024, width: '100%' } } as const;

const visible = (f: FieldDef, settings: any) => !f.dependsOn || at(settings, f.dependsOn.key) === f.dependsOn.value;

export const fieldsOf = (fields: FieldDef[], page: string, opts: { internal?: boolean } = {}) =>
  fields.filter((f) => f.page === page && (opts.internal || !f.internal));

/**
 * The settings of one page as LobeHub-style form cards: `Form itemsType="group" variant="filled"`, one group
 * per schema card, label + description on the left and the control on the right. Fields whose master switch
 * is off are folded away (P-05). `extra` adds a node to a card's header by card title.
 */
export const SettingsForm = ({ page, extra, internal, after }: { after?: Record<string, ReactNode>; extra?: Record<string, ReactNode>; internal?: boolean; page: string }) => {
  const { schema, settings } = useStore();
  // the controls are bound to the store (each one saves itself), so the form holds no values of its own
  const form = useForm({ initialValues: {} });
  const fields = fieldsOf(schema.fields, page, { internal });
  const cards: string[] = [];
  for (const f of fields) if (!cards.includes(f.card)) cards.push(f.card);
  // a card whose every field is hidden (e.g. 音乐创作 → the services not picked, music.provider) is left out, not
  // shown as an empty header
  const shown = cards.filter((card) => !!after?.[card] || fields.some((f) => f.card === card && visible(f, settings)));
  return (
    <Form
      {...FORM_STYLE}
      collapsible={false}
      data-settings-page={page}
      form={form}
      items={shown.map((card) => ({
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

/** 恢复本页默认: every resettable key of the page back to its default, after a confirmation. */
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
        const ok = await ask(
          '恢复本页默认设置？',
          <Flexbox gap={4}>
            {changed.map((f) => (
              <span key={f.key}>
                {f.label}：{formatValue(f, at(settings, f.key))} → {formatValue(f, f.default)}
              </span>
            ))}
          </Flexbox>,
          '恢复默认',
        );
        if (!ok) return;
        const r = await api().reset(changed.map((f) => f.key));
        merge({ settings: r.settings });
        if (r.ok) toast.success(`已恢复 ${changed.length} 项默认设置`);
        else toast.error('有几项没有恢复成功');
      }}
    >
      恢复本页默认
    </Button>
  );
};
