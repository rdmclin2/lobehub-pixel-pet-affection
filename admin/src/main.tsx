import '@lobehub/ui/theme.css';
import '@lobehub/ui/global.css';
import '@lobehub/ui/style.css';

import { createRoot } from 'react-dom/client';

import { DesignProvider, initAppearance } from './design';
import App from './App';

initAppearance();

createRoot(document.getElementById('root')!).render(
  <DesignProvider>
    <App />
  </DesignProvider>,
);
