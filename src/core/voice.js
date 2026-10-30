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
  const MAX_CHARS = 160; // a long reply is read up to here, at a sentence end where possible

  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

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
    let t = String(text || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/（[^）]*）|\([^)]*\)/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
      .replace(/[*_`#>~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if ([...t].length > MAX_CHARS) {
      const cut = [...t].slice(0, MAX_CHARS).join('');
      const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'));
      t = end > 20 ? cut.slice(0, end + 1) : cut;
    }
    return t;
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

  return { DEFAULT_VOICE, MAX_CHARS, voiceOf, speakable, shouldSpeak, pickVoice, webSpeech };
});
