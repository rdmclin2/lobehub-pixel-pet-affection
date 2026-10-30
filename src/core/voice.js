'use strict';
// Reading lines aloud (dsh-pet voice/: the pet reads replies, not its automatic murmurs). Uses the
// operating system's own voices through the Web Speech API (speechSynthesis), so nothing is sent
// anywhere and it costs nothing. Every character sets how she sounds in her file
// (`voice`: { lang, pitch, rate, prefer: [voice name fragments] }); this picks the closest system voice.
// Loaded by the renderer as a <script> (window.PetVoice) and by the tests through require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVoice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_VOICE = { lang: 'zh-CN', pitch: 1, rate: 1, prefer: [] };
  // A reply is read sentence by sentence (sentences()), all of it: no cut in the middle of a sentence.
  const MAX_SENTENCE = 120; // a longer sentence is read in pieces, cut at a comma where possible
  const MIN_SENTENCE = 6; // a shorter one ("嗯。") is read together with the next
  const MAX_SENTENCES = 30; // past this many, the rest of a very long reply stays on screen only

  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const len = (s) => [...s].length;

  // A plain string is the oldest shape: just a system voice name to prefer ("voice": "Xiaoxiao").
  function voiceOf(species) {
    const raw = species && species.voice;
    const v = typeof raw === 'string' ? { prefer: [raw] } : raw || {};
    return {
      lang: typeof v.lang === 'string' && v.lang ? v.lang : DEFAULT_VOICE.lang,
      pitch: clamp(v.pitch, 0.1, 2, DEFAULT_VOICE.pitch),
      rate: clamp(v.rate, 0.5, 2, DEFAULT_VOICE.rate),
      prefer: Array.isArray(v.prefer) ? v.prefer.filter((x) => typeof x === 'string' && x) : [],
    };
  }

  // What is worth reading: no emoji, no stage directions or notes in brackets, no meme tags, no URLs.
  function speakable(text) {
    return String(text || '')
      .replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
      .replace(/（[^）]*）|\([^)]*\)/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
      .replace(/[*_`#>~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Something a voice can say, not just punctuation left over from a stage direction.
  const sayable = (t) => /[\p{L}\p{N}]/u.test(t);

  const OPEN = '（([【';
  const CLOSE = '）)]】';
  const TAIL = '。！？!?；;…~～”’"」』'; // stays with the sentence it ends
  const hardEnd = (c, next) => '。！？!?；;…\n'.includes(c) || (c === '.' && (next === undefined || /\s/.test(next)));
  const softEnd = (c, next) => '，,、：:'.includes(c) || hardEnd(c, next);
  // Cut `text` after every end mark outside brackets (a stage direction is never split); the pieces
  // put together are exactly `text`.
  function cut(text, isEnd) {
    const cs = [...text];
    const out = [];
    let cur = '';
    let depth = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      cur += c;
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
      if (c === '\n') depth = 0; // an unclosed bracket ends with its line
      if (depth === 0 && isEnd(c, cs[i + 1])) {
        while (i + 1 < cs.length && TAIL.includes(cs[i + 1])) cur += cs[++i];
        out.push(cur);
        cur = '';
      }
    }
    if (cur) out.push(cur);
    return out;
  }
  // A sentence longer than MAX_SENTENCE: comma-separated pieces packed up to it, a hard cut as a last resort.
  function pack(sentence) {
    const out = [];
    let cur = '';
    for (const piece of cut(sentence, softEnd)) {
      if (cur && len(speakable(cur + piece)) > MAX_SENTENCE) { out.push(cur); cur = ''; }
      cur += piece;
      while (len(speakable(cur)) > MAX_SENTENCE) {
        const cs = [...cur];
        out.push(cs.slice(0, MAX_SENTENCE).join(''));
        cur = cs.slice(MAX_SENTENCE).join('');
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // A reply as the sentences to read, in order: [{ raw, say }]. `raw` is the piece of the reply as shown
  // (all the raws together are the reply, so the bubble can mark the one being read); `say` is what is
  // read (speakable(raw)), or '' for a piece with nothing to say (a lone stage direction, past MAX_SENTENCES).
  function sentences(text) {
    const parts = [];
    for (const raw of cut(String(text || ''), hardEnd).flatMap((s) => (len(speakable(s)) > MAX_SENTENCE ? pack(s) : [s]))) {
      const prev = parts[parts.length - 1];
      const say = speakable(raw);
      if (prev && (!sayable(say) || (sayable(prev.say) && len(prev.say) < MIN_SENTENCE && len(speakable(prev.raw + raw)) <= MAX_SENTENCE))) {
        prev.raw += raw; // nothing to read on its own, or the previous one is too short: read them together
        prev.say = speakable(prev.raw);
      } else parts.push({ raw, say });
    }
    let n = 0;
    for (const p of parts) {
      if (!sayable(p.say)) p.say = '';
      else if (++n > MAX_SENTENCES) p.say = '';
    }
    return parts;
  }

  // Which lines are read: the agent's replies and topics, and lines sent through the local API (a
  // deliberate request); not automatic murmurs or the app's own notes.
  const shouldSpeak = (m) => !!m && ((m.source === 'llm' && (m.kind === 'chat' || /^topic:/.test(m.kind || ''))) || m.source === 'api');

  // The system voice to use: a preferred name first, then the same language, then the same base language.
  function pickVoice(voices, v) {
    const list = Array.isArray(voices) ? voices : [];
    for (const p of v.prefer) {
      const hit = list.find((x) => x.name && x.name.toLowerCase().includes(p.toLowerCase()));
      if (hit) return hit;
    }
    const lang = v.lang.toLowerCase();
    return list.find((x) => (x.lang || '').toLowerCase() === lang) || list.find((x) => (x.lang || '').toLowerCase().split(/[-_]/)[0] === lang.split('-')[0]) || null;
  }

  // The system voice as a TTS provider (core/tts.js PROVIDERS.system): the last fallback of the chain,
  // run in the renderer because speechSynthesis lives there. env = { speechSynthesis, SpeechSynthesisUtterance }.
  const webSpeech = {
    id: 'system',
    kind: 'system',
    needsKey: false,
    available: (env) => !!(env && env.speechSynthesis && env.SpeechSynthesisUtterance),
    config: (voice) => voiceOf({ voice }),
    // Speak `text` now (cancelling whatever the system was saying). on: { start, end, error }
    speak(text, v, env, on = {}) {
      const u = new env.SpeechSynthesisUtterance(text);
      const voices = env.speechSynthesis.getVoices();
      const sys = pickVoice(voices, v);
      u.lang = v.lang;
      u.pitch = v.pitch;
      u.rate = v.rate;
      if (sys) u.voice = sys;
      u.onstart = () => on.start && on.start();
      u.onend = () => on.end && on.end();
      u.onerror = (e) => on.error && on.error(e.error);
      env.speechSynthesis.cancel();
      env.speechSynthesis.speak(u);
      return { voice: sys ? sys.name : null, systemVoices: voices.length };
    },
    cancel: (env) => env && env.speechSynthesis && env.speechSynthesis.cancel(),
  };

  return { DEFAULT_VOICE, MAX_SENTENCE, MIN_SENTENCE, MAX_SENTENCES, voiceOf, speakable, sentences, shouldSpeak, pickVoice, webSpeech };
});
