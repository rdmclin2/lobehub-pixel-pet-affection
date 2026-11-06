declare module '*.css';

// src/core/vrm-ui.js (UMD, shared with the pet window and the tests)
declare module '*/core/vrm-ui.js' {
  const ui: unknown;
  export default ui;
}

// src/core/segments.js (UMD): 分段式表达, one reply as several messages (docs/segmented-reply.md)
declare module '*/core/segments.js' {
  interface Plan {
    complete: number;
    segments: string[];
  }
  interface Opts {
    charMs?: number;
    max?: number;
  }
  interface Player {
    cancel: (reason?: string) => unknown;
    feed: (id: string, plan: Plan, final?: boolean) => void;
    id: () => string | null;
    setOptions: (o: Opts) => void;
    state: () => { shown: number; typing: number } | null;
  }
  const Seg: {
    createPlayer: (hooks: Record<string, (...a: never[]) => void>, opts?: Opts) => Player;
    plan: (text: string, opts?: Opts & { final?: boolean }) => Plan;
    split: (text: string, opts?: Opts) => string[];
  };
  export default Seg;
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
