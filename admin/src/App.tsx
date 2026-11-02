import { ConsoleBrand, ConsoleNav, ConsoleShell } from '@lobehub/ui/dashboard';
import { Icon } from '@lobehub/ui';
import { PawPrint } from 'lucide-react';

import { ConsoleApp } from './console/ConsoleApp';
import { designNavGroups, DesignPreview, DESIGN_HOME } from './preview/DesignPreview';
import { useHashPath } from './useHashPath';

/** The design-system preview (`#/design/*`, scripts/design-preview.js) — no main-process bridge needed. */
const DesignApp = () => {
  const [path, navigate] = useHashPath(DESIGN_HOME);
  return (
    <ConsoleShell
      brand={<ConsoleBrand href="#/design/colors" logo={<Icon icon={PawPrint} size={20} />} title="Pixel Pet 设置" />}
      navigation={
        <ConsoleNav
          defaultExpanded="all"
          groups={designNavGroups}
          label="设计系统"
          onNavigate={navigate}
          pathname={path}
          renderLink={({ external: _external, href, ...rest }) => <a {...rest} href={`#${href}`} />}
        />
      }
      storageKey="pixel-pet-admin-nav"
    >
      <DesignPreview path={path} />
    </ConsoleShell>
  );
};

/** `#/design/*` is the design-system preview; everything else is the settings console (配置后台). */
const App = () => (location.hash.startsWith('#/design') ? <DesignApp /> : <ConsoleApp />);

export default App;
