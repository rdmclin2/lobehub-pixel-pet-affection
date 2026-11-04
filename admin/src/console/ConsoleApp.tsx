import { Alert, Center, Flexbox, Spin, Text } from '@lobehub/ui';

import { useHashPath } from '../useHashPath';
import { ChatPage } from './pages/Chat';
import { CharacterDetailPage, CharactersPage, PacksPage } from './pages/Characters';
import { OverviewPage } from './pages/Home';
import { HubPage } from './pages/Hub';
import { DancesPage } from './pages/Dances';
import { StorePage } from './pages/Store';
import { DeskPage, HistoryPage, TopicsPage } from './pages/Together';
import { AboutPage, ApiPage, AsrPage, BehaviorPage, ConnectionPage, ProactivePage, SafetyPage, SimpleSettingsPage, TtsPage, UpdatePage, VoicePacksPage } from './pages/Pages';
import { Shell } from './Shell';
import { StoreProvider } from './store';

const Page = ({ path, navigate }: { navigate: (p: string) => void; path: string }) => {
  const [, page, sub] = path.split('/');
  switch (page) {
    case 'overview':
      return <OverviewPage navigate={navigate} />;
    case 'characters':
      return sub ? <CharacterDetailPage id={sub} key={sub} navigate={navigate} /> : <CharactersPage navigate={navigate} />;
    case 'store':
      return <StorePage />;
    case 'chat':
      return <ChatPage id={sub} key="chat" navigate={navigate} />;
    case 'play':
      return <HubPage key="play" place="play" />;
    case 'settings':
      return <HubPage key="settings" place="settings" />;
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
    case 'topics':
      return <TopicsPage />;
    case 'history':
      return <HistoryPage />;
    case 'desk':
      return <DeskPage />;
    case 'dances':
      return <DancesPage />;
    case 'behavior':
      return <BehaviorPage />;
    case 'proactive':
      return <ProactivePage />;
    case 'visitors':
    case 'appearance':
    case 'music':
      return <SimpleSettingsPage page={page} />;
    default:
      return <OverviewPage navigate={navigate} />;
  }
};

const Console = () => {
  const [path, navigate] = useHashPath('/overview');
  return (
    <Shell path={path}>
      <Page navigate={navigate} path={path} />
    </Shell>
  );
};

export const ConsoleApp = () => (
  <StoreProvider
    fallback={(error) => (
      <Center height="100vh">
        {error ? (
          <Flexbox gap={8} style={{ maxWidth: 480 }}>
            <Alert description={error} title="设置窗口没有加载成功" type="error" />
            <Text type="secondary">关掉这个窗口，点桌宠的 ⚙ 设置按钮（或 Ctrl/⌘ + ,）重新打开。</Text>
          </Flexbox>
        ) : (
          <Spin />
        )}
      </Center>
    )}
  >
    <Console />
  </StoreProvider>
);
