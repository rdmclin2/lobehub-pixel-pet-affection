import { Alert, Button, Center, ErrorBoundary, Flexbox, Icon, Spin, Text } from '@lobehub/ui';
import { ConsoleBrand, ConsoleNav, ConsoleShell, type ConsoleNavGroup } from '@lobehub/ui/dashboard';
import { PawPrint } from 'lucide-react';

import { useHashPath } from '../useHashPath';
import { api } from './api';
import { ICONS } from './icons';
import { CharacterDetailPage, CharactersPage, PacksPage } from './pages/Characters';
import { AboutPage, ApiPage, AsrPage, ConnectionPage, OverviewPage, SafetyPage, SimpleSettingsPage, TtsPage, UpdatePage, VoicePacksPage } from './pages/Pages';
import { StoreProvider, useStore } from './store';
import { styles } from './style';

/** Settings that only apply after a restart were changed: say so on every page, with 立即重启. */
const RestartBanner = () => {
  const { pendingRestart, schema } = useStore();
  if (!pendingRestart.length) return null;
  const names = pendingRestart.map((k) => schema.fields.find((f) => f.key === k)?.label ?? k).join('、');
  return (
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
  );
};

const Page = ({ path, navigate }: { navigate: (p: string) => void; path: string }) => {
  const [, page, sub] = path.split('/');
  switch (page) {
    case 'overview':
      return <OverviewPage navigate={navigate} />;
    case 'characters':
      return sub ? <CharacterDetailPage id={sub} key={sub} navigate={navigate} /> : <CharactersPage navigate={navigate} />;
    case 'packs':
      return <PacksPage />;
    case 'tts':
      return <TtsPage />;
    case 'asr':
      return <AsrPage />;
    case 'voicepacks':
      return <VoicePacksPage />;
    case 'connection':
      return <ConnectionPage />;
    case 'api':
      return <ApiPage />;
    case 'safety':
      return <SafetyPage />;
    case 'update':
      return <UpdatePage />;
    case 'about':
      return <AboutPage />;
    case 'visitors':
    case 'behavior':
    case 'proactive':
    case 'appearance':
      return <SimpleSettingsPage page={page} />;
    default:
      return <OverviewPage navigate={navigate} />;
  }
};

const Shell = () => {
  const { schema } = useStore();
  const [path, navigate] = useHashPath('/overview');
  const groups: ConsoleNavGroup[] = schema.nav.map((g) => ({
    icon: ICONS[g.items[0].icon],
    items: g.items.map((i) => ({ href: `/${i.page}`, icon: ICONS[i.icon], label: i.label })),
    key: g.key,
    label: g.label,
  }));
  const page = path.split('/')[1] || 'overview';
  return (
    <ConsoleShell
      brand={<ConsoleBrand href="#/overview" logo={<Icon icon={PawPrint} size={20} />} title="Pixel Pet 设置" />}
      navigation={
        <ConsoleNav
          defaultExpanded="all"
          groups={groups}
          label="设置"
          onNavigate={navigate}
          pathname={path}
          renderLink={({ external: _external, href, ...rest }) => <a {...rest} href={`#${href}`} />}
        />
      }
      storageKey="pixel-pet-admin-nav"
    >
      <Flexbox className={styles.page} data-admin-page={page} data-path={path} gap={16}>
        <RestartBanner />
        {/* a page that fails shows why, the navigation stays usable */}
        <ErrorBoundary
          fallbackRender={({ error }) => <Alert description={String((error as Error)?.message ?? error)} showIcon title="这一页没有显示出来" type="error" />}
          resetKeys={[path]}
        >
          <Page navigate={navigate} path={path} />
        </ErrorBoundary>
      </Flexbox>
    </ConsoleShell>
  );
};

export const ConsoleApp = () => (
  <StoreProvider
    fallback={(error) => (
      <Center height="100vh">
        {error ? (
          <Flexbox gap={8} style={{ maxWidth: 480 }}>
            <Alert description={error} title="设置窗口没有加载成功" type="error" />
            <Text type="secondary">关掉这个窗口，从桌宠的 ⋯ 菜单 → 设置… 重新打开。</Text>
          </Flexbox>
        ) : (
          <Spin />
        )}
      </Center>
    )}
  >
    <Shell />
  </StoreProvider>
);
