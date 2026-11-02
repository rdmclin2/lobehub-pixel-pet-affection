import { createStaticStyles } from '@lobehub/ui';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  page: css`
    width: 100%;
    max-width: 1024px;
    margin-inline: auto;
    padding-block: 24px 48px;
    padding-inline: 24px;
  `,
  themeColumn: css`
    flex: 1;
    min-width: 0;
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgLayout};
    color: ${cssVar.colorText};
  `,
  swatch: css`
    flex: none;
    width: 32px;
    height: 32px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  mono: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  spaceBar: css`
    height: 12px;
    border-radius: ${cssVar.borderRadiusXS};
    background: ${cssVar.colorPrimary};
  `,
  radiusBox: css`
    width: 72px;
    height: 48px;
    border: 1px solid ${cssVar.colorBorder};
    background: ${cssVar.colorFillTertiary};
  `,
  shadowBox: css`
    width: 120px;
    height: 72px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
  `,
  motionTrack: css`
    position: relative;
    width: 240px;
    height: 24px;
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  motionDot: css`
    position: absolute;
    inset-block-start: 4px;
    inset-inline-start: 4px;
    width: 16px;
    height: 16px;
    border-radius: ${cssVar.borderRadiusSM};
    background: ${cssVar.colorPrimary};
    transition-property: transform;

    @media (prefers-reduced-motion: reduce) {
      transition-property: none;
    }
  `,
  motionDotOn: css`
    transform: translateX(216px);
  `,
  fieldControl: css`
    width: 240px;
  `,
}));
