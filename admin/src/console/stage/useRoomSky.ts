/**
 * 窗外的天色 (docs/room.md §5): the room's hour and weather, the same ones 像素小院 uses (settings.scene, shared by
 * every mini game; src/core/game-sky.js). Time stands, flows (one day = 24 minutes) or follows this computer's
 * clock; ‹ › jumps between 清晨 / 白天 / 黄昏 / 夜晚 in about a second; a new weather fades in over 3 seconds and
 * can change by itself every 3–8 minutes. What is chosen here is saved at once; a flowing hour is saved when
 * the page closes, like the game window does.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import GameSky, { type Grade, type Weather } from '../../../../src/core/game-sky.js';
import RoomSky from '../../../../src/core/room-sky.js';

export interface SceneSettings {
  autoWeather: boolean;
  dayFlow: boolean;
  followClock: boolean;
  hour: number;
  weather: string;
}

export interface RoomSkyState {
  autoWeather: boolean;
  dayFlow: boolean;
  followClock: boolean;
  grade: Grade;
  hour: number;
  phase: string;
  /** the weather the sky is going to (what the card shows); `grade.weather` is the mix while it fades */
  weather: string;
}

export interface RoomSkyControls {
  setAutoWeather: (on: boolean) => void;
  setDayFlow: (on: boolean) => void;
  setFollowClock: (on: boolean) => void;
  /** the slider: the hour at once (stops following the clock); `commit` saves it */
  setHour: (h: number, commit?: boolean) => void;
  stepPhase: (dir: number) => void;
  /** ‹ › on the weather: a manual choice turns 天气自己变 off */
  stepWeather: (dir: number) => void;
}

const JUMP_MS = 1000;
const smooth = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};

export const useRoomSky = (scene: SceneSettings | undefined, save: (key: string, value: unknown) => unknown): [RoomSkyState, RoomSkyControls] => {
  const s: SceneSettings = scene ?? { autoWeather: false, dayFlow: true, followClock: false, hour: 8, weather: 'clear' };
  const live = useRef(s);
  live.current = s;
  const hour = useRef(s.followClock ? GameSky.clockHour() : s.hour);
  const jump = useRef<{ from: number; t0: number; to: number } | null>(null);
  const fade = useRef<{ from: string; t0: number; to: string }>({ from: s.weather, t0: 0, to: s.weather });
  const autoAt = useRef(Date.now() + GameSky.autoDelay() * 1000);
  const last = useRef(performance.now());
  const [, render] = useState(0);
  const wake = useRef<() => void>(() => {});

  // a weather chosen anywhere (here, the settings page, the game window) fades in
  useEffect(() => {
    const f = fade.current;
    if (f.to === s.weather) return;
    const now = performance.now();
    const k = Math.min(1, (now - f.t0) / (GameSky.FADE_S * 1000));
    fade.current = { from: k < 0.5 ? f.from : f.to, t0: now, to: s.weather };
  }, [s.weather]);

  // the clock: a frame at a time while something moves (a jump, a fade), once a second otherwise
  useEffect(() => {
    let t = 0;
    const tick = () => {
      clearTimeout(t);
      const now = performance.now();
      const dt = (now - last.current) / 1000;
      last.current = now;
      const cur = live.current;
      const j = jump.current;
      if (j) {
        const u = (now - j.t0) / JUMP_MS;
        hour.current = GameSky.wrapHour(j.from + GameSky.hourDelta(j.from, j.to) * smooth(u));
        if (u >= 1) jump.current = null;
      } else if (cur.followClock) hour.current = GameSky.clockHour();
      else if (cur.dayFlow) hour.current = GameSky.wrapHour(hour.current + GameSky.flowHours(dt));
      if (cur.autoWeather && Date.now() >= autoAt.current) {
        autoAt.current = Date.now() + GameSky.autoDelay() * 1000;
        save('scene.weather', GameSky.nextWeather(cur.weather));
      }
      render((n) => n + 1);
      const fading = now - fade.current.t0 < GameSky.FADE_S * 1000;
      t = window.setTimeout(tick, jump.current || fading ? 33 : 1000);
    };
    wake.current = tick;
    tick();
    return () => {
      clearTimeout(t);
      wake.current = () => {};
    };
  }, [save, s.weather]);

  // a flowing hour is kept where it was when the page closes (or the window hides)
  useEffect(() => {
    const keep = () => {
      const cur = live.current;
      if (cur.dayFlow && !cur.followClock) save('scene.hour', RoomSky.quarter(hour.current));
    };
    const onHide = () => document.visibilityState === 'hidden' && keep();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', keep);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', keep);
      keep();
    };
  }, [save]);

  const now = performance.now();
  const f = fade.current;
  const mix: Weather = GameSky.mixWeather(f.from, f.to, Math.min(1, (now - f.t0) / (GameSky.FADE_S * 1000)));
  const grade = GameSky.grade(hour.current, mix);
  const state: RoomSkyState = { autoWeather: s.autoWeather, dayFlow: s.dayFlow, followClock: s.followClock, grade, hour: hour.current, phase: grade.phase, weather: s.weather };

  // something moved by hand: draw it now and run the clock a frame at a time while it eases
  const kick = () => wake.current();
  const controls: RoomSkyControls = {
    setAutoWeather: useCallback((on: boolean) => save('scene.autoWeather', on), [save]),
    setDayFlow: useCallback(
      (on: boolean) => {
        save('scene.hour', RoomSky.quarter(hour.current));
        save('scene.dayFlow', on);
      },
      [save],
    ),
    setFollowClock: useCallback(
      (on: boolean) => {
        if (on) jump.current = { from: hour.current, t0: performance.now(), to: GameSky.clockHour() };
        save('scene.followClock', on);
        kick();
      },
      [save],
    ),
    setHour: (h: number, commit?: boolean) => {
      jump.current = null;
      hour.current = GameSky.wrapHour(h);
      if (live.current.followClock) save('scene.followClock', false);
      if (commit) save('scene.hour', RoomSky.quarter(h));
      kick();
    },
    stepPhase: (dir: number) => {
      const to = GameSky.stepPhase(hour.current, dir);
      jump.current = { from: hour.current, t0: performance.now(), to };
      if (live.current.followClock) save('scene.followClock', false);
      save('scene.hour', to);
      kick();
    },
    stepWeather: (dir: number) => {
      if (live.current.autoWeather) save('scene.autoWeather', false);
      save('scene.weather', GameSky.stepWeather(live.current.weather, dir));
    },
  };
  return [state, controls];
};
