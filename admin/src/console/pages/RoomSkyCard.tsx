/**
 * 她的房间 → 窗外 (docs/room.md §5): the hour and the weather outside her window — the same controls as the 天色
 * card in 像素小院 (‹ 时段 ›, a time slider, 随时间流动, 对齐本机时间, ‹ 天气 ›, 天气自己变), and the same settings.
 */
import { ActionIcon, Block, createStaticStyles, Flexbox, Icon, Slider, Switch, Text } from '@lobehub/ui';
import { ChevronLeft, ChevronRight, Cloud, CloudFog, CloudLightning, CloudRain, Moon, Snowflake, Sun, Sunrise, Sunset } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import GameSky from '../../../../src/core/game-sky.js';
import type { RoomSkyControls, RoomSkyState } from '../stage/useRoomSky';

const styles = createStaticStyles(({ css }) => ({
  cols: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 24px;

    @media (width <= 700px) {
      grid-template-columns: 1fr;
    }
  `,
}));

const PHASE_ICON: Record<string, LucideIcon> = { dawn: Sunrise, day: Sun, dusk: Sunset, night: Moon };
const WEATHER_ICON: Record<string, LucideIcon> = { clear: Sun, cloudy: Cloud, rain: CloudRain, storm: CloudLightning, snow: Snowflake, fog: CloudFog };

const Toggle = ({ checked, label, hint, onChange, tag }: { checked: boolean; hint?: string; label: string; onChange: (on: boolean) => void; tag: string }) => (
  <Flexbox align="center" gap={8} horizontal justify="space-between">
    <Flexbox gap={0}>
      <Text fontSize={13}>{label}</Text>
      {hint && (
        <Text fontSize={12} type="secondary">
          {hint}
        </Text>
      )}
    </Flexbox>
    <Switch aria-label={label} checked={checked} data-room-sky-toggle={tag} onChange={onChange} size="small" />
  </Flexbox>
);

export const RoomSkyCard = ({ sky, on }: { on: RoomSkyControls; sky: RoomSkyState }) => {
  const weather = GameSky.weatherOf(sky.weather);
  return (
    <Block data-room-sky gap={10} padding={12} variant="outlined">
      <Flexbox align="center" gap={8} horizontal justify="space-between">
        <Text strong>窗外</Text>
        <Text data-room-sky-now fontSize={12} type="secondary">
          {GameSky.phaseName(sky.phase)} {GameSky.formatHour(sky.hour)} · {weather.name}
        </Text>
      </Flexbox>
      <div className={styles.cols}>
        <Flexbox gap={8}>
          <Flexbox align="center" gap={4} horizontal>
            <Icon icon={PHASE_ICON[sky.phase] ?? Sun} size={16} />
            <ActionIcon data-room-sky-phase-step="-1" icon={ChevronLeft} onClick={() => on.stepPhase(-1)} size="small" title="上一个时段" />
            <Text data-room-sky-phase={sky.phase} style={{ minWidth: 32, textAlign: 'center' }}>
              {GameSky.phaseName(sky.phase)}
            </Text>
            <ActionIcon data-room-sky-phase-step="1" icon={ChevronRight} onClick={() => on.stepPhase(1)} size="small" title="下一个时段" />
            <Text data-room-sky-clock style={{ marginInlineStart: 'auto' }} type="secondary">
              {GameSky.formatHour(sky.hour)}
            </Text>
          </Flexbox>
          <Slider aria-label="时刻" data-room-sky-slider max={23.75} min={0} onChange={(v: number) => on.setHour(v)} onChangeComplete={(v: number) => on.setHour(v, true)} step={0.25} value={Math.round(sky.hour * 4) / 4} />
          <Toggle checked={sky.dayFlow} hint="一天 24 分钟，现实一分钟是一小时" label="随时间流动" onChange={on.setDayFlow} tag="flow" />
          <Toggle checked={sky.followClock} hint="窗外就是这台电脑的时间" label="对齐本机时间" onChange={on.setFollowClock} tag="clock" />
        </Flexbox>
        <Flexbox gap={8}>
          <Flexbox align="center" gap={4} horizontal>
            <Icon icon={WEATHER_ICON[sky.weather] ?? Sun} size={16} />
            <ActionIcon data-room-sky-weather-step="-1" icon={ChevronLeft} onClick={() => on.stepWeather(-1)} size="small" title="上一种天气" />
            <Text data-room-sky-weather={sky.weather} style={{ minWidth: 32, textAlign: 'center' }}>
              {weather.name}
            </Text>
            <ActionIcon data-room-sky-weather-step="1" icon={ChevronRight} onClick={() => on.stepWeather(1)} size="small" title="下一种天气" />
          </Flexbox>
          <Toggle checked={sky.autoWeather} hint="每 3–8 分钟换一次；手动选天气会关掉它" label="天气自己变" onChange={on.setAutoWeather} tag="auto" />
          <Text fontSize={12} type="secondary">
            和像素小院用同一份时间和天气。夜里房间的灯会亮；下雨、下雪、起雾、打雷都在窗外看得见。
          </Text>
        </Flexbox>
      </div>
    </Block>
  );
};
