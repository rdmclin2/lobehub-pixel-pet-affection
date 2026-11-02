import { ActionIcon, Alert, Button, createStaticStyles, cssVar, ErrorBoundary, Flexbox, Icon, Text } from '@lobehub/ui';
import { ChevronLeft, Monitor, Moon, PawPrint, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

import { api, type NavGroupDef } from './api';
import { ICONS } from './icons';
import { SpriteStage } from './stage/SpriteStage';
import { useSave, useStore } from './store';

const styles = createStaticStyles(({ css }) => ({
  shell: css`
    display: flex;
    width: 100vw;
    height: 100vh;
    background: ${cssVar.colorBgLayout};
  `,
  rail: css`
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 4px;
    align-items: center;

    width: 80px;
    padding-block: 16px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  railMac: css`
    padding-block-start: 40px;
  `,
  me: css`
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    justify-content: center;

    width: 48px;
    height: 48px;
    margin-block-end: 16px;
    border-radius: ${cssVar.borderRadiusLG};

    background: color-mix(in srgb, var(--pet-accent) 18%, ${cssVar.colorFillTertiary});
  `,
  link: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;

    width: 64px;
    padding-block: 8px;
    border-radius: ${cssVar.borderRadiusLG};

    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
    text-decoration: none;

    transition:
      background-color 150ms ease-out,
      color 150ms ease-out;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-current='page'] {
      font-weight: 500;
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }

    &[aria-current='page'] svg {
      color: var(--pet-accent);
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }
  `,
  main: css`
    position: relative;
    overflow: auto;
    flex: 1;
    min-width: 0;
  `,
  // her colour, faintly, at the top of every page: the window belongs to whoever is with you now
  glow: css`
    pointer-events: none;
    position: absolute;
    inset-block-start: 0;
    inset-inline: 0;

    height: 320px;

    background: radial-gradient(60% 100% at 30% 0%, color-mix(in srgb, var(--pet-accent) 14%, transparent), transparent 70%);
  `,
  page: css`
    position: relative;
    width: 100%;
    max-width: 1120px;
    margin-inline: auto;
    padding-block: 24px 48px;
    padding-inline: 32px;
  `,
}));

const THEME_NEXT: Record<string, { icon: typeof Sun; label: string; next: string }> = {
  auto: { icon: Monitor, label: '外观：跟随系统（点按切到亮色）', next: 'light' },
  light: { icon: Sun, label: '外观：亮色（点按切到暗色）', next: 'dark' },
  dark: { icon: Moon, label: '外观：暗色（点按切回跟随系统）', next: 'auto' },
};

/** Which rail place a page sits under. */
export const placeOf = (page: string, nav: NavGroupDef[]) => (page === 'play' || page === 'settings' ? page : (nav.find((g) => g.items.some((i) => i.page === page))?.section ?? 'home'));

/**
 * The window: a slim rail with four places (小屋 / 角色 / 玩法 / 设置) and the page. Every other page is one
 * level below a place and shows the way back up; the current character's colour tints the room.
 */
export const Shell = ({ path, children }: { children: ReactNode; path: string }) => {
  const { schema, roster, settings, platform, pendingRestart } = useStore();
  const save = useSave();
  const cur = roster.find((c) => c.current) ?? null;
  const [, page = 'overview', sub] = path.split('/');
  const place = placeOf(page, schema.nav);
  const rail = schema.rail.find((r) => r.key === place);
  const isTop = schema.rail.some((r) => r.page === page) && !sub;
  const back = !isTop && rail ? rail : null;
  const here = page === 'characters' ? (roster.find((c) => c.id === sub)?.nameZh ?? sub) : (schema.pages[page]?.title ?? page);
  const theme = THEME_NEXT[settings.ui?.theme ?? 'auto'] ?? THEME_NEXT.auto;
  const names = pendingRestart.map((k) => schema.fields.find((f) => f.key === k)?.label ?? k).join('、');
  return (
    <div className={styles.shell} style={{ ['--pet-accent' as string]: cur?.accent ?? cssVar.colorPrimary }}>
      <nav aria-label="主导航" className={`${styles.rail} ${platform === 'darwin' ? styles.railMac : ''}`}>
        <div className={styles.me} title={cur ? `正在陪你：${cur.met?.name ?? cur.nameZh}` : 'Pixel Pet'}>
          {cur ? <SpriteStage animate={false} height={44} name={cur.nameZh} preview={cur.preview} /> : <Icon icon={PawPrint} size={20} />}
        </div>
        {schema.rail.map((r) => (
          <a aria-current={place === r.key ? 'page' : undefined} className={styles.link} data-rail={r.key} href={`#/${r.page}`} key={r.key}>
            <Icon icon={ICONS[r.icon]} size={20} />
            {r.label}
          </a>
        ))}
        <Flexbox flex={1} />
        <ActionIcon icon={PawPrint} onClick={() => api().showPet()} title="把桌宠叫到前面" />
        <ActionIcon data-theme-toggle icon={theme.icon} onClick={() => save('ui.theme', theme.next)} title={theme.label} />
      </nav>
      <main className={styles.main}>
        <div className={styles.glow} />
        <Flexbox className={styles.page} data-admin-page={page} data-path={path} gap={16}>
          {back && (
            <Flexbox align="center" gap={4} horizontal>
              <Button data-back={back.key} href={`#/${back.page}`} icon={ChevronLeft} size="small" type="text">
                {schema.pages[back.page]?.title ?? back.label}
              </Button>
              <Text type="secondary">/</Text>
              <Text type="secondary">{here}</Text>
            </Flexbox>
          )}
          {pendingRestart.length > 0 && (
            <Alert
              action={
                <Button onClick={() => api().relaunch()} size="small" type="primary">
                  立即重启
                </Button>
              }
              data-restart-banner
              showIcon
              title={`${names}：重启应用后生效`}
              type="warning"
            />
          )}
          {/* a page that fails shows why, the rail stays usable */}
          <ErrorBoundary
            fallbackRender={({ error }) => <Alert description={String((error as Error)?.message ?? error)} showIcon title="这一页没有显示出来" type="error" />}
            resetKeys={[path]}
          >
            {children}
          </ErrorBoundary>
        </Flexbox>
      </main>
    </div>
  );
};
