declare module '*.css';

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

// src/core/update-auto.js (UMD): whether opening 版本与更新 starts a check on its own (T-6161)
declare module '*/core/update-auto.js' {
  const auto: {
    COOLDOWN_MS: number;
    shouldAutoCheck: (state: { checkedAt?: number | null; status?: string } | null | undefined, opts: { lastAutoAt?: number; now: number }) => boolean;
  };
  export default auto;
}
