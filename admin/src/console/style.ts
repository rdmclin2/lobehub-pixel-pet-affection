import { createStaticStyles } from '@lobehub/ui';

export const styles = createStaticStyles(({ css }) => ({
  // LobeHub /settings: content column max 1024, centred
  page: css`
    width: 100%;
    max-width: 1072px;
    margin-inline: auto;
    padding-block: 24px 48px;
    padding-inline: 24px;
  `,
}));
