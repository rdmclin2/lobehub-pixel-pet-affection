import { createStaticStyles, cssVar, Flexbox, Text } from '@lobehub/ui';

// The same wording the pet window used (src/core/vrm-ui.js, UMD; Vite bundles it as CommonJS).
import PetVrmUi from '../../../../src/core/vrm-ui.js';

import { api } from '../api';

interface LicenseRow {
  href: string | null;
  label: string;
  text: string;
}
interface VrmUi {
  creditLine: (vrm: any) => string | null;
  exportState: (o: any) => { ok: boolean; reason?: string; text?: string };
  importErrorText: (errors: unknown) => string;
  licenseRows: (meta: any) => LicenseRow[];
  restrictionList: (r: any) => { id: string; text: string; tone: 'block' | 'info' }[];
}
export const vrmUi = (): VrmUi => PetVrmUi as VrmUi;

const styles = createStaticStyles(({ css }) => ({
  list: css`
    margin: 0;
    padding-inline-start: 20px;

    li[data-tone='block'] {
      color: ${cssVar.colorError};
    }
  `,
  meta: css`
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;

    margin: 0;

    font-size: 12px;

    dt {
      color: ${cssVar.colorTextTertiary};
    }

    dd {
      margin: 0;
      word-break: break-all;
    }
  `,
}));

/**
 * The license of a VRM pack, read from the model (core/vrm.js): its summary, the restrictions the app enforces
 * first, then per model the meta rows (author, copyright, permissions, license links → system browser).
 * Shown in 导入确认 and behind 授权信息 on the pack card.
 */
export const VrmLicense = ({ packId, vrm }: { packId: string; vrm: any }) => {
  const U = vrmUi();
  const rs = U.restrictionList(vrm?.restrictions);
  return (
    <Flexbox data-vrm-license={packId} gap={10}>
      {vrm?.summary && (
        <Text data-vrm-summary strong>
          {vrm.summary}
        </Text>
      )}
      {rs.length > 0 && (
        <ul aria-label="授权限制" className={styles.list} data-vrm-restrictions>
          {rs.map((x) => (
            <li data-id={x.id} data-tone={x.tone} key={x.id}>
              {x.text}
            </li>
          ))}
        </ul>
      )}
      {(vrm?.models ?? []).map((m: any, i: number) => (
        <dl className={styles.meta} data-vrm-meta key={m.file || i}>
          {U.licenseRows(m.meta).map((row, j) => [
            <dt key={`t${j}`}>{row.label}</dt>,
            <dd key={`d${j}`}>
              {row.href ? (
                <a
                  href={row.href}
                  onClick={(e) => {
                    e.preventDefault();
                    api().openLink(row.href!);
                  }}
                  title="在浏览器中打开"
                >
                  {row.text}
                </a>
              ) : (
                row.text
              )}
            </dd>,
          ])}
        </dl>
      ))}
    </Flexbox>
  );
};

/** A license as rows (商店 → VRM 角色: read from the model when the store was built, before it is downloaded). */
export const LicenseRows = ({ id, rows }: { id: string; rows: { href?: string | null; label: string; text: string }[] }) => (
  <dl className={styles.meta} data-store-license={id}>
    {rows.map((row, j) => [
      <dt key={`t${j}`}>{row.label}</dt>,
      <dd key={`d${j}`}>
        {row.href ? (
          <a
            href={row.href}
            onClick={(e) => {
              e.preventDefault();
              api().openLink(row.href!);
            }}
            title="在浏览器中打开"
          >
            {row.text}
          </a>
        ) : (
          row.text
        )}
      </dd>,
    ])}
  </dl>
);
