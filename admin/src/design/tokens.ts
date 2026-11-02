/**
 * Pixel Pet design tokens — the admin console's single source of visual values.
 *
 * Every value is a `cssVar` reference from `@lobehub/ui` (lobe-design D-01): the variables are defined in
 * `@lobehub/ui/theme.css` for `[data-theme='light']` and `[data-theme='dark']`, so styles written with them
 * follow the appearance with no branches (D-08). This file only *names the roles* the console uses
 * (D-02), so pages pick "page background" or "secondary text" instead of a colour.
 *
 * Project-only values (spacing scale, layout widths) are plain numbers on the 4 px grid (D-10.2);
 * they never become `--lobe-*` variables (D-07).
 */
import { cssVar } from '@lobehub/ui';

type CssVarKey = keyof typeof cssVar;

export interface TokenEntry {
  /** `cssVar` key, e.g. `colorBgLayout`. */
  key: CssVarKey;
  /** What the token is for, in the console's words. */
  role: string;
}

const t = (key: CssVarKey, role: string): TokenEntry => ({ key, role });

/** D-02 colour roles. Light and dark values come from theme.css. */
export const colorGroups: { title: string; tokens: TokenEntry[] }[] = [
  {
    title: '表面',
    tokens: [
      t('colorBgLayout', '窗口底色（设置窗口背景）'),
      t('colorBgContainer', '卡片 / 表单分组表面'),
      t('colorBgContainerSecondary', '介于底色与卡片之间'),
      t('colorBgElevated', '浮层：下拉、弹窗、Toast'),
      t('colorBgMask', '弹窗遮罩'),
    ],
  },
  {
    title: '文字',
    tokens: [
      t('colorText', '主文字'),
      t('colorTextSecondary', '次要文字'),
      t('colorTextTertiary', '更弱的文字'),
      t('colorTextQuaternary', '最弱的文字 / 占位'),
      t('colorTextDescription', '表单项说明'),
    ],
  },
  {
    title: '边框与填充',
    tokens: [
      t('colorBorder', '边框'),
      t('colorBorderSecondary', '分割线 / 弱边框'),
      t('colorFill', '填充 1 档'),
      t('colorFillSecondary', '填充 2 档（悬停底）'),
      t('colorFillTertiary', '填充 3 档（filled 控件底）'),
      t('colorFillQuaternary', '填充 4 档（轨道）'),
    ],
  },
  {
    title: '品牌与状态',
    tokens: [
      t('colorPrimary', '主操作（每屏一个）'),
      t('colorPrimaryHover', '主操作悬停'),
      t('colorSuccess', '成功：已保存、已连接'),
      t('colorWarning', '警告：需要注意的配置'),
      t('colorError', '错误 / 危险操作'),
      t('colorInfo', '提示信息'),
      t('colorLink', '正文链接'),
    ],
  },
];

/** Type scale (D-04 / A-02): sizes from the theme, never a literal in components. */
export const typography: (TokenEntry & { sample: string; lineHeight?: CssVarKey })[] = [
  { ...t('fontSizeHeading2', '页面标题'), lineHeight: 'lineHeightHeading2', sample: '桌宠设置' },
  { ...t('fontSizeHeading4', '分组标题'), lineHeight: 'lineHeightHeading4', sample: '语音朗读' },
  { ...t('fontSizeLG', '强调正文'), lineHeight: 'lineHeightLG', sample: '当前角色：Claude' },
  { ...t('fontSize', '正文 / 表单标签'), lineHeight: 'lineHeight', sample: '回复时自动朗读' },
  { ...t('fontSizeSM', '说明 / 辅助文字'), lineHeight: 'lineHeightSM', sample: '只在桌宠窗口获得焦点时生效' },
];

export const fontFamilies: TokenEntry[] = [
  t('fontFamily', '界面字体（西文 → 中文 → 回退 → emoji）'),
  t('fontFamilyCode', '等宽：端点、路径、Key'),
];

/** Spacing scale on the 4 px grid — matches the Flexbox `gap` presets (D-10.2). */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export type SpaceKey = keyof typeof space;

/** Theme spacing tokens used by lobe-ui itself, listed so the preview can show them next to `space`. */
export const spacingTokens: TokenEntry[] = [
  t('paddingXXS', '最小内边距'),
  t('paddingXS', '紧凑内边距'),
  t('paddingSM', '控件内边距'),
  t('padding', '默认内边距'),
  t('paddingMD', '卡片内边距'),
  t('paddingLG', '分组内边距'),
  t('paddingXL', '页面内边距'),
];

/** Radius nests: inner = outer − padding (D-04). */
export const radii: TokenEntry[] = [
  t('borderRadiusXS', '标签、徽标'),
  t('borderRadiusSM', '小控件'),
  t('borderRadius', '按钮、输入框'),
  t('borderRadiusLG', '卡片、表单分组、弹窗'),
];

export const shadows: TokenEntry[] = [
  t('boxShadowTertiary', '静态卡片（轻）'),
  t('boxShadow', '浮层：下拉、Popover'),
  t('boxShadowSecondary', '弹窗、Toast'),
];

/** Motion: short ease-out for enter, ease-in-out for state changes; no bounce (K-06). */
export const motion: TokenEntry[] = [
  t('motionDurationFast', '悬停、按下'),
  t('motionDurationMid', '展开、切换'),
  t('motionDurationSlow', '弹窗进出'),
  t('motionEaseOut', '入场缓动'),
  t('motionEaseInOut', '状态切换缓动'),
];

export const controlHeights: TokenEntry[] = [
  t('controlHeightSM', '小号控件'),
  t('controlHeight', '默认控件高度'),
  t('controlHeightLG', '大号控件'),
];

/** Layout constants of the settings window (LobeHub `/settings`: content max 1024). */
export const layout = {
  contentMaxWidth: 1024,
  windowMinWidth: 860,
  windowMinHeight: 560,
} as const;

/** CSS variable name behind a token, e.g. `--lobe-color-bg-layout`. */
export const varName = (key: CssVarKey): string => String(cssVar[key]).replace(/^var\((--[^,)]+).*$/, '$1');

export { cssVar };
