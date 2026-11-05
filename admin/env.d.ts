declare module '*.css';

// src/core/game-sky.js (UMD): 小游戏的时段与天气, shared by 像素小院 and 她的房间 (docs/mini-games.md §4)
declare module '*/core/game-sky.js' {
  interface Weather {
    clouds: number;
    flash: number;
    fog: number;
    id: string;
    lift: number;
    mul: number[];
    rain: number;
    sat: number;
    snow: number;
  }
  interface Grade {
    flies: number;
    hour: number;
    lift: number;
    lights: number;
    mul: number[];
    phase: string;
    sat: number;
    sun: number;
    weather: Weather;
  }
  const sky: {
    DAY_MINUTES: number;
    FADE_S: number;
    PHASES: { from: number; id: string; jump: number; name: string; to: number }[];
    WEATHERS: (Weather & { name: string })[];
    WEATHER_IDS: string[];
    autoDelay: (rnd?: () => number) => number;
    clockHour: (d?: Date) => number;
    flowHours: (seconds: number, dayMinutes?: number) => number;
    formatHour: (t: number) => string;
    grade: (t: number, weather: Weather) => Grade;
    gradeMatrix: (g: { lift: number; mul: number[]; sat: number }) => number[];
    hourDelta: (a: number, b: number) => number;
    mixWeather: (from: string, to: string, k: number) => Weather;
    nextWeather: (id: string, rnd?: () => number) => string;
    phaseName: (id: string) => string;
    phaseOf: (t: number) => string;
    stepPhase: (t: number, dir: number) => number;
    stepWeather: (id: string, dir: number) => string;
    weatherOf: (id: string) => Weather & { name: string };
    wrapHour: (t: number) => number;
  };
  export type { Grade, Weather };
  export default sky;
}

// src/core/room-sky.js (UMD): 房间窗外的天色 (docs/room.md §5)
declare module '*/core/room-sky.js' {
  type Grade = { lift: number; mul: number[]; sat: number; weather?: { clouds: number; fog: number } };
  const roomSky: {
    INSIDE: number;
    body: (hour: number) => { kind: 'moon' | 'sun'; u: number; up: number };
    brightness: (g: { mul: number[] }) => number;
    inside: (g: Grade, k?: number) => { lift: number; mul: number[]; sat: number };
    lineFor: (lines: Record<string, string | string[]> | undefined, phase: string, weatherId: string) => string | null;
    quarter: (t: number) => number;
    stars: (g: Grade) => number;
  };
  export default roomSky;
}

// src/core/vrm-ui.js (UMD, shared with the pet window and the tests)
declare module '*/core/vrm-ui.js' {
  const ui: unknown;
  export default ui;
}

// src/core/chat-live.js (UMD): the reply being written, sent as increments (T-2818)
declare module '*/core/chat-live.js' {
  interface LiveText {
    speciesId: string;
    text: string;
    turnId: string | null;
  }
  interface Piece {
    append?: string;
    at?: number;
    speciesId: string;
    text?: string;
    turnId: string;
  }
  const live: {
    apply: <L extends LiveText>(live: L | null, d: Piece) => { live: L | null; resync: boolean };
    encode: (prev: string, next: string) => { append: string; at: number } | { text: string };
    merge: <L extends LiveText>(live: L | null, queue: Piece[]) => { live: L | null; resync: boolean };
  };
  export default live;
}
