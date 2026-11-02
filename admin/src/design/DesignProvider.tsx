import { ConfigProvider, ModalHost, ToastHost } from '@lobehub/ui';
import { motion } from 'motion/react';
import {
  burger,
  chat,
  colorPicker,
  common,
  datePicker,
  editableMessage,
  emojiPicker,
  form,
  hotkey,
  image,
  messageModal,
  qrCode,
  sideNav,
  table,
  video,
} from '@lobehub/ui/i18n/resources/zhCn/index';
import type { ReactNode } from 'react';

/** Built-in component texts (Cancel → 取消 …). `locale` alone does not load them. */
const zhCN = [burger, chat, colorPicker, common, datePicker, editableMessage, emojiPicker, form, hotkey, image, messageModal, qrCode, sideNav, table, video];

/**
 * Root provider for every admin page: lobe-ui config + the hosts `toast.*` and `confirmModal` render into.
 * `enableCustomFonts={false}`: no remote web fonts (Geist / HarmonyOS / KaTeX CSS from the CDN). The window is offline
 * under CSP, so the theme's system font stack (PingFang SC, Microsoft YaHei …) is used.
 */
export const DesignProvider = ({ children }: { children: ReactNode }) => (
  <ConfigProvider enableCustomFonts={false} locale="zh-CN" motion={motion} resources={zhCN}>
    {children}
    <ModalHost />
    <ToastHost position="bottom-right" />
  </ConfigProvider>
);
