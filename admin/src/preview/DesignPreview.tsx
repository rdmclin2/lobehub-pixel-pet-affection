/**
 * Design-system preview (`#/design/*`): every token and base component the admin console builds on,
 * rendered with the real `@lobehub/ui` components in light and dark. Screenshots of these pages are
 * the reference for later admin pages; the page is reachable in the packaged app at
 * `src/admin-ui/index.html#/design/colors`.
 */
import {
  Alert,
  Block,
  Button,
  Flexbox,
  Icon,
  Input,
  InputPassword,
  Segmented,
  Select,
  Slider,
  Switch,
  Tag,
  Text,
  ThemeScope,
  Tooltip,
  confirmModal,
  cx,
  toast,
} from '@lobehub/ui';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import type { ConsoleNavGroup } from '@lobehub/ui/dashboard';
import { Form, useForm } from '@lobehub/ui/form';
import {
  Bell,
  Blocks,
  Brush,
  CircleGauge,
  Info,
  Mic,
  MousePointerClick,
  Palette,
  Ruler,
  Save,
  SlidersHorizontal,
  Sparkles,
  Link2,
  Trash2,
  Type,
  Volume2,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import {
  colorGroups,
  controlHeights,
  cssVar,
  fontFamilies,
  motion,
  radii,
  shadows,
  space,
  spacingTokens,
  typography,
  varName,
  type TokenEntry,
} from '../design';
import { styles } from './style';

export const DESIGN_HOME = '/design/colors';

export const designNavGroups: ConsoleNavGroup[] = [
  {
    key: 'tokens',
    label: '设计令牌',
    icon: Palette,
    items: [
      { href: '/design/colors', icon: Palette, label: '颜色（亮 / 暗）' },
      { href: '/design/typography', icon: Type, label: '字体与字号' },
      { href: '/design/layout', icon: Ruler, label: '间距 · 圆角 · 阴影' },
      { href: '/design/motion', icon: Sparkles, label: '动效' },
    ],
  },
  {
    key: 'components',
    label: '基础组件',
    icon: Blocks,
    items: [
      { href: '/design/controls', icon: MousePointerClick, label: '按钮与输入' },
      { href: '/design/display', icon: Brush, label: '卡片 · 标签 · 提示' },
      { href: '/design/form', icon: SlidersHorizontal, label: '表单项与分组' },
      { href: '/design/feedback', icon: Bell, label: 'Toast 与确认' },
    ],
  },
];

/** Resolved value of a token where it is rendered (follows the nearest `data-theme`). */
const TokenValue = ({ token }: { token: TokenEntry }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState('');
  useLayoutEffect(() => {
    if (ref.current) setValue(getComputedStyle(ref.current).getPropertyValue(varName(token.key)).trim());
  });
  return (
    <span className={styles.mono} ref={ref}>
      {value || '--'}
    </span>
  );
};

const TokenRow = ({ preview, stacked, token }: { preview?: ReactNode; stacked?: boolean; token: TokenEntry }) => {
  const label = (
    <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
      <Text>{token.role}</Text>
      <span className={styles.mono}>
        {String(token.key)} · {varName(token.key)}
      </span>
    </Flexbox>
  );
  // long values (font stacks) go under the label instead of squeezing it
  if (stacked)
    return (
      <Flexbox gap={4}>
        {label}
        <TokenValue token={token} />
      </Flexbox>
    );
  return (
    <Flexbox align="center" gap={12} horizontal>
      {preview}
      {label}
      <TokenValue token={token} />
    </Flexbox>
  );
};

const Section = ({ children, description, title }: { children: ReactNode; description?: ReactNode; title: ReactNode }) => (
  <Surface description={description} title={title}>
    <Flexbox gap={16}>{children}</Flexbox>
  </Surface>
);

const ColorsPage = () => (
  <Flexbox gap={16} horizontal>
    {(['light', 'dark'] as const).map((appearance) => (
      <ThemeScope appearance={appearance} className={styles.themeColumn} key={appearance}>
        <Flexbox gap={24}>
          <Text strong>{appearance === 'light' ? '亮色主题' : '暗色主题'}</Text>
          {colorGroups.map((group) => (
            <Flexbox gap={12} key={group.title}>
              <Text type="secondary">{group.title}</Text>
              {group.tokens.map((token) => (
                <TokenRow
                  key={String(token.key)}
                  preview={<span className={styles.swatch} style={{ background: cssVar[token.key] }} />}
                  token={token}
                />
              ))}
            </Flexbox>
          ))}
        </Flexbox>
      </ThemeScope>
    ))}
  </Flexbox>
);

const TypographyPage = () => (
  <Flexbox gap={16}>
    <Section description="字体由主题提供，组件里不写 font-family" title="字体">
      {fontFamilies.map((token) => (
        <Flexbox gap={8} key={String(token.key)}>
          <TokenRow stacked token={token} />
          <Text code={token.key === 'fontFamilyCode'}>Claude 已连接 · 端点 http://127.0.0.1:8080 · 你好呀</Text>
        </Flexbox>
      ))}
    </Section>
    <Section description="字阶只取主题 fontSize* 档位" title="字号">
      {typography.map((token) => (
        <Flexbox gap={4} key={String(token.key)}>
          <span
            style={{
              fontSize: cssVar[token.key],
              fontWeight: token.key.startsWith('fontSizeHeading') ? cssVar.fontWeightStrong : undefined,
              lineHeight: token.lineHeight ? cssVar[token.lineHeight] : undefined,
            }}
          >
            {token.sample}
          </span>
          <TokenRow token={token} />
        </Flexbox>
      ))}
    </Section>
  </Flexbox>
);

const LayoutPage = () => (
  <Flexbox gap={16}>
    <Section description="4 px 网格；Flexbox gap 取 2 / 4 / 8 / 12 / 16 / 24 档" title="间距档位（space）">
      {Object.entries(space).map(([key, px]) => (
        <Flexbox align="center" gap={12} horizontal key={key}>
          <span className={styles.mono} style={{ width: 64 }}>
            {key}
          </span>
          <span className={styles.spaceBar} style={{ width: px * 4 }} />
          <span className={styles.mono}>{px}px</span>
        </Flexbox>
      ))}
    </Section>
    <Section title="主题内边距">
      {spacingTokens.map((token) => (
        <TokenRow key={String(token.key)} token={token} />
      ))}
    </Section>
    <Section description="嵌套时内层 = 外层 − 内边距" title="圆角">
      <Flexbox gap={24} horizontal wrap="wrap">
        {radii.map((token) => (
          <Flexbox gap={8} key={String(token.key)}>
            <span className={styles.radiusBox} style={{ borderRadius: cssVar[token.key] }} />
            <Text fontSize={12}>{token.role}</Text>
            <span className={styles.mono}>{String(token.key)}</span>
            <TokenValue token={token} />
          </Flexbox>
        ))}
      </Flexbox>
    </Section>
    <Section description="阴影按档位取，不做彩色光晕" title="阴影">
      <Flexbox gap={32} horizontal wrap="wrap">
        {shadows.map((token) => (
          <Flexbox gap={8} key={String(token.key)}>
            <span className={styles.shadowBox} style={{ boxShadow: cssVar[token.key] }} />
            <Text fontSize={12}>{token.role}</Text>
            <span className={styles.mono}>{String(token.key)}</span>
          </Flexbox>
        ))}
      </Flexbox>
    </Section>
    <Section title="控件高度">
      {controlHeights.map((token) => (
        <TokenRow key={String(token.key)} token={token} />
      ))}
    </Section>
  </Flexbox>
);

const MotionPage = () => {
  const [on, setOn] = useState(false);
  const durations = motion.filter((m) => String(m.key).startsWith('motionDuration'));
  const easings = motion.filter((m) => String(m.key).startsWith('motionEase'));
  return (
    <Flexbox gap={16}>
      <Section
        description="入场 ease-out，状态切换 ease-in-out；不用弹跳曲线，系统开启「减少动态效果」时不播放"
        title="时长与缓动"
      >
        <Flexbox>
          <Button icon={CircleGauge} onClick={() => setOn((v) => !v)} style={{ alignSelf: 'flex-start' }}>
            播放动效
          </Button>
        </Flexbox>
        {durations.map((token) => (
          <Flexbox align="center" gap={16} horizontal key={String(token.key)}>
            <span className={styles.motionTrack}>
              <span
                className={cx(styles.motionDot, on && styles.motionDotOn)}
                style={{ transitionDuration: cssVar[token.key], transitionTimingFunction: cssVar.motionEaseOut }}
              />
            </span>
            <Flexbox flex={1}>
              <TokenRow token={token} />
            </Flexbox>
          </Flexbox>
        ))}
        {easings.map((token) => (
          <TokenRow key={String(token.key)} token={token} />
        ))}
      </Section>
    </Flexbox>
  );
};

const ControlsPage = () => {
  const [voice, setVoice] = useState(true);
  const [volume, setVolume] = useState(70);
  const [engine, setEngine] = useState('edge');
  return (
    <Flexbox gap={16}>
      <Section description="每屏只有一个主操作；危险操作用 danger" title="按钮">
        <Flexbox align="center" gap={8} horizontal wrap="wrap">
          <Button icon={Save} type="primary">
            保存设置
          </Button>
          <Button>检查更新</Button>
          <Button type="dashed">导入角色包</Button>
          <Button type="text">恢复默认</Button>
          <Button danger icon={Trash2}>
            删除角色包
          </Button>
          <Button disabled>正在下载</Button>
          <Button loading>正在连接</Button>
        </Flexbox>
        <Flexbox align="center" gap={8} horizontal>
          <Button size="small">小号</Button>
          <Button>默认</Button>
          <Button size="large">大号</Button>
        </Flexbox>
      </Section>
      <Section title="输入框">
        <Flexbox gap={12}>
          <Input className={styles.fieldControl} defaultValue="http://127.0.0.1:8080/v1" prefix={<Icon icon={Link2} />} />
          <Input className={styles.fieldControl} placeholder="例如 gpt-4o-mini" variant="filled" />
          <InputPassword className={styles.fieldControl} defaultValue="sk-pet-a1b2c3" placeholder="填写 API Key" />
        </Flexbox>
      </Section>
      <Section description="开关只给即时生效的二值项" title="开关 · 滑块 · 下拉 · 分段">
        <Flexbox align="center" gap={12} horizontal>
          <Switch checked={voice} onChange={setVoice} />
          <Text>{voice ? '回复时自动朗读：开' : '回复时自动朗读：关'}</Text>
          <Switch defaultChecked size="small" />
          <Switch disabled />
        </Flexbox>
        <Flexbox align="center" gap={12} horizontal>
          <Icon icon={Volume2} />
          <Slider className={styles.fieldControl} max={100} min={0} onChange={setVolume} value={volume} />
          <Text type="secondary">音量 {volume}%</Text>
        </Flexbox>
        <Select
          className={styles.fieldControl}
          onChange={(v) => setEngine(v as string)}
          options={[
            { label: 'Edge 在线朗读', value: 'edge' },
            { label: '本机 TTS 服务', value: 'local' },
            { label: '火山引擎', value: 'volc' },
            { label: '关闭朗读', value: 'off' },
          ]}
          value={engine}
        />
        <Segmented
          options={[
            { label: '跟随系统', value: 'auto' },
            { label: '亮色', value: 'light' },
            { label: '暗色', value: 'dark' },
          ]}
          defaultValue="auto"
        />
      </Section>
    </Flexbox>
  );
};

const DisplayPage = () => (
  <Flexbox gap={16}>
    <Section description="Block 的三种表面形态" title="卡片">
      <Flexbox gap={12} horizontal wrap="wrap">
        {(['filled', 'outlined', 'borderless'] as const).map((variant) => (
          <Block key={variant} padding={16} style={{ width: 220 }} variant={variant}>
            <Flexbox gap={4}>
              <Text strong>Claude</Text>
              <Text fontSize={12} type="secondary">
                好感 62 · 外观：像素小猫 · {variant}
              </Text>
            </Flexbox>
          </Block>
        ))}
        <Block clickable padding={16} shadow style={{ width: 220 }} variant="outlined">
          <Flexbox gap={4}>
            <Text strong>可点击卡片</Text>
            <Text fontSize={12} type="secondary">
              悬停有反馈 · 带阴影
            </Text>
          </Flexbox>
        </Block>
      </Flexbox>
    </Section>
    <Section title="标签">
      <Flexbox gap={8} horizontal wrap="wrap">
        <Tag>sprites</Tag>
        <Tag color="success">已连接</Tag>
        <Tag color="warning">需要 Key</Tag>
        <Tag color="error">18+</Tag>
        <Tag color="processing">下载中</Tag>
        <Tag color="geekblue">vrm</Tag>
        <Tag color="purple">live2d</Tag>
        <Tag variant="outlined">内置</Tag>
        <Tag closable>用户导入</Tag>
      </Flexbox>
    </Section>
    <Section title="提示">
      <Alert description="改动立即写入 settings.json，桌宠窗口同步刷新。" title="设置已自动保存" type="success" />
      <Alert description="本机 TTS 服务 http://127.0.0.1:9880 没有响应，已回退到 Edge 在线朗读。" title="朗读引擎不可用" type="warning" />
      <Alert description="删除后无法恢复，角色的好感与服饰记录会一起移除。" title="删除角色包" type="error" />
      <Alert icon={Info} title="快捷键 Ctrl + , 可随时打开设置窗口" type="info" />
      <Flexbox align="center" gap={8} horizontal>
        <Tooltip title="按住说话，松开发送">
          <Button icon={Mic}>语音输入</Button>
        </Tooltip>
        <Text type="secondary">悬停查看 Tooltip</Text>
      </Flexbox>
    </Section>
  </Flexbox>
);

interface PetPrefs {
  autoSpeak: boolean;
  engine: string;
  roam: boolean;
  scale: number;
  ttsKey: string;
}

const FormPage = () => {
  const form = useForm<PetPrefs>({
    initialValues: { autoSpeak: true, engine: 'edge', roam: true, scale: 100, ttsKey: '' },
  });
  return (
    <Form
      form={form}
      itemsType="group"
      items={[
        {
          key: 'pet',
          title: '桌宠行为',
          icon: SlidersHorizontal,
          children: [
            { name: 'roam', label: '自由漫步', desc: '空闲时在屏幕底部走动', children: <Switch />, valueProp: 'checked', layout: 'horizontal' },
            { name: 'scale', label: '显示大小', desc: '桌宠窗口缩放比例（%）', children: <Slider max={200} min={50} step={10} style={{ width: 200 }} /> },
          ],
        },
        {
          key: 'tts',
          title: '语音朗读',
          icon: Volume2,
          extra: <Tag color="success">已连接</Tag>,
          children: [
            { name: 'autoSpeak', label: '回复时自动朗读', children: <Switch />, valueProp: 'checked' },
            {
              name: 'engine',
              label: '朗读引擎',
              desc: '在线引擎需要联网',
              children: (
                <Select
                  options={[
                    { label: 'Edge 在线朗读', value: 'edge' },
                    { label: '本机 TTS 服务', value: 'local' },
                    { label: '火山引擎', value: 'volc' },
                  ]}
                  style={{ width: 200 }}
                />
              ),
            },
            { name: 'ttsKey', label: 'API Key', desc: '只写入，不回显', children: <InputPassword placeholder="填写 API Key" style={{ width: 240 }} /> },
          ],
        },
      ]}
      variant="filled"
    />
  );
};

const FeedbackPage = () => (
  <Flexbox gap={16}>
    <Section description="右下角弹出，自动消失" title="Toast">
      <Flexbox gap={8} horizontal wrap="wrap">
        <Button onClick={() => toast.success('设置已保存')}>成功</Button>
        <Button onClick={() => toast.info('已切换到 Claude')}>信息</Button>
        <Button onClick={() => toast.warning('本机 TTS 未响应，已回退到 Edge')}>警告</Button>
        <Button onClick={() => toast.error('导入失败：pet.json 缺少 id 字段')}>错误</Button>
      </Flexbox>
    </Section>
    <Section description="高风险操作先确认" title="确认弹窗">
      <Flexbox horizontal>
        <Button
          danger
          icon={Trash2}
          onClick={() =>
            confirmModal({
              cancelText: '取消', // confirmModal hard-codes "Cancel"/"OK" (not i18n): always pass both
              content: '删除后无法恢复，角色的好感与服饰记录会一起移除。',
              okButtonProps: { danger: true },
              okText: '删除角色包',
              onOk: () => toast.success('已删除角色包「像素小猫」'),
              title: '删除角色包「像素小猫」？',
            })
          }
        >
          删除角色包
        </Button>
      </Flexbox>
    </Section>
  </Flexbox>
);

const pages: Record<string, { description: string; render: () => ReactNode; title: string }> = {
  '/design/colors': { title: '颜色', description: '颜色按角色取 token，亮色和暗色主题使用同一套名字', render: () => <ColorsPage /> },
  '/design/typography': { title: '字体与字号', description: '字体栈与字阶都来自主题', render: () => <TypographyPage /> },
  '/design/layout': { title: '间距 · 圆角 · 阴影', description: '几何取值：4 px 网格、嵌套圆角、分档阴影', render: () => <LayoutPage /> },
  '/design/motion': { title: '动效', description: '动效时长与缓动的取值', render: () => <MotionPage /> },
  '/design/controls': { title: '按钮与输入', description: '按钮、输入框、开关、滑块、下拉与分段控件', render: () => <ControlsPage /> },
  '/design/display': { title: '卡片 · 标签 · 提示', description: '展示类组件', render: () => <DisplayPage /> },
  '/design/form': { title: '表单项与分组', description: '和 LobeHub 设置页一样，使用 filled 表单分组', render: () => <FormPage /> },
  '/design/feedback': { title: 'Toast 与确认', description: '操作反馈与高风险确认', render: () => <FeedbackPage /> },
};

export const DesignPreview = ({ path }: { path: string }) => {
  const page = pages[path] ?? pages[DESIGN_HOME];
  return (
    <div className={styles.page} data-design-page={path}>
      <Flexbox gap={24}>
        <PageHeader description={page.description} title={page.title} />
        {page.render()}
      </Flexbox>
    </div>
  );
};
