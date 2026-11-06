/**
 * 分段式表达 in the settings window (docs/segmented-reply.md): her reply as separate messages, each its own bubble like
 * WeChat. 聊天记录 still stores one record with a line per message; only the display splits it. The reply this page
 * just received comes out message by message at her pace (core/segments.js, the same player as the pet window).
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import Seg from '../../../../src/core/segments.js';

interface Prefs {
  segmented?: boolean;
  segmentCharMs?: number;
  segmentMax?: number;
}

export const splitReply = (text: string, prefs?: Prefs): string[] => (prefs?.segmented === false ? [text] : Seg.split(text, { max: prefs?.segmentMax }));

export interface PacedReply {
  /** Set once the final message is saved: the list shows this message's parts so far instead of all of them. */
  messageId?: string;
  segments: string[];
  shown: number;
}

export const usePacedReply = (prefs?: Prefs) => {
  const [paced, setPaced] = useState<PacedReply | null>(null);
  const now = useRef<Pick<PacedReply, 'messageId' | 'segments'>>({ segments: [] });
  const opts = { charMs: prefs?.segmentCharMs, max: prefs?.segmentMax };
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const on = useRef(prefs?.segmented !== false);
  on.current = prefs?.segmented !== false;
  const player = useMemo(() => {
    const sync = () => {
      const st = player.state();
      if (st) setPaced({ ...now.current, shown: st.shown });
    };
    const player = Seg.createPlayer({ done: () => setPaced(null), live: sync, reveal: sync, truncate: sync, typing: sync, update: sync });
    return player;
  }, []);
  const feed = useCallback((id: string, text: string) => {
    if (!on.current) return;
    const p = Seg.plan(text, { ...optsRef.current, final: false });
    if (p.segments.length < 2) { // one line so far, or it turned out to be an answer to read (code, a list, long): one bubble
      if (player.id() === id) {
        player.cancel();
        setPaced(null);
      }
      return;
    }
    now.current = { segments: p.segments };
    player.setOptions(optsRef.current);
    player.feed(id, p);
  }, [player]);
  const finish = useCallback((id: string, message: { id: string; status?: string; text?: string }) => {
    const active = player.id() === id;
    const parts = on.current && message.text && message.status === 'done' ? Seg.split(message.text, optsRef.current) : [];
    if (!active && parts.length < 2) return;
    if (!parts.length) { // stopped or failed: what she wrote shows whole, nothing keeps coming
      player.cancel();
      setPaced(null);
      return;
    }
    now.current = { messageId: message.id, segments: parts };
    player.setOptions(optsRef.current);
    player.feed(id, { complete: parts.length, segments: parts }, true);
  }, [player]);
  const cancel = useCallback(() => {
    player.cancel();
    setPaced(null);
  }, [player]);
  return { cancel, feed, finish, paced };
};
