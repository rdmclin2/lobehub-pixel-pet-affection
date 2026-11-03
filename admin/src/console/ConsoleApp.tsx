import { Alert, Button, Center, Empty, Flexbox, Spin, Text } from '@lobehub/ui';
import { Compass } from 'lucide-react';
import { useEffect } from 'react';

import { replaceHash, useHashPath } from '../useHashPath';
import './common';
import { ChatPage } from './pages/Chat';
import { CharacterDetailPage, CharactersPage, PacksPage } from './pages/Characters';
import { OverviewPage } from './pages/Home';
import { HubPage } from './pages/Hub';
import { InterjectPage } from './pages/Interject';
import { StorePage } from './pages/Store';
import { DeskPage, TopicsPage } from './pages/Together';
import { AboutPage, ApiPage, AsrPage, BehaviorPage, ConnectionPage, ProactivePage, ResetPage, SafetyPage, SimpleSettingsPage, TtsPage, UpdatePage, VoicePacksPage } from './pages/Pages';
import { Shell } from './Shell';
import { StoreProvider, useStore } from './store';

/** A02 (SH-03): an address with no page says so (P-03 不存在 ≠ 首页, M-03 #9), with the two ways out. */
const NotFound = ({ path }: { path: string }) => (
  <Center data-not-found style={{ minHeight: 360 }}>
    <Empty
      action={
        <Flexbox gap={8} horizontal>
          <Button href="#/overview" type="primary">
            回小屋
          </Button>
          <Button href="#/settings">去设置</Button>
        </Flexbox>
      }
      description={`「#${path}」不是设置窗口里的页面：可能是旧链接，或者地址打错了。`}
      icon={Compass}
      title="没有这个页面"
    />
  </Center>
);

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
    case 'desk':
      return <DeskPage />;
    case 'behavior':
      return <BehaviorPage />;
    case 'proactive':
      return <ProactivePage />;
    case 'interject':
      return <InterjectPage />;
    case 'reset':
      return <ResetPage />;
    case 'visitors':
      return <SimpleSettingsPage page={page} />;
    default:
      return <NotFound path={path} />;
  }
};

const Console = () => {
  const [path, navigate] = useHashPath('/overview');
  const { schema, roster } = useStore();
  // A00: old routes land where the page lives now (#/history → 聊天 with her, #/appearance → 关于与数据)
  const moved = schema.redirects?.[path.split('/')[1]];
  const cur = roster.find((c) => c.current);
  const to = moved === 'chat' ? `/chat${cur ? `/${cur.id}` : ''}` : moved ? `/${moved}` : null;
  useEffect(() => {
    if (to) replaceHash(to);
  }, [to]);
  if (to) return null;
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
