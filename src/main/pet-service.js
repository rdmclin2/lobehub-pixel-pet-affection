'use strict';

const { EventEmitter } = require('node:events');
const state = require('../core/pet-state');
const resetWake = require('../core/reset-wake'); // 重置姿势: wake + no-auto-sleep grace, outside the frozen pet-state
const persona = require('../core/persona');
const { adultAllowed, stageName, setRules: setAffectionRules, gainAffection } = require('../core/affection');
const dialogue = require('../core/dialogue');
const outfits = require('../core/outfits');
const { migratePet, SHARED_KEYS } = require('../core/migrate');
const settingsLib = require('../core/settings');
const framingLib = require('../core/framing');
const { getSpecies, SPECIES } = require('../core/species');
const packsLib = require('../core/packs');
const C = require('../core/characters');
const characterMigrate = require('../core/character-migrate');
const Catalog = require('../core/catalog');
const modelsLib = require('../core/models');
const fs = require('node:fs');
const path = require('node:path');
const contentGuard = require('../core/content-guard');
const latency = require('../core/latency');
const { nextEvent, LlmBudget, fallbackLine, fallbackPool } = require('../core/proactive');
const memes = require('../core/memes');
const touchZones = require('../core/touch-zones');
const { endpointOkFor } = require('../core/tts');
const asrLib = require('../core/asr');
const interjectLib = require('../core/interject');
const Voice = require('../core/voice');
const InteractionVoice = require('../core/interaction-voice');
const chatLog = require('../core/chat-log');
const stickersLib = require('../core/stickers');
const adminChat = require('../core/admin-chat');
const chatLive = require('../core/chat-live');
const musicLib = require('../core/music');
const musicLibrary = require('../core/music-library');
const { createMusicTool, MUSIC_TOOL_NAME } = require('../core/responses-client');
const aiFolders = require('../core/ai-folders');
const cur = state.cur;
const { ensureLocalDevice, bindConfig, unbindConfig, LOCAL_TOOLS } = require('../core/local-device');

const LOCAL_RECHECK_MS = 6 * 60 * 60 * 1000; // re-confirm the device binding a few times a day
const LOCAL_RETRY_MS = 5 * 60 * 1000; // after a failure, do not hammer `lh` on every message
const MODELS_TTL_MS = 10 * 60 * 1000; // how long the list of the user's models is reused
// Offline lines that may come with a random meme picture (the pet's own murmurs, not app notes).
const FULL_LINE = '呃……肚子圆滚滚的，吃不下了。';
const TIRED_LINE = '好累……让我睡一会儿。';
const PREWARM_MAX = 60; // lines synthesised ahead per character (互动语音)
// 文件夹限制生效、直连又不可用时，这一轮不带本机工具 (T-5075)
const NO_LOCAL_TOOLS_LINE = '这次用不了本机工具：直连 LobeHub 不可用，而 lh connect 没法限制在你允许的文件夹里。';
const MEME_KINDS = ['hungry', 'bored', 'greet_morning', 'greet_evening', 'met', 'missed', 'stage_up', 'fed', 'patted', 'played', 'woke', 'switch'];

// 音乐创作 (T-5090): what the windows get of a song compose_music saved (the file and its facts, nothing more).
function musicView(r) {
  const meta = (r && r.meta) || {};
  return { id: path.basename(r.filePath), title: meta.title || '', filePath: r.filePath, fileUrl: r.fileUrl, durationMs: r.durationMs || null, format: meta.format || path.extname(r.filePath).slice(1), instrumental: !!meta.instrumental, provider: meta.provider || null };
}
const musicNames = (list) => list.map((m) => (m.title ? `《${m.title}》` : '新曲子')).join('、');

// Owns the pet's lifecycle. Electron-free so it can be tested with a fake `lh`.
// A 表情包 as a 聊天记录 field ({ ref, set, id, label }; desc stays out: it is for the agent, not the record).
const stickerField = (s) => (s && s.ref ? { sticker: { ref: s.ref, set: s.set, id: s.id, label: s.label } } : {});

// `this.pet` is the whole save (schema 3): owner-level fields plus one entry per character met
// (`pet.characters[id]`, her own agent, topic, name, affection and needs); `this._c()` is the current one.
class PetService extends EventEmitter {
  constructor({ lh, responses = null, music = null, store, settingsStore = new settingsLib.MemorySettingsStore(), now = () => Date.now(), rnd = Math.random, budget = new LlmBudget(), packs = null, ttsStatus = null, asr = null, hotkeyStatus = null, log = new chatLog.MemoryChatLog(), stickers = null, interjectStore = new interjectLib.MemoryInterjectStore(), musicLibrary: songStore = new musicLibrary.MemoryMusicLibraryStore(), timers = undefined }) {
    super();
    this.stickers = stickers; // 表情包集合 (core/stickers.js StickerLibrary): her built-in memes + the owner's own
    this.log = log; // 聊天记录 (core/chat-log.js): every message with its origin
    // pet packs (how the companions look); by default only the built-in ones
    // main always passes its pack store's; the default (tests) is a repo checkout with catalog/ downloaded
    this.packs = packs || Catalog.repoPacks().packs;
    this.lh = lh;
    // the direct path for turns that use this computer (core/responses-client.js); null: always `lh connect`
    this.responses = responses;
    this._responsesFailedAt = 0;
    // 音乐创作 (T-5090): { key: () => keys.minimax, userDataDir, env?, fetch?, allowInsecureLocal?, generate? } from
    // main; null: the compose_music tool is never offered (tests that do not ask for it).
    this.music = music;
    // 她的音乐库 (core/music-library.js): which character made each saved song; main passes the file store
    this.songStore = songStore;
    this.ttsStatus = ttsStatus; // 语音: whether each engine has a key and its last error (main.js; never the keys)
    // 快捷键唤起语音对话: the global shortcut's state (main/voice-hotkey.js status(): ok | disabled | invalid | conflict)
    this.hotkeyStatus = hotkeyStatus;
    this.asr = asr; // 语音输入 (core/asr.js AsrEngine): recognition runs in main; null = not available (tests)
    this.store = store;
    this.settingsStore = settingsStore;
    this.settings = this._loadSettings();
    this.now = now;
    this.rnd = rnd;
    this.budget = budget;
    this._applyRules();
    // what the restart-only settings were when this process started (settingsView().pendingRestart)
    this._bootSettings = this.settings;
    this.pet = null;
    this.busy = false;
    this._localOk = false;
    this._localCheckedAt = 0;
    this._localFailedAt = 0;
    this.localError = null;
    this.localWarning = null;
    this._deviceId = null;
    this._cancelRequested = false;
    this._pendingDecay = 0; // affection lost while the app was closed, reported on the first heartbeat
    this._catalog = null; // the user's enabled chat models (see refreshModels), null until first loaded
    this._catalogAt = 0;
    this._catalogError = null;
    this._catalogLoading = null;
    this._localAgent = null; // the agent the last device check bound
    // 插个嘴 (core/interject.js): listens only to the inputs fed in through interjectInput(); off by default
    this.interjector = new interjectLib.Interjector({
      decide: (req) => this.lh.decide(req),
      speak: (req) => this._interjectSpeak(req),
      config: () => this.settings.interject,
      pet: () => (this.pet ? { ...this._c() } : null),
      busy: () => this.busy,
      now: () => this.now(),
      rnd: () => this.rnd(),
      store: interjectStore,
      ...(timers ? { timers } : {}),
      onEvent: (e) => (e.type === 'error' ? this.emit('error', e.error) : this.emit('interject', e)),
    });
  }

  _c() {
    return cur(this.pet);
  }

  // settings.json, migrated once to 「每个形象就是一个角色」 (core/character-migrate.js, T-2764): the file as it
  // was is kept as settings.characters.bak.json. Idempotent: a migrated file comes back unchanged.
  _loadSettings() {
    const raw = this.settingsStore.load();
    const r = characterMigrate.migrateSettings(raw, this.packs);
    if (!r.changed) return raw;
    if (this.settingsStore.backupOnce) this.settingsStore.backupOnce('settings.characters.bak.json');
    const s = settingsLib.normalizeSettings(r.settings);
    this.settingsStore.save(s);
    return s;
  }

  // ---- 角色 (T-2764, core/characters.js) ------------------------------------------------------------------
  // Every look is a character of its own; her base (pet.speciesId) is the persona whose agent, affection and
  // chat history all of the base's characters share. `_cid()`: the character on the desktop now — the saved
  // one, or her base's default when that one is gone or is an 18+ look with adult content off (the choice is
  // kept for when it can be shown again).
  _cid() {
    if (!this.pet) return null;
    const base = this.pet.speciesId;
    const want = C.characterById(this.packs, this.pet.characterId);
    if (want && want.base === base && C.available(want, this._adultOk())) return want.id;
    return C.defaultCharacter(this.packs, base, this._adultOk());
  }

  // A character id as the UI or an old caller gives it: a character, or an old per-persona id (`claude`, her
  // default character — her current one when she is the companion). null = unknown.
  _charOf(id) {
    if (id === undefined || id === null || id === '') return this._cid();
    if (typeof id !== 'string') return null;
    const e = C.characterById(this.packs, id);
    if (e) return e.id;
    if (Object.hasOwn(SPECIES, id)) return this.pet && this.pet.speciesId === id ? this._cid() : C.defaultCharacter(this.packs, id, this._adultOk());
    return null;
  }

  _baseOf(id) {
    return C.baseOf(this.packs, id);
  }

  // `id`'s wardrobe as "the pet" core/outfits.js takes: her base's state (stage, unlocks) with this character's
  // own outfit. `put` writes it back after outfits.equip / enforce changed it; the flat fields on the base's
  // state mirror the current character's (what an older app version would read).
  _wearer(id, c = this.pet && this.pet.characters[this._baseOf(id)]) {
    if (!c) return null;
    const w = (c.wardrobes && c.wardrobes[id]) || {};
    return { ...c, equippedOutfit: w.equippedOutfit || outfits.DEFAULT_OUTFIT, lastSafeOutfit: w.lastSafeOutfit || outfits.DEFAULT_OUTFIT };
  }

  _keepWardrobe(id, w) {
    const c = this.pet && this.pet.characters[this._baseOf(id)];
    if (!c || !w) return;
    c.wardrobes = { ...(c.wardrobes || {}), [id]: { equippedOutfit: w.equippedOutfit, lastSafeOutfit: w.lastSafeOutfit } };
    if (id === this._cid()) {
      c.equippedOutfit = w.equippedOutfit;
      c.lastSafeOutfit = w.lastSafeOutfit;
    }
  }

  // outfits.enforceOutfit for character `id` (default: the current one), saved into her wardrobe.
  _enforce(id = this._cid()) {
    const w = this._wearer(id);
    if (!w) return { changed: false };
    const r = outfits.enforceOutfit(w, this.settings, this._look(id));
    this._keepWardrobe(id, w);
    return r;
  }

  // The runtime rules that come from settings: 好感度 (daily cap, decay) and 主动行为's hourly LLM budget.
  _applyRules() {
    setAffectionRules(this.settings.affectionRules);
    if (this.budget) this.budget.max = this.settings.proactive.maxLlmPerHour;
  }

  // Load the save; a growth-system save (xp / stage) is backed up once and migrated (design 6).
  init() {
    const t = this.now();
    this.settings = this._loadSettings();
    this._applyRules();
    const raw = this.store.load();
    const { pet: loaded, migrated, from, remapped } = migratePet(raw, t);
    if (migrated) this.store.backupOnce(`pet.v${from}.bak.json`);
    if (remapped) this.store.backupOnce('pet.retired.bak.json');
    // 「每个形象就是一个角色」 (T-2764): the companion she was + the 形象包 she wore → one character id, and her
    // outfit into the wardrobe of each of her characters (core/character-migrate.js). Once, with a backup.
    const cm = characterMigrate.migratePet(loaded, { packs: this.packs, appearance: this.settings.legacyAppearance || {} });
    if (cm.changed && !migrated) this.store.backupOnce('pet.characters.bak.json');
    const pet = cm.pet;
    this.pet = pet;
    this._decideLocal();
    // told once, on the first heartbeat / warmup: who took over a retired character
    this._retiredNotice = remapped && pet ? { from: remapped, to: pet.speciesId } : null;
    // A pet's agent is reached in the space it was created in (no `space`: an older save, lh's default).
    this.lh.setWorkspace(this.pet && this.pet.space ? this.pet.space.workspaceId : this.pet ? undefined : null);
    if (this.pet) {
      // only the current character lives on while the app is closed; the others stay where they were
      const { decay } = resetWake.tick(this._c(), t);
      // The settings may have changed while the app was closed (e.g. a re-asked age gate).
      const { changed } = this._enforce();
      if (migrated || remapped || cm.changed || decay > 0 || changed) this.store.save(this.pet);
      if (decay > 0) this._pendingDecay = decay;
    }
    return this.view();
  }

  _adult() {
    return !!this.pet && adultAllowed(this.settings, this.pet.speciesId);
  }

  // 18+ looks (T-1261): an adult pet pack is listed and worn only after the 18+ confirmation with adult
  // content on. This is about the look and its wardrobe only; her persona and tone stay as her file says.
  _adultOk() {
    return !!(this.settings.ageConfirmed && this.settings.adultContent);
  }

  // The wardrobe context of character `id` (default: the current one): { adult, only, outfits } of her own pack
  // (its outfits are her whole wardrobe, T-2752), her clips: daily only; null only when she has no pack.
  _look(id = this._cid()) {
    const e = C.characterById(this.packs, id);
    if (!e) return null;
    // a VRM pack whose model license forbids sexual usage is never an 18+ look (core/packs.js lookContext)
    return packsLib.lookContextOf(this.packs, e.clips ? C.clipsId(e.base) : e.packId, e.base);
  }

  // Settings as the UI needs them: whether to show the age gate, and whether adult content is on.
  settingsView() {
    return { ...this.settings, needsAgeGate: settingsLib.needsAgeGate(this.settings), petScaleRange: settingsLib.PET_SCALE, systemRoleMax: settingsLib.SYSTEM_ROLE_MAX, ttsStatus: this.ttsStatus ? this.ttsStatus() : null, asrStatus: this.asr ? this.asr.status() : null, hotkeyStatus: this.hotkeyStatus ? this.hotkeyStatus() : null, musicStatus: this.musicKeysView(), pendingRestart: this.pendingRestart() };
  }

  // Restart-only settings (settings.RESTART_KEYS) changed since this process started: they apply after a restart.
  pendingRestart() {
    const at = (o, k) => k.split('.').reduce((v, p) => (v && typeof v === 'object' ? v[p] : undefined), o);
    return settingsLib.RESTART_KEYS.filter((k) => at(this._bootSettings, k) !== at(this.settings, k));
  }

  // `pet` is the current character as one flat object (owner-level fields + her base's entry + her own
  // wardrobe), as before schema 3; `pet.characterId` is who she is, `pet.speciesId` her base (persona).
  // `characters` lists the roster — one row per character (T-2764: every look is one) — with whether her base
  // has been met, under which name, and her affection, plus what ⋯ → 角色列表 → her page configures for her:
  // her look (thumbnail), her pack, model and affection progress.
  view() {
    if (!this.pet) return null;
    const c = this._c();
    const sp = getSpecies(this.pet.speciesId);
    const cid = this._cid();
    const me = C.characterById(this.packs, cid);
    const w = this._wearer(cid, c);
    const { characters, retiredCharacters, ...shared } = this.pet;
    const adult = this._adult();
    const worn = outfits.wornOutfit(w, this.settings, this._look(cid));
    return {
      pet: { ...shared, ...c, characterId: cid, equippedOutfit: w.equippedOutfit, lastSafeOutfit: w.lastSafeOutfit },
      status: state.currentStatus(c),
      affection: state.toAffectionProgress(c, { adult }),
      topics: dialogue.listTopics(c, this.settings),
      // a locked outfit's VRM model is not handed out (only its picture): nothing to load before it unlocks
      outfits: outfits.listOutfits(w, this.settings, this._look(cid)).map((o) => ({ ...o, look: packsLib.lockedLook(this.lookFor(cid, o.id), o.locked) })),
      outfit: worn,
      look: this.lookFor(cid, worn),
      character: me ? this._characterInfo(me) : null,
      model: this.modelView(),
      settings: this.settingsView(),
      species: { id: sp.id, name: sp.name, nameZh: sp.nameZh, vendor: sp.vendor, title: sp.title, accent: sp.accent },
      // her saved character is one that has to be downloaded first (it no longer ships with the app): she is
      // shown as her default one meanwhile and becomes it again once it is downloaded
      pendingDownload: this._pendingDownload(),
      characters: C.listCharacters(this.packs, { adultOk: this._adultOk() }).map((x) => {
        const b = SPECIES[x.base];
        const e = characters[x.base];
        const ad = adultAllowed(this.settings, x.base);
        const met = e ? { name: e.name, affection: e.affection, stage: stageName(e.relStage, ad), progress: state.toAffectionProgress(e, { adult: ad }) } : null;
        const xw = e ? this._wearer(x.id, e) : null;
        const look = this.lookFor(x.id, xw ? outfits.wornOutfit(xw, this.settings, this._look(x.id)) : outfits.DEFAULT_OUTFIT);
        return {
          ...this._characterInfo(x),
          vendor: b.vendor, title: b.title, accent: b.accent, current: x.id === cid, met,
          look,
          // 取景: whether what she wears can be shown 半身 (core/framing.js SUPPORTED_KINDS: VRM, Live2D, sprites)
          framingSupported: framingLib.resolveFraming(this.settings, x.id, look).supported,
          model: this.modelView(x.base),
          systemRole: this.settings.systemRoles[x.base] || '',
          framing: this.settings.framings[x.id] || 'auto',
        };
      }),
      space: this.pet.space ? { personal: !this.pet.space.workspaceId, name: this.pet.space.name } : null,
      busy: this.busy,
      local: { enabled: !!this.pet.localAbilities, ok: this._localOk, error: this.localError, warning: this.localWarning, limited: this.settings.local.folders !== null, folders: this.settings.local.folders || [], allowCommands: this.settings.local.allowCommands === true },
    };
  }

  _save() {
    this.store.save(this.pet);
    this.emit('update', this.view());
  }

  // An agent reply that crosses the content boundary is replaced by a refusal; only the category is logged.
  _guard(text) {
    const r = contentGuard.checkReply(text);
    if (r.ok) return text;
    const e = new Error(`reply blocked by content guard: ${r.category}`);
    e.code = 'ECONTENT';
    this.emit('error', e);
    return contentGuard.refusalLine(getSpecies(this.pet.speciesId));
  }

  // Her pictures for [梗图:<id>] (core/memes.js): the built-in memes of her file plus the ones her owner added
  // (core/stickers.js catalog), as a species-like { id, memes } the memes helpers take. Without a sticker
  // library (tests, old callers) just her file's.
  _memeSpecies(sp) {
    if (!sp) return null;
    if (!this.stickers) return sp;
    try {
      return { id: sp.id, memes: this.stickers.catalog(sp) };
    } catch {
      return sp;
    }
  }

  // A sticker of hers as 聊天记录 keeps it ({ ref, set, id, label, desc }), or null.
  // `pick`: { set, id } from a panel (only a set she holds), or a bare meme id from a [梗图:<id>] tag.
  _sticker(sp, pick) {
    if (!sp || !pick) return null;
    if (this.stickers) {
      try {
        if (typeof pick === 'string') return this.stickers.resolveTag(sp, pick);
        const r = this.stickers.resolve(sp, pick.set, pick.id);
        return r.ok ? r.sticker : null;
      } catch {
        return null;
      }
    }
    // no sticker library (tests, old callers): her file's built-in memes only
    const id = typeof pick === 'string' ? pick : pick.set === `builtin:${sp.id}` ? pick.id : null;
    const m = id && (sp.memes || []).find((x) => x.id === id);
    return m ? { ref: `builtin:${sp.id}/${m.id}.webp`, set: `builtin:${sp.id}`, id: m.id, label: m.label, desc: m.desc || '' } : null;
  }

  // The settings the prompt builders get (core/persona.js buildStateBlock): with `memeList`, the hint lists
  // the owner's stickers too.
  _promptSettings() {
    if (!this.stickers) return this.settings;
    return { ...this.settings, memeList: (speciesId) => this._memeSpecies(getSpecies(speciesId)) };
  }

  // A line for the bubble. The agent may have tagged a meme picture ([梗图:id], core/memes.js): the tag
  // never reaches the bubble; with memes on, the picture goes with the line (an offline murmur gets a
  // random one now and then).
  // `turn`: the owner's round this line answers ({ origin, turnId }, from _logUser); without one the
  // line is the pet's own and its origin comes from `kind` (greeting, proactive, touch, …).
  // `stream`: the reply stream (_openStream) this line ends; its id goes with the line so the window turns the
  // bubble it has been filling into this final text instead of starting a new one.
  // `extra.music`: songs compose_music saved this turn ([musicView]); they go with the line (气泡 → 播放) and into 聊天记录.
  _say(text, source, kind, reason = null, voiceMood = null, turn = null, stream = null, extra = {}) {
    if (this.pet) this._c().lastSpokeAt = this.now();
    const sp = this.pet ? getSpecies(this.pet.speciesId) : null;
    const ms = this._memeSpecies(sp);
    const ex = memes.extractMeme(text, ms);
    const music = extra && Array.isArray(extra.music) && extra.music.length ? extra.music : null;
    let meme = null;
    if (sp && this.settings.prefs.memes) meme = ex.meme || (source === 'fallback' && MEME_KINDS.includes(kind) ? memes.randomMeme(ms, this.rnd) : null);
    const m = meme && ms.memes.find((x) => x.id === meme);
    // the picture shown with the line is kept with it in 聊天记录 (docs/stickers-design.md §3.2)
    const origin = this._logPet(ex.text || text, kind, turn, null, music ? { attachments: { music } } : null, m ? this._sticker(sp, m.id) : null);
    const shown = ex.text || text;
    this.emit('say', { text: shown, source, kind, reason, meme: m ? { id: m.id, label: m.label, url: m.url || memes.memeUrl(sp.id, m.id) } : null, speciesId: sp ? sp.id : null, origin, ...(voiceMood !== null ? { voiceMood } : {}), ...(stream ? { streamId: stream.id } : {}), ...(music ? { music } : {}) });
    if (this.pet) this._save();
    return shown;
  }

  // ---- 流式回复 (docs/streaming-ui.md) --------------------------------------------------------------------
  // One agent turn's reply as it is written. `onDelta` goes to the client (lh-client / responses-client run);
  // every new piece becomes a 'chat-delta' { id, n, kind, turnId, text } with the text shown so far (finished
  // and half-written meme tags taken out, memes.streamingText). The guard looks at everything so far: from
  // the first hit on, nothing more is shown ('chat-delta' with withheld: true, text ''); the final line is
  // the refusal as before. The id is new for every turn, so a late piece of an earlier turn (or of a
  // proactive line) never lands in another one's bubble. Each stream ends with exactly one 'chat-done'
  // { id, ok, reason } — after the final 'say' (which carries streamId) when there was a reply.
  // Everything that needs the whole reply (guard verdict, meme picture, 聊天记录, affection, reading aloud)
  // still runs once, on the final text.
  _openStream(kind, turn = null) {
    const st = { id: `r${(this._streamSeq = (this._streamSeq || 0) + 1)}${this.now().toString(36)}`, kind, turnId: turn ? turn.turnId : null, n: 0, shown: '', withheld: false, closed: false };
    st.trace = latency.NOOP; // chat() sets its turn's trace (core/latency.js, off by default)
    st.onDelta = (_chunk, soFar) => {
      st.trace.mark('firstDelta');
      if (st.closed || st.withheld || this._cancelRequested) return; // Esc / 停止: nothing more is shown
      if (!contentGuard.checkReply(soFar).ok) {
        st.withheld = true;
        st.shown = '';
        this.emit('chat-delta', { id: st.id, n: ++st.n, kind, turnId: st.turnId, text: '', withheld: true });
        return;
      }
      const text = memes.streamingText(soFar);
      if (!text || text === st.shown) return;
      st.shown = text;
      st.trace.mark('firstShown');
      st.trace.markLast('lastShown');
      st.trace.add('deltas');
      st.trace.add('ipcBytes', Buffer.byteLength(text));
      this.emit('chat-delta', { id: st.id, n: ++st.n, kind, turnId: st.turnId, text });
    };
    // The turn is sent again another way (_runTurn's fallback): what the first try showed goes, the bubble
    // starts over with the new reply (same id, so it stays one bubble and one 聊天记录 line).
    st.restart = () => {
      if (st.closed) return;
      const had = st.shown || st.withheld;
      st.shown = '';
      st.withheld = false;
      if (had) this.emit('chat-delta', { id: st.id, n: ++st.n, kind, turnId: st.turnId, text: '', restart: true });
    };
    return st;
  }

  // `text`: the final line as said (guarded, meme tag out); null when there was none (canceled, error).
  _closeStream(st, ok, reason = null, text = null) {
    if (!st || st.closed) return;
    st.closed = true;
    this.emit('chat-done', { id: st.id, ok: !!ok, reason, text, kind: st.kind, turnId: st.turnId, deltas: st.n, withheld: st.withheld });
  }

  // ---- 聊天记录 (core/chat-log.js) ----------------------------------------------------------------
  // The owner's message opens a round; her reply (or the note that none came) closes it with the same turnId.
  // `sticker`: a 表情包 the owner sent ({ ref, set, id, label }, _sticker).
  _logUser(text, origin, kind, attachments = null, sticker = null) {
    const turnId = `t${this.now().toString(36)}${Math.floor(this.rnd() * 1e6).toString(36)}`;
    const a = attachments && (attachments.images || (attachments.files && attachments.files.length)) ? { attachments } : {};
    try {
      this.log.append({ speciesId: this.pet.speciesId, role: 'user', origin, kind, turnId, text, ...this._epoch(), ...a, ...stickerField(sticker) }, this.now());
    } catch (e) {
      this.emit('error', e);
    }
    return { origin, turnId };
  }

  // 重新开始话题 also starts a new conversation in 聊天记录 (chat-log.userSessions splits on it)
  _epoch() {
    const n = this._c().topicEpoch || 0;
    return n ? { topicEpoch: n } : {};
  }

  _logPet(text, kind, turn = null, status = null, extra = null, sticker = null) {
    const origin = turn ? turn.origin : chatLog.originOfKind(kind);
    if (!this.pet) return origin;
    try {
      this.log.append({ speciesId: this.pet.speciesId, role: 'pet', origin, kind, turnId: turn ? turn.turnId : `s${this.now().toString(36)}${Math.floor(this.rnd() * 1e6).toString(36)}`, text: String(text || ''), ...this._epoch(), ...(status ? { status } : {}), ...(extra || {}), ...stickerField(sticker) }, this.now());
    } catch (e) {
      this.emit('error', e); // a full disk must not silence the pet
    }
    return origin;
  }

  // ⋯ → 聊天记录: only the conversations the owner started (chatLog.userSessions is the one filter).
  // The list carries summaries; the messages of one conversation come from historySession(id).
  history() {
    const r = chatLog.userSessions(this.log.list());
    return { sessions: r.sessions.map(({ messages, ...s }) => ({ ...s, name: this._nameOf(s.speciesId) })), hidden: r.hidden, total: r.total };
  }

  historySession(id) {
    const s = chatLog.userSessions(this.log.list()).sessions.find((x) => x.id === String(id || ''));
    if (!s) return { ok: false, reason: 'not-found' };
    const pick = ({ id: mid, at, role, turnId, text, attachments, sticker, status }) => ({ id: mid, at, role, turnId, text, ...(attachments ? { attachments: this._withSongState(attachments) } : {}), ...(sticker ? { sticker: { ...sticker, url: stickersLib.refUrl(sticker.ref) } } : {}), ...(status ? { status } : {}) });
    return { ok: true, session: { ...s, name: this._nameOf(s.speciesId), messages: s.messages.map(pick) } };
  }

  // 聊天记录 shows a song as it is now: the title she was given in her music library (重命名), and `missing` when
  // its file was deleted (删除 there, or outside the app) — the line itself is kept as it was said.
  _withSongState(attachments) {
    if (!attachments || !Array.isArray(attachments.music) || !attachments.music.length) return attachments;
    const songs = musicLibrary.normalizeLibrary(this.songStore.load()).songs;
    const music = attachments.music.map((m) => {
      const lib = songs.find((x) => (m.libraryId ? x.id === m.libraryId : x.filePath === m.filePath));
      let exists = false;
      try { exists = fs.statSync(m.filePath).isFile(); } catch { /* gone */ }
      return { ...m, ...(lib && lib.title ? { title: lib.title } : {}), ...(exists ? {} : { missing: true }) };
    });
    return { ...attachments, music };
  }

  _nameOf(speciesId) {
    const c = this.pet && this.pet.characters[speciesId];
    return c ? c.name : SPECIES[speciesId] ? getSpecies(speciesId).nameZh : '';
  }

  async _login(onStep, onLoginPrompt) {
    onStep('checking-login');
    let user = await this.lh.whoami();
    if (!user) {
      onStep('login');
      user = await this.lh.login({ onPrompt: onLoginPrompt });
      if (!user) throw new Error('Login did not complete');
    }
    return user;
  }

  // Before hatching: log in (if needed) and list where the pet's agent may live. The personal space
  // always comes first and is the default; `pinned` is set when `lh workspace use` points every
  // unscoped call at a workspace, so choosing personal also needs `lh workspace use --personal`.
  async spaces({ onStep = () => {}, onLoginPrompt = () => {} } = {}) {
    await this._login(onStep, onLoginPrompt);
    this.lh.setWorkspace(null);
    const [workspaces, pinnedId] = await Promise.all([this.lh.listWorkspaces(), this.lh.pinnedWorkspace()]);
    const pinned = pinnedId ? workspaces.find((w) => w.id === pinnedId) || { id: pinnedId, name: pinnedId } : null;
    return { workspaces, pinned };
  }

  // Login (if needed) -> create the LobeHub agent in the chosen space -> create local pet state.
  // `space`: { workspaceId: null (personal, the default) | id, name, switchToPersonal }.
  // `characterId`: who she is (a character, T-2764); an old caller's `speciesId` means her base's default one.
  async hatch({ characterId, speciesId, name, localAbilities = false, space = null, onStep = () => {}, onLoginPrompt = () => {} }) {
    if (this.pet) throw new Error('A pet already exists');
    const want = characterId || speciesId;
    const pick = C.characterById(this.packs, want);
    const base = pick ? pick.base : Object.hasOwn(SPECIES, want) ? want : null;
    if (!base) throw new Error(`Unknown character: ${want}`);
    const chosen = pick && C.available(pick, this._adultOk()) ? pick.id : C.defaultCharacter(this.packs, base, this._adultOk());
    speciesId = base;
    const sp = getSpecies(speciesId);
    const petName = (name || '').trim().slice(0, 12) || sp.nameZh;
    const workspaceId = (space && space.workspaceId) || null;

    const user = await this._login(onStep, onLoginPrompt);

    onStep('creating-agent');
    this.lh.setWorkspace(workspaceId);
    if (!workspaceId) {
      const pinned = await this.lh.pinnedWorkspace();
      if (pinned) {
        if (!(space && space.switchToPersonal)) throw new Error(`lh 目前固定在 workspace（${pinned}），没法建到个人空间。请在“放在哪里”里同意切回个人空间，或选择那个 workspace。`);
        await this.lh.usePersonal();
      }
    }
    const first = await this._createCharacter(speciesId, petName);
    this.pet = { ...state.createSave(first, this.now()), characterId: chosen, characterModel: characterMigrate.CHARACTER_MODEL };
    first.wardrobes = { [chosen]: { equippedOutfit: first.equippedOutfit, lastSafeOutfit: first.lastSafeOutfit } };
    this.pet.space = { workspaceId, name: workspaceId ? String((space && space.name) || workspaceId).slice(0, 60) : '个人空间' };
    this.pet.owner = user.name;
    this._save();

    let localError = null;
    let localWarning = null;
    if (localAbilities) {
      onStep('connecting-device');
      this.pet.localAbilities = true;
      await this._verifyLocal({ force: true });
      if (!this._localOk) {
        this.pet.localAbilities = false;
        localError = this.localError;
      } else localWarning = this.localWarning;
      this._save();
    }

    onStep('hatching');
    await this._speak('met');
    return { view: this.view(), localError, localWarning };
  }

  // Create `speciesId`'s own LobeHub agent (in the lh workspace already selected) and her fresh entry.
  // The entry is not stored here: a failure leaves nothing behind.
  async _createCharacter(speciesId, name) {
    const sp = getSpecies(speciesId);
    const { agentId } = await this.lh.createAgent({
      title: `${name} (${sp.name})`,
      description: `Pixel Pet · ${sp.nameZh} · ${sp.vendor} 模型娘`,
      systemRole: persona.buildSystemRole({ speciesId, name, settings: this.settings }),
    });
    const c = state.createPet({ speciesId, name, agentId, now: this.now() });
    // the agent was just created with the current role
    c.personaVersion = persona.PERSONA_VERSION;
    c.personaKey = persona.personaKey(c, this.settings);
    return c;
  }

  // ---- keeping an existing agent up to date ---------------------------------------------
  // The system role carries the persona version and the current relationship scope; update the
  // LobeHub agent once whenever either changed (older pet, stage up/down, adult toggle).
  // A turn that starts while the launch warmup is still at it waits for that pass instead of running the same
  // lh calls next to it; its own pass then finds everything cached and only catches what changed meanwhile.
  // `trace` (core/latency.js): when each part finished, for the turn waiting on it.
  async _ensureReady(trace = latency.NOOP) {
    while (this._readying) {
      trace.set('waitedReady', true);
      await this._readying.catch(() => {});
    }
    this._readying = this._doEnsureReady(trace);
    try {
      await this._readying;
    } finally {
      this._readying = null;
    }
  }

  async _doEnsureReady(trace = latency.NOOP) {
    await this._ensurePersona(this._c());
    trace.mark('persona');
    // the model follows the character: her pick or default among her own vendor's models
    try {
      trace.set('modelsCached', this._modelsFresh());
      await this._catalogForTurn();
      trace.mark('models');
      await this._applyModel();
      trace.mark('applyModel');
    } catch (e) {
      this.emit('error', e); // keep the agent's current model; retried on the next turn
    }
    if (this.pet.localAbilities) await this._verifyLocal();
    trace.mark('local');
  }

  // Is the list of models still within MODELS_TTL_MS (no lh calls before the turn)?
  _modelsFresh() {
    return !!(this._catalogAt && this.now() - this._catalogAt < MODELS_TTL_MS);
  }

  // Her agent's system role follows her persona file, name and the owner's settings (updated once per change).
  async _ensurePersona(p) {
    const key = persona.personaKey(p, this.settings);
    if (p.personaVersion !== persona.PERSONA_VERSION || p.personaKey !== key) {
      try {
        await this.lh.updateAgent({ agentId: p.agentId, systemRole: persona.buildSystemRole({ speciesId: p.speciesId, name: p.name, pet: p, settings: this.settings }) });
        p.personaVersion = persona.PERSONA_VERSION;
        p.personaKey = key;
        this._save();
      } catch (e) {
        this.emit('error', e); // carry on with the old prompt; retried on the next turn
      }
    }
  }

  // ---- the model (⋯ → 角色列表 → her page → 模型) ----------------------------------------------------------
  // The user's enabled chat models, from the hosted provider and the roster's vendor providers. Cached for
  // MODELS_TTL_MS; `force` reloads (the panel's 刷新). A failure (an older lh, offline) keeps the previous
  // list, or none, and is not retried before the TTL either; the agent then keeps the model it has.
  async refreshModels({ force = false } = {}) {
    if (!force && this._modelsFresh()) return this._catalog;
    if (this._catalogLoading) return this._catalogLoading;
    this._catalogLoading = (async () => {
      try {
        const enabled = await this.lh.listEnabledProviders();
        const lists = await Promise.all(modelsLib.providersToQuery(enabled).map((p) => this.lh.listChatModels(p)));
        this._catalog = lists.flat();
        this._catalogAt = this.now();
        this._catalogError = null;
      } catch (e) {
        this._catalogError = e.message;
        this._catalogAt = this.now();
      } finally {
        this._catalogLoading = null;
      }
      if (this.pet) this.emit('update', this.view());
      return this._catalog;
    })();
    return this._catalogLoading;
  }

  // The list a turn picks her model from (docs/admin-chat-latency.md R2): stale-while-revalidate. A list already
  // loaded is used right away, even past MODELS_TTL_MS; then it is reloaded in the background, and what changed
  // is applied from the next turn (_applyModel). Only with no list yet (first launch) does the turn wait for it.
  // Reloading costs several `lh` processes in a row (≈2.3 s), which used to sit before the request every time
  // the list was older than 10 minutes.
  async _catalogForTurn() {
    if (!this._catalog) return this.refreshModels();
    this.prewarmModels();
    return this._catalog;
  }

  // Reload a list past MODELS_TTL_MS in the background (the chat page opening, a turn on a stale list), so the
  // next turn does not wait for it. Never throws, never waits.
  prewarmModels() {
    if (this._modelsFresh() || this._catalogLoading) return;
    this.refreshModels().catch(() => {});
  }

  _modelOptions(speciesId) {
    return this._catalog ? modelsLib.optionsFor(speciesId, this._catalog) : [];
  }

  // What a character's page shows under 模型 (default: the current character). `applied`: the model her
  // agent last ran on (null for one not met yet, who has no agent).
  modelView(speciesId = this.pet.speciesId) {
    const id = speciesId;
    const options = this._modelOptions(id);
    const current = modelsLib.pick(id, options, this.settings.models[id]);
    const e = this.pet.characters[id];
    return { loaded: !!this._catalog, error: this._catalogError, options, current: current ? current.key : null, applied: (e && e.modelApplied) || null, chosen: !!(current && current.key === this.settings.models[id]) };
  }

  // What the UI shows of one character: who she is (her name 「大肥鱼 · 像素」 and her base's), her kind and her
  // own pack as the 外观 card shows it (packsLib.packOption: picture, author, license, VRM terms).
  _characterInfo(e) {
    const b = SPECIES[e.base];
    const p = e.packId ? this.packs.get(e.packId) : null;
    return { id: e.id, base: e.base, name: e.name, label: e.label, nameZh: b.nameZh, kind: e.kind, kindLabel: e.kindLabel, adult: e.adult, source: e.source, pack: p ? packsLib.packOption(p) : e.clips ? packsLib.clipsOption(e.base) : null };
  }

  // The base (persona) a per-persona setting (model, 个性化设定, 好感度) is for: that of character `id` (an old
  // per-persona id is itself), else the current one's.
  _target(id) {
    if (id === undefined || id === null || id === '') return this.pet.speciesId;
    return this._baseOf(id);
  }

  // Point the agent at the model the current character should run on, once per change.
  async _applyModel(c = this.pet && this._c()) {
    if (!this.pet || !this._catalog || !c) return;
    const target = modelsLib.pick(c.speciesId, this._modelOptions(c.speciesId), this.settings.models[c.speciesId]);
    if (!target || c.modelApplied === target.key) return;
    await this.lh.updateAgent({ agentId: c.agentId, model: target.id, provider: target.providerId });
    c.modelApplied = target.key;
    this._save();
  }

  // ⋯ → 角色列表 → her page → 模型: choose one of `speciesId`'s models (default: the current character's),
  // kept in settings.models[speciesId]. For the current character it is applied right away in the
  // background (and again before the next turn if that failed); another one's agent switches to it when
  // she is the companion again (_applyModel before her next turn).
  setModel(key, speciesId) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const id = this._target(speciesId);
    if (!id) return { ok: false, reason: 'unknown-character' };
    if (!this._modelOptions(id).some((o) => o.key === key)) return { ok: false, reason: 'unknown' };
    this.settings = settingsLib.normalizeSettings({ ...this.settings, models: { ...this.settings.models, [id]: key } });
    this.settingsStore.save(this.settings);
    if (id === this.pet.speciesId && !this.busy) this._applyModel().catch((e) => this.emit('error', e));
    this._save();
    return { ok: true, view: this.view() };
  }

  // her page in the settings window → 外观 → 取景: character `characterId`'s own framing ('full' | 'half'), or 'auto'
  // to follow her pack's default and then the global prefs.framing (core/framing.js resolveFraming); kept in
  // settings.framings per character (each look of hers on its own, T-2764). Every pet window gets the new
  // settings at once and re-frames her live (renderer/vrm.js setFraming).
  setFraming(mode, characterId) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const id = this._charOf(characterId);
    if (!id) return { ok: false, reason: 'unknown-character' };
    if (mode !== 'auto' && !framingLib.isFraming(mode)) return { ok: false, reason: 'invalid' };
    const { [id]: _old, ...rest } = this.settings.framings;
    this.settings = settingsLib.normalizeSettings({ ...this.settings, framings: mode === 'auto' ? rest : { ...rest, [id]: mode } });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    this._save();
    return { ok: true, view: this.view(), settings: this.settingsView() };
  }

  // ⋯ → 角色列表 → her page → 个性化设定: the owner's own words added to `speciesId`'s system role (default:
  // the current character's), kept in settings.systemRoles[speciesId]; empty text removes them. It changes
  // her personaKey, so her agent is updated right away in the background when she is the companion (and
  // again before the next turn if that failed), otherwise before her next turn.
  setSystemRole(text, speciesId) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const id = this._target(speciesId);
    if (!id) return { ok: false, reason: 'unknown-character' };
    if (String(text || '').trim().length > settingsLib.SYSTEM_ROLE_MAX) return { ok: false, reason: 'too-long' };
    const { [id]: _old, ...rest } = this.settings.systemRoles;
    const clean = settingsLib.cleanSystemRole(text);
    this.settings = settingsLib.normalizeSettings({ ...this.settings, systemRoles: clean ? { ...rest, [id]: clean } : rest });
    this.settingsStore.save(this.settings);
    if (id === this.pet.speciesId && !this.busy) this._ensureReady().catch((e) => this.emit('error', e));
    this._save();
    return { ok: true, view: this.view() };
  }

  // Make this computer usable by the current character. Directly (via 'direct') when the Responses API can
  // be reached with the CLI's login: her tools then run inside the app and no device is needed. Otherwise,
  // or for a while after the direct path failed, find this computer's online device (starting
  // `lh connect --daemon` if none) and bind her agent to it (each agent records its own `boundDeviceId`).
  async _verifyLocal({ force = false } = {}) {
    const t = this.now();
    const c = this._c();
    if (this.responses && t - this._responsesFailedAt >= LOCAL_RETRY_MS) {
      if (!force && this._localOk && this.localVia === 'direct' && t - this._localCheckedAt < LOCAL_RECHECK_MS) return;
      if (this.responses.available()) {
        this._localOk = true;
        this._localAgent = c.agentId;
        this._localCheckedAt = t;
        this._localFailedAt = 0;
        this._deviceId = null;
        this.localError = null;
        this.localWarning = null;
        this.localVia = 'direct';
        return;
      }
    }
    if (this.localVia === 'direct') this._localOk = false; // the device has not been checked yet
    if (!force) {
      if (this._localOk && this._localAgent === c.agentId && t - this._localCheckedAt < LOCAL_RECHECK_MS) return;
      if (!this._localOk && this._localFailedAt && t - this._localFailedAt < LOCAL_RETRY_MS) return;
    }
    try {
      const { deviceId, via, daemon } = await ensureLocalDevice(this.lh);
      this._deviceId = deviceId;
      let bindWarning = null;
      if (c.boundDeviceId !== deviceId) {
        try {
          await this.lh.updateAgent({ agentId: c.agentId, agencyConfig: bindConfig(deviceId) });
          c.boundDeviceId = deviceId;
        } catch (e) {
          // An old lh has no `agent edit --agency-config-file`. The agent then cannot be bound, but every run can
          // still name the device (`--device <id>`), so local tools keep working; just tell the user to update lh.
          if (!/unknown option/i.test(e.message)) throw e;
          bindWarning = '你的 lh 版本较旧，没能把宠物绑定到这台电脑，已改为每次运行直接指定设备。建议升级：npm install -g @lobehub/cli@latest';
        }
      }
      this._localOk = true;
      this._localAgent = c.agentId;
      this._localCheckedAt = t;
      this._localFailedAt = 0;
      this.localError = null;
      this.localWarning = bindWarning || (daemon && daemon.error ? `lh connect 没能启动（${String(daemon.error).slice(0, 80)}），先用已在线的设备。` : null);
      this.localVia = via;
    } catch (e) {
      this._localOk = false;
      this._localFailedAt = t;
      this.localError = e.message;
      this.emit('error', e);
    }
  }

  // Turn "use this computer" on or off for the pet's agent.
  async setLocalAbilities(on) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    try {
      if (on) {
        this.pet.localAbilities = true;
        await this._verifyLocal({ force: true });
        if (this._cancelRequested) {
          this.pet.localAbilities = false;
          return { ok: false, reason: 'canceled' };
        }
        if (!this._localOk) {
          this.pet.localAbilities = false;
          return { ok: false, reason: 'error', message: this.localError };
        }
        return { ok: true, via: this.localVia };
      }
      // every character's agent was bound when she was current: unbind them all
      for (const c of Object.values(this.pet.characters)) {
        await this.lh.updateAgent({ agentId: c.agentId, agencyConfig: unbindConfig() });
        c.boundDeviceId = null;
      }
      this.pet.localAbilities = false;
      this._localOk = false;
      this._localAgent = null;
      return { ok: true };
    } catch (e) {
      this.emit('error', e);
      return { ok: false, reason: 'error', message: e.message };
    } finally {
      this.busy = false;
      this._save();
      this.emit('thinking', false);
    }
  }

  // At launch: bring an existing pet's agent up to date in the background (persona, device binding).
  async warmup() {
    if (!this.pet || this.busy) return;
    this._sayRetiredNotice();
    await this._ensureReady();
  }

  _sayRetiredNotice() {
    const n = this._retiredNotice;
    if (!n) return;
    this._retiredNotice = null;
    const sp = getSpecies(n.to);
    this._say(`（原来的角色已经下线，现在由${sp.title.split(' · ')[0]}「${sp.nameZh}」陪你，好感度和聊天记录都还在。）`, 'fallback', 'retired');
  }

  // ⋯ → 角色列表 → 切换 / 初次见面: change who the companion is. Every character has her own LobeHub agent, chat history,
  // name, affection and needs. One met before is back right away (her needs stood still while she was away);
  // a new one gets her own agent first (`name`: what the owner calls her, default her nameZh, as at hatch),
  // then says hello. If that fails, the current character stays and nothing is stored.
  // T-2764: `id` is a character (one look). Another look of the companion's own base is the same girl in
  // another form — same agent, chat, name and affection — so she changes at once and in silence; her own
  // wardrobe (what she last wore as that character) comes with her. An old per-persona id means that base's
  // current character (her default one when she is not the companion).
  async switchCharacter(id, { name } = {}) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    // who she may be is decided first: an unknown or (adult content off) 18+ character is refused for that reason,
    // never with a passing 'busy' that tells the owner to try again later (T-2787)
    const e = C.characterById(this.packs, id) || (Object.hasOwn(SPECIES, id) ? C.characterById(this.packs, this._charOf(id)) : null);
    if (!e) {
      // a catalog character not downloaded yet (内置与下载): download her first
      const d = Catalog.entry(id);
      if (d) return { ok: false, reason: d.adult && !this._adultOk() ? 'adult' : 'not-downloaded', name: d.name };
      return { ok: false, reason: 'unknown' };
    }
    if (!C.available(e, this._adultOk())) return { ok: false, reason: 'adult' };
    if (this.busy) return { ok: false, reason: 'busy' };
    const from = this._cid();
    if (e.id === from) {
      // shown as her default while her saved look waits to be downloaded: choosing the default keeps it
      if (this.pet.characterId !== e.id) {
        this.pet.characterId = e.id;
        this._save();
      }
      return { ok: true, view: this.view(), same: true };
    }
    const speciesId = e.base;
    if (speciesId === this.pet.speciesId) {
      this.pet.characterId = e.id;
      // her wardrobe as this character applies: an outfit her pack has no art for is taken off (T-2752)
      this._enforce(e.id);
      this._dropVisitorsOf(speciesId);
      this._save();
      return { ok: true, view: this.view(), from, created: false, sameBase: true };
    }
    const sp = getSpecies(speciesId);
    let next = this.pet.characters[speciesId];
    const created = !next;
    if (created) {
      this.busy = true;
      this._cancelRequested = false;
      this.emit('thinking', true);
      try {
        const ws = this.pet.space ? this.pet.space.workspaceId : null;
        // her agent goes where the first one lives; a pin set since then would send it elsewhere
        if (!ws && this.pet.space) {
          const pinned = await this.lh.pinnedWorkspace();
          if (pinned) throw new Error(`lh 目前固定在 workspace（${pinned}），她的 agent 没法建到个人空间。请先运行 lh workspace use --personal。`);
        }
        next = await this._createCharacter(speciesId, (name || '').trim().slice(0, 12) || sp.nameZh);
        if (this._cancelRequested) {
          await this.lh.deleteAgent(next.agentId).catch(() => {});
          return { ok: false, reason: 'canceled' };
        }
      } catch (e) {
        if (this._cancelRequested) return { ok: false, reason: 'canceled' };
        this.emit('error', e);
        return { ok: false, reason: 'error', message: e.message };
      } finally {
        this.busy = false;
        this.emit('thinking', false);
      }
      this.pet.characters[speciesId] = next;
    } else state.resume(next, this.now());
    // the one leaving stops here; her needs wait for her return
    resetWake.tick(this._c(), this.now());
    this.pet.speciesId = speciesId;
    this.pet.characterId = e.id;
    // her pack's wardrobe applies on arrival: an outfit it has no art for is taken off and saved (T-2752)
    const { changed: outfitChanged } = this._enforce(e.id);
    if (!created) this._save(); // saved below for a new one
    void outfitChanged;
    // she cannot visit herself (in any of her looks): the new companion leaves the visitors (同屏伙伴)
    this._dropVisitorsOf(speciesId);
    if (created) {
      this._save();
      if (this.pet.localAbilities) await this._verifyLocal({ force: true });
      await this._speak('met');
    } else this._say(sp.fallback.greet[0], 'fallback', 'switch');
    return { ok: true, view: this.view(), from, created };
  }

  // 同屏伙伴 who are the companion herself in another look go home.
  _dropVisitorsOf(base) {
    const keep = this.settings.visitors.filter((v) => this._baseOf(v) !== base);
    if (keep.length !== this.settings.visitors.length) this.setVisitors(keep);
  }

  _tools() {
    return this.pet.localAbilities && this._localOk ? LOCAL_TOOLS : [];
  }

  // ---- 音乐创作: compose_music (T-5090, T-5651) --------------------------------------------------------------
  // Its own gate, apart from 本机能力: on when 设置 → 音乐创作 → 让她作曲 is on and the service picked there
  // (music.provider: fal / elevenlabs / minimax) has a key — keys.<slot> or its environment variable (FAL_KEY /
  // ELEVENLABS_API_KEY / MINIMAX_API_KEY) — and this turn goes the direct way (the tool is a function tool run here;
  // `lh agent run` has no way to carry it). Local abilities stay as they are: turning music on never exposes
  // read_file / run_command. -> { on, provider, reason: null | 'unsupported' | 'off' | 'no-key' | 'via-device' | 'no-direct' }
  // `plain`: the settings window's 聊天 (no local tools, so the device path never applies there).
  _musicStatus({ plain = false } = {}) {
    if (!this.music) return { on: false, reason: 'unsupported' };
    const m = musicLib.normalizeMusic(this.settings.music);
    const provider = m.provider;
    if (!m.enabled) return { on: false, provider, reason: 'off' };
    if (!this._musicKey(provider)) return { on: false, provider, reason: 'no-key' };
    const local = !plain && this.pet && this._tools().length > 0;
    if (local && this.localVia !== 'direct') return { on: false, provider, reason: 'via-device' };
    if (local ? !(this.responses && this.responses.available()) : !this._directUp()) return { on: false, provider, reason: 'no-direct' };
    return { on: true, provider, reason: null };
  }

  // The key of a music service (default: the picked one). music.key(slot) reads the key store (main.js:
  // tts-keys.json); the environment variable is the fallback (music.keyFor).
  _musicKey(provider = musicLib.normalizeMusic(this.settings.music).provider) {
    const src = musicLib.KEY_SOURCES[provider];
    if (!src) return '';
    let k = '';
    try { k = (this.music && this.music.key && this.music.key(src.slot)) || ''; } catch { /* unreadable key store: as none */ }
    return musicLib.keyFor(provider, { key: typeof k === 'string' ? k : '', env: (this.music && this.music.env) || process.env });
  }

  // For the settings window: the picked service and which services have a key (never the keys themselves).
  musicKeysView() {
    if (!this.music) return null;
    const provider = musicLib.normalizeMusic(this.settings.music).provider;
    return { provider, keys: Object.fromEntries(musicLib.PROVIDER_IDS.map((id) => [id, !!this._musicKey(id)])) };
  }

  // Where songs are saved (and the only folder the windows may play from, main.js music-audio).
  musicDir() {
    if (!this.music) return null;
    try {
      return musicLib.resolveConfig({ settings: this.settings, key: '', env: this.music.env || process.env, userDataDir: this.music.userDataDir || '', allowInsecureLocal: !!this.music.allowInsecureLocal }).outputDir || null;
    } catch {
      return null;
    }
  }

  // ---- 她的音乐库 (core/music-library.js) ---------------------------------------------------------------------
  // A song compose_music saved goes into the library under the character who made it (ctx.speciesId). A library
  // that cannot be written must not cost the song: the reply still shows it. -> the song | null
  _addSong(result, ctx, args) {
    if (!ctx || !ctx.speciesId || !result || !result.filePath) return null;
    try {
      const r = musicLibrary.addSong(this.songStore.load(), { result, speciesId: ctx.speciesId, kind: ctx.kind, turnId: ctx.turnId, request: args, now: this.now() });
      if (!r.song) return null;
      this.songStore.save(r.data);
      this.emit('music-library', { speciesId: r.song.speciesId, id: r.song.id, change: 'added' });
      return r.song;
    } catch (e) {
      this.emit('error', Object.assign(new Error(`音乐库写入失败：${e.message}`), { code: 'EMUSICLIB' }));
      return null;
    }
  }

  // 角色详情 → 音乐: her songs, newest first; `exists`: the file is still there (it may have been moved or deleted
  // outside the app). Without `speciesId`: every character's.
  musicLibraryView(speciesId = null) {
    const songs = musicLibrary.songsOf(this.songStore.load(), speciesId ? String(speciesId) : null).map((s) => {
      let exists = false;
      try { exists = fs.statSync(s.filePath).isFile(); } catch { /* gone */ }
      return { ...s, exists };
    });
    return { ok: true, speciesId: speciesId || null, dir: this.musicDir(), songs };
  }

  renameSong({ id, title } = {}) {
    const r = musicLibrary.renameSong(this.songStore.load(), String(id || ''), title);
    if (!r) return { ok: false, reason: typeof title === 'string' && title.trim() ? 'missing' : 'invalid' };
    this.songStore.save(r.data);
    this.emit('music-library', { speciesId: r.song.speciesId, id: r.song.id, change: 'renamed' });
    return { ok: true, song: r.song };
  }

  // Removes the song from her library and deletes its audio file (the 聊天记录 line keeps its words; its card then
  // says the file is gone). A file already gone is not an error.
  deleteSong({ id } = {}) {
    const r = musicLibrary.removeSong(this.songStore.load(), String(id || ''));
    if (!r) return { ok: false, reason: 'missing' };
    try {
      fs.unlinkSync(r.song.filePath);
    } catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, reason: 'io', message: `删不掉这个文件：${e.message}` };
    }
    this.songStore.save(r.data);
    this.emit('music-library', { speciesId: r.song.speciesId, id: r.song.id, change: 'deleted' });
    return { ok: true, id: r.song.id };
  }

  // Whether a window may play / open this file (main.js musicFile, after realpath): inside the music folder, or a
  // song of the library (saved before the folder was changed in 设置 → 音乐创作).
  isLibrarySong(realFile) {
    return musicLibrary.normalizeLibrary(this.songStore.load()).songs.some((s) => {
      try { return fs.realpathSync(s.filePath) === realFile; } catch { return false; }
    });
  }

  // One turn's compose_music tool. `ctx`: { kind, speciesId, turnId, streamId, results: [] } — the songs saved go into
  // ctx.results (the caller shows them with the reply); every step is a 'music' event for the windows (作曲中…).
  _musicTool(ctx) {
    const generate = (params, opts) => {
      const cfg = musicLib.resolveConfig({ settings: this.settings, key: this._musicKey(), env: this.music.env || process.env, userDataDir: this.music.userDataDir || '', allowInsecureLocal: !!this.music.allowInsecureLocal });
      if (this.music.generate) return this.music.generate(params, { ...opts, config: cfg });
      return musicLib.generateMusic(params, { ...opts, config: cfg, fetch: this.music.fetch, now: this.now });
    };
    return createMusicTool({
      generate,
      onEvent: (e) => {
        const title = (e.args && typeof e.args.title === 'string' && e.args.title.slice(0, 60)) || '';
        const base = { kind: ctx.kind, speciesId: ctx.speciesId, turnId: ctx.turnId, streamId: ctx.streamId || null, tool: MUSIC_TOOL_NAME, title, instrumental: !!(e.args && e.args.instrumental) };
        if (e.state === 'start') {
          ctx.startedAt = this.now();
          this.emit('music', { ...base, state: 'composing', startedAt: ctx.startedAt });
        } else if (e.state === 'progress') {
          this.emit('music', { ...base, state: 'composing', stage: e.stage || null, startedAt: ctx.startedAt });
        } else if (e.state === 'done') {
          const v = musicView(e.result);
          const song = this._addSong(e.result, ctx, e.args);
          if (song) v.libraryId = song.id;
          ctx.results.push(v);
          this.emit('music', { ...base, state: 'done', music: v, ms: this.now() - (ctx.startedAt || this.now()) });
        } else if (e.state === 'failed') {
          const err = e.error || {};
          ctx.errors.push({ reason: err.reason || 'error', message: String(err.message || err).slice(0, 200) });
          this.emit('music', { ...base, state: 'failed', reason: err.reason || 'error', error: String(err.message || err).slice(0, 200) });
        }
      },
    });
  }

  // ---- AI 可读的文件夹 (core/ai-folders.js, T-5075, docs/permissions.md) ------------------------------------
  // Once, the first time this version loads: owners who already had 本机能力 on keep no limit until they add a
  // folder; everyone else starts with none (and no commands).
  _decideLocal() {
    const l = this.settings.local;
    if (l.allowCommands !== null) return; // decided already
    const next = aiFolders.decideLocal(l, { localOn: !!(this.pet && this.pet.localAbilities) });
    this.settings = settingsLib.normalizeSettings({ ...this.settings, local: next });
    this.settingsStore.save(this.settings);
  }

  _setLocal(local) {
    this.settings = settingsLib.normalizeSettings({ ...this.settings, local });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    if (this.pet) this.emit('update', this.view());
  }

  // Where this turn's local tools may go (null: no limit). `extraRead`: what the owner handed her this turn.
  _toolScope(extraRead = []) {
    return aiFolders.toolScope(this.settings.local, { extraRead });
  }

  // The settings window / 授权 page: add folders (already picked in a system dialog), remove one, or switch
  // 允许运行命令. Adding the first folder to an unlimited list starts the limit. `asked`: a macOS standard
  // folder whose system prompt was triggered (permissions.js).
  setAiFolders({ add = null, remove = null, allowCommands, asked = null } = {}) {
    let l = this.settings.local;
    if (add) l = aiFolders.addFolders(l, add);
    if (remove) l = aiFolders.removeFolder(l, remove);
    if (typeof allowCommands === 'boolean') l = { ...l, allowCommands };
    if (asked && aiFolders.SYSTEM_FOLDERS.includes(asked)) l = { ...l, asked: [...new Set([...l.asked, asked])] };
    if (l.allowCommands === null) l = { ...l, allowCommands: false };
    this._setLocal(l);
    return { ok: true, local: this.settings.local, settings: this.settingsView() };
  }

  // Stop whatever the agent is doing right now.
  cancel() {
    if (!this.busy) return;
    this._cancelRequested = true;
    this.lh.cancel();
    if (this.responses) this.responses.cancel();
  }

  // Steps that swallow errors (device lookup, persona update) must not let a cancelled turn carry on.
  _throwIfCanceled() {
    if (this._cancelRequested) throw Object.assign(new Error('Canceled'), { code: 'ECANCELED' });
  }

  _device() {
    return this.pet.localAbilities && this._localOk ? this._deviceId : null;
  }

  // Can a turn go straight to the Responses API right now? The CLI's login is readable (or an API key is set)
  // and the direct way has not failed in the last LOCAL_RETRY_MS. Only looks at local files.
  _directUp() {
    return !!this.responses && this.now() - this._responsesFailedAt >= LOCAL_RETRY_MS && this.responses.available();
  }

  // One agent turn (docs/streaming.md §1). Every turn goes the direct way (Responses API, SSE) when it is up,
  // because that is the way her reply arrives as it is written; `lh agent run --json` (lh 0.0.62–0.0.73) only
  // prints its events when the run is over.
  // - Local abilities on and checked the direct way: her tools are function tools run here. If that fails before
  //   any of them ran, the same turn is sent again through `lh connect` (a tool that already ran must not run
  //   twice, so then the error stands).
  // - Local abilities on through a device (`lh connect`): `lh agent run --tool … --device …` as before.
  // - Everything else (local abilities off, a greeting, a proactive line, a topic): direct with no tools, same
  //   agent and topic (a response id is the topic id). Not up (no login, a recent failure) → `lh agent run`.
  //   If the direct turn fails in any way but Esc / the time limit, the same turn goes through `lh agent run`
  //   once: the reply is not lost, the bubble starts over with that one (no doubled text), and the line is said
  //   and saved to 聊天记录 once, by the caller, after this returns.
  // `stream` (_openStream): its onDelta gets the reply as it is written, on either way.
  // `plain`: no local tools whatever the setting (the settings window's 聊天, which runs no device work).
  // `trace` (core/latency.js): which way the turn went, and when a fallback started.
  // `music`: this turn's compose_music tool (_musicTool), or null. It is a function tool run here, so it only goes
  // with a direct turn (_musicStatus said on); an `lh agent run` turn never has it. Once it ran (a song may have been
  // made and billed), a failure afterwards is not sent again another way: toolsRan stands, like a local tool's.
  // `extraRead`: paths the owner handed her this turn (dropped files): readable even outside her folders.
  // AI 可读的文件夹 (T-5075): while the list is in effect her tools only run here, where the folders are enforced;
  // `lh connect` runs them in its daemon, which has no way to limit them, so such a turn goes without tools.
  async _runTurn(args, stream = null, { plain = false, trace = latency.NOOP, music = null, extraRead = [] } = {}) {
    if (stream) args = { ...args, onDelta: stream.onDelta };
    if (trace.on) args = { ...args, trace };
    let tools = plain ? [] : this._tools();
    const scope = tools.length ? this._toolScope(extraRead) : null;
    const extraTools = music ? [music] : [];
    trace.set('tools', tools.length);
    if (music) trace.set('music', true);
    if (tools.length && scope && this.localVia !== 'direct') {
      trace.set('toolsDropped', 'folders limited, no direct way');
      this.localWarning = NO_LOCAL_TOOLS_LINE;
      this._toolsDropped = true;
      tools = [];
    }
    if (tools.length) {
      if (this.localVia !== 'direct') {
        trace.set('via', 'lh-connect');
        return this.lh.run({ ...args, tools, device: this._device() });
      }
      trace.set('via', 'direct-tools');
      try {
        return await this.responses.run({ ...args, tools, scope, extraTools });
      } catch (e) {
        if (e.code === 'ECANCELED' || e.code === 'ETIMEDOUT' || e.toolsRan) throw e;
        if (scope) {
          // the folders cannot be enforced through lh connect: the same turn without tools, through lh agent run
          trace.set('via', 'lh-run-no-tools');
          trace.set('fallbackReason', String(e.message).slice(0, 200));
          trace.mark('fallbackStart');
          this.emit('error', e);
          this._responsesFailedAt = this.now();
          this.localWarning = NO_LOCAL_TOOLS_LINE;
          this._toolsDropped = true;
          if (stream) stream.restart();
          return this.lh.run({ ...args, tools: [], device: null });
        }
        trace.set('via', 'lh-connect-fallback');
        trace.set('fallbackReason', String(e.message).slice(0, 200));
        trace.mark('fallbackStart');
        this.emit('error', e);
        this._responsesFailedAt = this.now();
        await this._verifyLocal({ force: true });
        this._throwIfCanceled();
        if (this._localOk) this.localWarning = `直连 LobeHub 失败，这次改用 lh connect（${String(e.message).slice(0, 80)}）`;
        if (stream) stream.restart();
        return this.lh.run({ ...args, tools: this._tools(), device: this._device() });
      }
    }
    if (!this._directUp()) {
      trace.set('via', 'lh-run');
      trace.set('fallbackReason', !this.responses ? 'no direct client' : this.now() - this._responsesFailedAt < LOCAL_RETRY_MS ? 'direct failed recently' : 'no lh login token for the direct way');
      trace.mark('reqSent');
      return this.lh.run({ ...args, tools: [], device: null });
    }
    trace.set('via', 'direct');
    try {
      return await this.responses.run({ ...args, tools: [], extraTools });
    } catch (e) {
      if (e.code === 'ECANCELED' || e.code === 'ETIMEDOUT' || e.toolsRan) throw e;
      this._throwIfCanceled();
      trace.set('via', 'lh-run-fallback');
      trace.set('fallbackReason', String(e.message).slice(0, 200));
      trace.mark('fallbackStart');
      this.emit('error', Object.assign(new Error(`直连流式失败，这次改用 lh agent run：${e.message}`), { code: e.code, cause: e }));
      this._responsesFailedAt = this.now();
      if (stream) stream.restart();
      return this.lh.run({ ...args, tools: [], device: null });
    }
  }

  // Ask the agent to say something for a system-triggered event.
  async _speak(kind) {
    const t = this.now();
    const c = this._c();
    const sp = getSpecies(c.speciesId);
    // While she is busy (a reply may be streaming into the bubble) a system line would cut into that reply and
    // land in 聊天记录 between the owner's message and her answer, so it is dropped; the next heartbeat asks again.
    if (this.busy) return;
    if (!this.budget.canSpend(t)) {
      this._say(this._fallback(sp, kind), 'fallback', kind, 'hourly LLM budget spent');
      return;
    }
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    const stream = this._openStream(kind);
    try {
      this.budget.spend(t);
      await this._ensureReady();
      this._throwIfCanceled();
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt: persona.buildEventPrompt(kind, c, t, this._promptSettings()) }, stream);
      if (res.topicId) c.topicId = res.topicId;
      if (kind === 'greet_morning' || kind === 'greet_evening') c.lastGreetDay = new Date(t).toDateString();
      this._closeStream(stream, true, null, this._say(this._guard(res.text), 'llm', kind, null, null, null, stream));
    } catch (e) {
      this._closeStream(stream, false, e.code === 'ECANCELED' ? 'canceled' : 'error');
      if (e.code === 'ECANCELED') {
        this._save();
        return;
      }
      if (kind === 'greet_morning' || kind === 'greet_evening') c.lastGreetDay = new Date(t).toDateString();
      this._say(this._fallback(sp, kind), 'fallback', kind, e.message);
      this.emit('error', e);
    } finally {
      this.busy = false;
      this.emit('thinking', false);
    }
  }

  // 她的房间: main sets `roomHook(text) → note` while an illustrated room is open in the game window
  // (main.js roomChat): it matches the message (core/room-intent.js), switches her there and returns the prompt note.
  // A hook that throws never stops the chat.
  async _roomNote(text, origin, attachments) {
    if (typeof this.roomHook !== 'function' || origin !== 'user' || !text) return '';
    try { return String((await this.roomHook(text, { attachments })) || ''); } catch (e) { this.emit('error', e); return ''; }
  }

  // her finished reply, for the room (main.js → core/room-chat.js onReply): 「我把灯关了」 → the lamp goes off in the picture
  _roomReply(text) {
    if (typeof this.roomReplyHook !== 'function' || !text) return;
    try { this.roomReplyHook(text); } catch (e) { this.emit('error', e); }
  }

  // `images`: local picture files to upload so the model can see them (pasted screenshots).
  // `files`: paths of dropped files/folders; they are NOT uploaded: the agent reads them with her local
  // tools (run here, or through the bound device), so local abilities must be on.
  // `origin`: 'user' for the chat box; the local HTTP API passes 'api' (an outside script, not the owner).
  // `sticker`: { set, id } — a 表情包 picked in the chat box's panel (docs/stickers-design.md §3.1), only one of
  // hers; the owner's own chat box only (the HTTP API cannot send one, §3.6).
  async chat(text, images = [], files = [], { origin = 'user', sticker: pick = null } = {}) {
    const clean = String(text || '').trim();
    const paths = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f).slice(0, 10);
    const sticker = pick && origin === 'user' && this.pet ? this._sticker(getSpecies(this.pet.speciesId), pick) : null;
    if (pick && origin === 'user' && this.pet && !sticker) return { ok: false, reason: 'bad-sticker', message: '这张表情包已经不在了' };
    if (!this.pet || (!clean && images.length === 0 && paths.length === 0 && !sticker)) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    if (paths.length && !this.pet.localAbilities) return { ok: false, reason: 'local-off' };
    const t = this.now();
    const c = this._c();
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    // 插个嘴: a message to her ends whatever was waiting, and may be the owner's reaction to her last remark
    if (origin === 'user') this.interjector.userChatted(clean);
    const turn = this._logUser(clean, origin === 'api' ? 'api' : 'user', 'chat', { images: images.length, files: paths.map((f) => path.basename(f)) }, sticker);
    if (sticker) this.emit('chat-log', { speciesId: c.speciesId }); // the settings window's chat shows it too
    // 她的房间 (docs/illustrated-room.md §4): with her room open, 「回床上休息吧」 switches her state right away —
    // before the model answers — and the note tells her agent what she just did there
    const room = await this._roomNote(clean, origin, images.length + paths.length);
    const stream = this._openStream('chat', turn);
    const trace = latency.createTrace('desktop');
    stream.trace = trace;
    trace.set('speciesId', c.speciesId);
    trace.set('turnId', turn ? turn.turnId : null);
    trace.set('textChars', clean.length);
    trace.mark('logged');
    let ok = false;
    let musicCtx = null;
    try {
      state.touch(c, t);
      await this._ensureReady(trace);
      trace.mark('ready');
      this._throwIfCanceled();
      if (paths.length && !this._localOk) {
        this._closeStream(stream, false, 'error');
        this._logPet('', 'chat', turn, 'error');
        return { ok: false, reason: 'local-error', message: this.localError };
      }
      const local = this._tools().length > 0;
      const musicStatus = this._musicStatus();
      trace.set('musicReason', musicStatus.reason);
      musicCtx = { kind: 'chat', speciesId: c.speciesId, turnId: turn ? turn.turnId : null, streamId: stream.id, results: [], errors: [] };
      let body;
      if (images.length) {
        const fileIds = [];
        for (const img of images) fileIds.push(await this.lh.uploadFile(img));
        if (!c.topicId) c.topicId = await this.lh.createTopic(c.agentId, c.name);
        const mid = await this.lh.createUserMessage({ agentId: c.agentId, topicId: c.topicId, content: clean || '（发了一张图片）' });
        await this.lh.addFilesToMessage(mid, fileIds);
        body = `[图片] 主人刚发来 ${images.length} 张图片${clean ? '和上面那句话' : ''}（就在上一条消息里），请先看图，再直接回应。`;
        if (paths.length) body += `\n${persona.buildFilesBlock(paths, true)}`;
      } else {
        body = [clean, paths.length ? persona.buildFilesBlock(paths, !!clean) : ''].filter(Boolean).join('\n');
      }
      if (sticker) body = [body, adminChat.stickerLine(sticker)].filter(Boolean).join('\n');
      const prompt = persona.buildChatPrompt(body, c, t, { local, settings: this._promptSettings(), localScope: local ? aiFolders.scopeHint(this._toolScope(paths)) : '', music: musicStatus, room });
      trace.set('bodyChars', body.length);
      trace.set('promptChars', prompt.length);
      trace.set('topicFresh', !c.topicId);
      trace.mark('runStart');
      this._toolsDropped = false;
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt }, stream, { trace, extraRead: paths, music: musicStatus.on ? this._musicTool(musicCtx) : null });
      trace.mark('runEnd');
      trace.set('replyChars', (res.text || '').length);
      if (res.topicId) c.topicId = res.topicId;
      const { affection } = state.chatted(c, this.now(), { textLength: [...clean].length || (images.length || paths.length || sticker ? 2 : 0) });
      const text = this._guard(res.text);
      const music = musicCtx.results;
      this._closeStream(stream, true, null, this._say(text, 'llm', 'chat', null, null, turn, stream, { music }));
      if (room) this._roomReply(text);
      trace.mark('doneSent');
      this._reportAffection(affection);
      ok = true;
      // 本机能力 on but this turn went without tools (folders limited, no direct way): the pet window says so
      return { ok: true, text, cost: res.cost, affection, ...(music.length ? { music } : {}), ...(this._toolsDropped ? { localNote: NO_LOCAL_TOOLS_LINE } : {}) };
    } catch (e) {
      // the song was made (and billed) but her answer after it failed: the song is still shown and kept, the turn
      // is not sent again (toolsRan), and the bubble says it is there
      if (e.code !== 'ECANCELED' && musicCtx && musicCtx.results.length) {
        this.emit('error', e);
        const music = musicCtx.results;
        const text = `曲子写好了：${musicNames(music)}，点下面就能听～`;
        this._closeStream(stream, true, null, this._say(text, 'fallback', 'chat', e.message, null, turn, stream, { music }));
        this._save();
        ok = true;
        return { ok: true, text, partial: true, music };
      }
      this._closeStream(stream, false, e.code === 'ECANCELED' ? 'canceled' : 'error');
      if (e.code !== 'ECANCELED') this.emit('error', e);
      this._logPet('', 'chat', turn, e.code === 'ECANCELED' ? 'canceled' : 'error');
      this._save(); // touch() above may have woken the pet; keep the sprite in sync
      trace.set('error', e.code || String(e.message).slice(0, 120));
      if (e.code === 'ECANCELED') return { ok: false, reason: 'canceled' };
      return { ok: false, reason: 'error', code: e.code || null, message: e.message };
    } finally {
      this.busy = false;
      this.emit('thinking', false);
      trace.end({ ok });
    }
  }

  // ---- 设置窗口 → 聊天 (core/admin-chat.js, docs/admin-chat.md) ------------------------------------------------
  // One character is one conversation: her own agent and topic, her 聊天记录. Any character met before can be
  // talked to here, not only the companion on the desktop; the desktop shows nothing of it (no bubble), but
  // the rounds are in her history there and her agent remembers them.

  // The left column: every character, with how her conversation stands.
  chatCharacters() {
    if (!this.pet) return { ok: true, characters: [] };
    this.prewarmModels(); // the chat page is open: have her model list fresh before the first message
    const all = this.log.list();
    return {
      ok: true,
      busy: this.busy ? (this._consoleTurn ? this._consoleTurn.speciesId : 'desktop') : null,
      characters: Object.values(SPECIES).map((x) => {
        const e = this.pet.characters[x.id];
        const conv = e ? adminChat.conversationOf(all, x.id) : [];
        const last = conv[conv.length - 1] || null;
        const lastText = last ? (last.text || '').replace(/\s+/g, ' ').trim() : '';
        const current = x.id === this.pet.speciesId;
        // where the companion is now: on the desktop, or in the game she is playing (her desktop window hides meanwhile)
        const place = current ? (typeof this.placeHook === 'function' && this.placeHook() ? `在${this.placeHook()}` : '在桌面') : undefined;
        return { id: x.id, met: !!e, name: e ? e.name : getSpecies(x.id).nameZh, current, place, count: conv.length, lastAt: last ? last.at : null, preview: lastText.slice(0, 60) || chatLog.stickerLabel(last) || (last && last.attachments && last.attachments.images ? '［图片］' : '') };
      }),
    };
  }

  // Her conversation, a page at a time (newest last): raw 聊天记录 messages; main turns them into views.
  chatHistory(speciesId, { before = null, limit } = {}) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const id = this._target(speciesId);
    if (!id) return { ok: false, reason: 'unknown-character' };
    const page = adminChat.historyPage(adminChat.conversationOf(this.log.list(), id), { before, limit });
    const t = this._consoleTurn && this._consoleTurn.speciesId === id ? this._consoleTurn : null;
    // live: the reply being written so far, for a page opened mid-reply (deltas are increments, core/chat-live.js)
    return { ok: true, speciesId: id, met: !!this.pet.characters[id], streaming: !!t, live: t ? { turnId: t.turnId, text: t.text || '' } : null, ...page };
  }

  // Stop the reply the chat page is waiting for (only its own turn: the desktop's is stopped there).
  chatAbort(speciesId) {
    const t = this._consoleTurn;
    if (!t || (speciesId && t.speciesId !== speciesId)) return { ok: true, aborted: false };
    this.cancel();
    return { ok: true, aborted: true, speciesId: t.speciesId };
  }

  _logAs(speciesId, msg) {
    const c = this.pet.characters[speciesId];
    const n = (c && c.topicEpoch) || 0;
    try {
      return this.log.append({ speciesId, origin: 'user', kind: 'chat', via: 'console', ...(n ? { topicEpoch: n } : {}), ...msg }, this.now());
    } catch (e) {
      this.emit('error', e);
      return { id: `x${this.now().toString(36)}`, at: this.now(), speciesId, ...msg };
    }
  }

  // The topic this turn continues (docs/admin-chat.md §2): one that has run for CONTEXT_MS is put aside and
  // the turn opens a fresh one. `conv`: her conversation so far. -> { fresh, startedAt }
  _rollTopic(c, conv, t) {
    const span = adminChat.CONTEXT_MS;
    if (c.topicId) {
      let meta = c.topicMeta && c.topicMeta.id === c.topicId ? c.topicMeta : null;
      if (!meta) {
        // a topic from before this rule (or opened on the desktop): it started no later than the first round of
        // the last stretch without a CONTEXT_MS pause; with no round in the last CONTEXT_MS it is put aside
        const lastAt = conv.length ? conv[conv.length - 1].at : 0;
        if (lastAt && t - lastAt <= span) {
          let first = conv.length - 1;
          while (first > 0 && conv[first].at - conv[first - 1].at <= span) first--;
          meta = { id: c.topicId, startedAt: conv[first].at };
        } else meta = { id: c.topicId, startedAt: 0 };
        c.topicMeta = meta;
      }
      if (t - meta.startedAt <= span) return { fresh: false, startedAt: meta.startedAt };
      c.pastTopicIds = [...(Array.isArray(c.pastTopicIds) ? c.pastTopicIds : []), c.topicId].slice(-50);
      c.topicId = null;
      c.topicMeta = null;
    }
    return { fresh: true, startedAt: t };
  }

  // One round from the chat page with `speciesId`. `images`: pictures already checked and saved by main
  // ([{ path, ref }], core/admin-chat.js ChatImages). onDelta({ speciesId, turnId, text }) as the reply is written.
  // -> { ok, speciesId, turnId, userMessage, message } | { ok: false, reason, error, userMessage?, message? }
  // `sticker`: { set, id } from the chat page's 表情包 panel (docs/stickers-design.md §3): only a set she holds.
  async chatAs(speciesId, { text, images = [], sticker: pick = null } = {}, { onDelta = () => {} } = {}) {
    if (!this.pet) return { ok: false, reason: 'empty', error: '还没有领养桌宠' };
    const id = this._target(speciesId);
    if (!id) return { ok: false, reason: 'unknown-character', error: '没有这个角色' };
    const c = this.pet.characters[id];
    if (!c) return { ok: false, reason: 'not-met', error: '还没和她见过面：先在「角色」里和她初次见面，再来聊天' };
    const clean = String(text || '').trim();
    const imgs = (Array.isArray(images) ? images : []).filter((x) => x && x.path).slice(0, adminChat.MAX_IMAGES);
    const sticker = pick ? this._sticker(getSpecies(id), pick) : null;
    if (pick && !sticker) return { ok: false, reason: 'bad-sticker', error: '这张表情包已经不在了' };
    if (!clean && !imgs.length && !sticker) return { ok: false, reason: 'empty', error: '消息是空的' };
    if (clean.length > adminChat.MAX_TEXT) return { ok: false, reason: 'too-long', error: `一条消息最多 ${adminChat.MAX_TEXT} 个字符` };
    if (this.busy) return { ok: false, reason: 'busy', error: this._consoleTurn ? '上一条消息还在回复中' : '桌宠那边正在说话，等她说完再发' };
    const sp = getSpecies(id);
    const isCur = id === this.pet.speciesId;
    this.busy = true;
    this._cancelRequested = false;
    const turnId = `t${this.now().toString(36)}${Math.floor(this.rnd() * 1e6).toString(36)}`;
    this._consoleTurn = { speciesId: id, turnId };
    if (isCur) this.emit('thinking', true);
    let userMessage = null;
    let partial = '';
    let modelKey = null;
    let musicCtx = null;
    const trace = latency.createTrace('admin');
    trace.set('speciesId', id);
    trace.set('turnId', turnId);
    trace.set('textChars', clean.length);
    let ok = false;
    try {
      // the model she runs on: hers, among her vendor's (the same pick as her page → 模型)
      trace.set('modelsCached', this._modelsFresh());
      try {
        await this._catalogForTurn();
      } catch { /* keep the agent's model */ }
      trace.mark('models');
      const target = modelsLib.pick(id, this._modelOptions(id), this.settings.models[id]);
      modelKey = target ? target.key : c.modelApplied || null;
      trace.set('model', modelKey);
      if (imgs.length && target && target.vision === false) return { ok: false, reason: 'no-vision', error: `「${target.label}」看不了图片：在模型里换一个标着「视觉」的，或者先移除图片` };
      const t = this.now();
      const conv = adminChat.conversationOf(this.log.list(), id);
      userMessage = this._logAs(id, { role: 'user', turnId, text: clean, ...(imgs.length ? { attachments: { images: imgs.length, refs: imgs.map((x) => x.ref).filter(Boolean) } } : {}), ...stickerField(sticker) });
      this.emit('chat-log', { speciesId: id });
      trace.mark('logged');
      await this._ensurePersona(c);
      trace.mark('persona');
      try {
        await this._applyModel(c);
      } catch (e) {
        this.emit('error', e);
      }
      trace.mark('applyModel');
      this._throwIfCanceled();
      const roll = this._rollTopic(c, conv, t);
      // 重新开始话题 (newTopic) asked for a clean start: nothing from before it is carried over
      const epoch = c.topicEpoch || 0;
      const recent = roll.fresh ? adminChat.recentRounds(conv.filter((m) => (Number(m.topicEpoch) || 0) === epoch), t) : [];
      // what is not in the model's context any more: before the carried-over rounds, or before this topic began
      const cutoff = roll.fresh ? (recent.length ? recent[0].at : t) : roll.startedAt;
      const recall = adminChat.wantsRecall(clean) ? adminChat.pickRecall(conv.filter((m) => m.at < cutoff), clean) : [];
      if (imgs.length) {
        const fileIds = [];
        for (const img of imgs) fileIds.push(await this.lh.uploadFile(img.path));
        if (!c.topicId) {
          c.topicId = await this.lh.createTopic(c.agentId, c.name);
          c.topicMeta = { id: c.topicId, startedAt: t };
        }
        const mid = await this.lh.createUserMessage({ agentId: c.agentId, topicId: c.topicId, content: clean || '（发了一张图片）' });
        await this.lh.addFilesToMessage(mid, fileIds);
      }
      this._throwIfCanceled();
      const body = adminChat.buildConsoleBody({ name: c.name, text: clean, recent, recall, images: imgs.length, sticker });
      // 音乐创作 works here too: compose_music is not a local ability, so `plain` (no local tools) does not stop it
      const musicStatus = this._musicStatus({ plain: true });
      trace.set('musicReason', musicStatus.reason);
      musicCtx = { kind: 'console', speciesId: id, turnId, streamId: null, results: [], errors: [] };
      // 她的房间: talking here to the companion whose room is open moves her there too
      const room = id === this.pet.speciesId ? await this._roomNote(clean, 'user', imgs.length) : '';
      const prompt = persona.buildChatPrompt(body, c, t, { local: false, settings: this._promptSettings(), music: musicStatus, room });
      trace.set('topicFresh', roll.fresh);
      trace.set('recentMsgs', recent.length);
      trace.set('recallMsgs', recall.length);
      trace.set('convMsgs', conv.length);
      trace.set('bodyChars', body.length);
      trace.set('promptChars', prompt.length);
      trace.mark('prompt');
      const stream = {
        onDelta: (_chunk, soFar) => {
          trace.mark('firstDelta');
          if (this._cancelRequested) return;
          const shown = contentGuard.checkReply(soFar).ok ? adminChat.answerOnly(memes.streamingText(soFar), { streaming: true }) : '';
          if (shown === partial) return;
          const piece = chatLive.encode(partial, shown); // only what was added goes over IPC (whole text when it is not an append)
          partial = shown;
          if (this._consoleTurn) this._consoleTurn.text = shown;
          trace.mark('firstShown');
          trace.markLast('lastShown');
          trace.add('deltas');
          trace.add('ipcBytes', Buffer.byteLength(piece.append ?? piece.text));
          try {
            onDelta({ speciesId: id, turnId, ...piece });
          } catch { /* a display callback must not cost the turn */ }
        },
        restart: () => {
          partial = '';
          if (this._consoleTurn) this._consoleTurn.text = '';
          try {
            onDelta({ speciesId: id, turnId, text: '', restart: true });
          } catch { /* as above */ }
        },
      };
      trace.mark('runStart');
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt }, stream, { plain: true, trace, music: musicStatus.on ? this._musicTool(musicCtx) : null });
      trace.mark('runEnd');
      trace.set('replyChars', (res.text || '').length);
      if (res.topicId && res.topicId !== c.topicId) {
        c.topicId = res.topicId;
        c.topicMeta = { id: res.topicId, startedAt: t };
      }
      const ex = memes.extractMeme(res.text, this._memeSpecies(sp));
      // her own 表情包 at the end of the reply ([梗图:<id>]) is kept with it (it used to be dropped here)
      const replySticker = ex.meme && this.settings.prefs.memes ? this._sticker(sp, ex.meme) : null;
      let reply = adminChat.answerOnly(ex.text || res.text);
      if (!reply) throw Object.assign(new Error('Agent produced no answer'), { code: 'ENOREPLY' });
      const g = contentGuard.checkReply(reply);
      if (!g.ok) {
        this.emit('error', Object.assign(new Error(`reply blocked by content guard: ${g.category}`), { code: 'ECONTENT' }));
        reply = contentGuard.refusalLine(sp);
      }
      c.lastSpokeAt = this.now();
      if (room) this._roomReply(reply);
      const music = musicCtx.results;
      const message = this._logAs(id, { role: 'pet', turnId, text: reply, ...(modelKey ? { model: modelKey } : {}), ...(music.length ? { attachments: { music } } : {}), ...(g.ok ? stickerField(replySticker) : {}) });
      // chatting counts for her like chatting on the desktop; only the companion's needs and mood run, though
      let affection = null;
      if (isCur) affection = state.chatted(c, this.now(), { textLength: [...clean].length || (imgs.length || sticker ? 2 : 0) }).affection;
      this._save();
      if (affection) this._reportAffection(affection);
      this.emit('update', this.view());
      ok = true;
      return { ok: true, speciesId: id, turnId, userMessage, message, affection };
    } catch (e) {
      const canceled = e.code === 'ECANCELED' || this._cancelRequested;
      if (!canceled) this.emit('error', e);
      if (!canceled && musicCtx && musicCtx.results.length && userMessage) {
        // the song was made but her answer after it failed: keep and show the song (see chat())
        const music = musicCtx.results;
        const message = this._logAs(id, { role: 'pet', turnId, text: `曲子写好了：${musicNames(music)}，点下面就能听～`, ...(modelKey ? { model: modelKey } : {}), attachments: { music } });
        this._save();
        this.emit('update', this.view());
        ok = true;
        return { ok: true, partial: true, speciesId: id, turnId, userMessage, message };
      }
      const error = canceled ? '已停止' : adminChat.readableError(e);
      const message = userMessage ? this._logAs(id, { role: 'pet', turnId, text: canceled ? partial : '', status: canceled ? 'canceled' : 'error', ...(canceled ? {} : { error }), ...(modelKey ? { model: modelKey } : {}) }) : null;
      this._save();
      trace.set('error', e.code || String(e.message).slice(0, 120));
      return { ok: false, reason: canceled ? 'aborted' : 'error', code: e.code || null, error, speciesId: id, turnId, userMessage, message };
    } finally {
      this.busy = false;
      this._consoleTurn = null;
      if (isCur) this.emit('thinking', false);
      this.emit('chat-log', { speciesId: id });
      trace.end({ ok });
    }
  }

  // ---- 插个嘴 (core/interject.js, docs/interject.md) -------------------------------------------------------
  // Something the owner typed / said / copied that is not addressed to her, from one of the listed sources
  // ('chatDraft' | 'voice' | 'api' | 'clipboard'). → { accepted, reason? }; the judgement comes later (debounce).
  interjectInput(source, text) {
    if (!this.pet) return { accepted: false, reason: 'no-pet' };
    return this.interjector.input(source, text);
  }

  interjectFeedback(decisionId, kind) {
    return this.interjector.feedback(String(decisionId || ''), kind);
  }

  interjectRules() {
    return { rules: this.interjector.listRules() };
  }

  interjectAddRule(rule) {
    return this.interjector.addRule(rule);
  }

  interjectSetRuleDisabled(id, disabled) {
    return this.interjector.setRuleDisabled(String(id || ''), !!disabled);
  }

  interjectClearDecisions() {
    return this.interjector.clearDecisions();
  }

  interjectDeleteRule(id) {
    return this.interjector.deleteRule(String(id || ''));
  }

  interjectDecisions(limit = 50) {
    return { decisions: this.interjector.listDecisions(Number(limit) || 50), status: this.interjector.status() };
  }

  // The decision said yes: one short line in her voice through the usual bubble. The agent writes it (counted
  // against 主动行为's hourly LLM budget like her other unprompted lines); with the budget spent or the turn
  // failing she murmurs an offline line instead. → { ok, text, via } — ok: false when she is busy or gone.
  async _interjectSpeak({ text, source, decisionId }) {
    if (!this.pet || this.busy) return { ok: false, reason: 'busy' };
    const t = this.now();
    const c = this._c();
    const offline = () => interjectLib.OFFLINE_LINES[Math.floor(this.rnd() * interjectLib.OFFLINE_LINES.length)];
    const sayMeta = (shown, via, stream = null, reason = null) => {
      const said = this._say(shown, via === 'llm' ? 'llm' : 'fallback', 'interject', reason, null, null, stream);
      this.emit('interject', { type: 'said', decisionId, text: said, via });
      return { ok: true, text: said, via };
    };
    if (!this.budget.canSpend(t)) return sayMeta(offline(), 'fallback', null, 'hourly LLM budget spent');
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    const stream = this._openStream('interject');
    try {
      this.budget.spend(t);
      await this._ensureReady();
      this._throwIfCanceled();
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt: interjectLib.buildInterjectPrompt(persona.buildStateBlock(c, t, this._promptSettings()), { text, source }) }, stream);
      if (res.topicId) c.topicId = res.topicId;
      const r = sayMeta(this._guard(res.text), 'llm', stream);
      this._closeStream(stream, true, null, r.text);
      return r;
    } catch (e) {
      this._closeStream(stream, false, e.code === 'ECANCELED' ? 'canceled' : 'error');
      if (e.code === 'ECANCELED') return { ok: false, reason: 'canceled' };
      this.emit('error', e);
      return sayMeta(offline(), 'fallback', null, e.message);
    } finally {
      this.busy = false;
      this.emit('thinking', false);
    }
  }

  _fallback(sp, kind) {
    return fallbackLine(sp, kind, this.rnd, this._c(), this.settings);
  }

  // Tell the UI what an interaction scored, and celebrate a stage-up (design 9.3, 9.4).
  _reportAffection(r) {
    if (!r) return;
    this.emit('affection', { type: 'gain', source: r.source, delta: r.delta, blocked: r.blocked, value: r.value });
    if (r.stageUp) setImmediate(() => this._onStageUp(r));
  }

  async _onStageUp(r) {
    const unlocks = {
      topics: dialogue.topicsForStages(r.unlockedStages, this._c(), this.settings),
      outfits: outfits.outfitsForStages(r.unlockedStages, this._c(), this.settings, this._look()),
    };
    this.emit('affection', { type: 'stage-up', stage: r.to, view: this.view(), unlocks });
    await this._speak('stage_up');
  }

  // Start an unlocked topic from the topic panel (design 4, 9.6). Locked or hidden topics are refused
  // here as well, not only greyed out in the UI.
  async talkTopic(id) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const c = this._c();
    const check = dialogue.getTopic(c, this.settings, id);
    if (!check.ok) return check;
    if (this.busy) return { ok: false, reason: 'busy' };
    const topic = check.topic;
    const t = this.now();
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    // a preset prompt picked from the panel: kept with origin 'topic', not shown in 聊天记录
    const turn = this._logUser(`[话题] ${topic.label}`, 'topic', `topic:${topic.id}`);
    const stream = this._openStream(`topic:${topic.id}`, turn);
    try {
      state.touch(c, t);
      await this._ensureReady();
      this._throwIfCanceled();
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt: persona.buildTopicPrompt(topic, c, t, this._promptSettings()) }, stream);
      if (res.topicId) c.topicId = res.topicId;
      const { affection } = state.talkedTopic(c, topic.id, this.now());
      const text = this._guard(res.text);
      this._closeStream(stream, true, null, this._say(text, 'llm', `topic:${topic.id}`, null, null, turn, stream));
      this._reportAffection(affection);
      return { ok: true, text, affection };
    } catch (e) {
      this._closeStream(stream, false, e.code === 'ECANCELED' ? 'canceled' : 'error');
      if (e.code === 'ECANCELED') {
        this._logPet('', `topic:${topic.id}`, turn, 'canceled');
        this._save();
        return { ok: false, reason: 'canceled' };
      }
      this.emit('error', e);
      // An offline line keeps the panel responsive, but it does not score: only a real reply does.
      this._say(topic.fallback[0], 'fallback', `topic:${topic.id}`, e.message, null, turn);
      return { ok: false, reason: 'error', message: e.message };
    } finally {
      this.busy = false;
      this.emit('thinking', false);
    }
  }

  // ---- 18+ confirmation and the adult-content switch (design 8.3, 8.4) ----------------------
  getSettings() {
    return this.settingsView();
  }

  // How character `id` looks in `outfitId`: her own pack is the only source (null: a video character's clips).
  // An old per-persona id means that base's default character. There is no other pack to choose (T-2764).
  lookFor(id, outfitId) {
    const e = C.characterById(this.packs, id) || C.characterById(this.packs, Object.hasOwn(SPECIES, id) ? C.defaultCharacter(this.packs, id, this._adultOk()) : null);
    if (!e) return null;
    return packsLib.resolveLook(this.packs, { packId: e.clips ? C.clipsId(e.base) : e.packId, fallbackId: packsLib.fallbackPack(e.base), speciesId: e.base, outfitId });
  }

  // Every character the roster lists now (core/characters.js), 18+ looks only with adult content on.
  characterList() {
    return C.listCharacters(this.packs, { adultOk: this._adultOk() });
  }

  // 商店 → 角色 (core/catalog.js): every character that can be downloaded, each with `installed` (on this
  // machine now). 18+ ones only with adult content on.
  catalogList() {
    return Catalog.listAll((id) => !!C.characterById(this.packs, id), { adultOk: this._adultOk() });
  }

  // { id, name, sizeLabel } when the saved character waits to be downloaded (see view().pendingDownload)
  _pendingDownload() {
    const want = this.pet && this.pet.characterId;
    if (!want || C.characterById(this.packs, want)) return null;
    const d = Catalog.entry(want);
    if (!d || d.base !== this.pet.speciesId || (d.adult && !this._adultOk())) return null;
    return { id: d.id, name: d.name, sizeLabel: Catalog.sizeLabel(d.bytes) };
  }

  // After packs were imported or removed. An imported pack is a new character (T-2764); when the one she is
  // goes, she becomes her base's default character (her choice is kept in pet.characterId), and visitors that
  // no longer exist go home.
  setPacks(packs) {
    this.packs = packs;
    const visitors = this.settings.visitors.filter((v) => C.characterById(packs, v));
    if (visitors.length !== this.settings.visitors.length) this.setVisitors(visitors);
    if (this.pet) this.emit('update', this.view());
  }

  // Pet size (any scale in PET_SCALE). Kept in settings.json, so it also applies to the next pet.
  setPetScale(value) {
    if (!Number.isFinite(Number(value))) return { ok: false, reason: 'invalid' };
    this.settings = settingsLib.normalizeSettings({ ...this.settings, petScale: settingsLib.clampScale(value), petScaleSet: true });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok: true, settings: this.settingsView() };
  }

  // 外观 → VRM 姿势: the posture a VRM character stands (or sits) in; 'auto' lets the VRM director choose. Keyed
  // by her character id, which is her pack's id.
  setVrmPosture(packId, posture) {
    if (typeof packId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(packId) || !settingsLib.VRM_POSTURES.includes(posture)) return { ok: false, reason: 'invalid' };
    const next = { ...this.settings.vrmPostures };
    if (posture === 'auto') delete next[packId]; else next[packId] = posture;
    this.settings = settingsLib.normalizeSettings({ ...this.settings, vrmPostures: next });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok: true, posture, settings: this.settingsView() };
  }

  // 高级设置 → 桌宠行为: roaming, click sound, voice, memes, collisions (settings.PREFS).
  setPrefs(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...this.settings.prefs };
    for (const k of Object.keys(settingsLib.PREFS)) if (typeof p[k] === typeof settingsLib.PREFS[k]) next[k] = p[k]; // framing: a string, checked by normalizeSettings
    this.settings = settingsLib.normalizeSettings({ ...this.settings, prefs: next });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok: true, settings: this.settingsView() };
  }

  // 高级设置 → 语音: the engine that reads (auto = each character's own / fish / minimax / elevenlabs / local / system), the fallback (system / silent),
  // the endpoints, the local server's API / model / voice and the ElevenLabs default voice / model. API keys go through main.js into tts-keys.json, never into settings.json.
  // voicePackByCharacter: { id: packId | 'auto' } merged into the saved picks ('auto' / null removes hers).
  // voicePack: 我的语音包 — a pack id or 'auto' / null (every character's default when she has no pick of her own).
  setTts(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const mergePicks = (cur, add) => {
      if (!add || typeof add !== 'object' || Array.isArray(add)) return { ...(cur || {}) };
      const next = { ...(cur || {}) };
      for (const [id, v] of Object.entries(add)) if (v === null || v === 'auto') delete next[id]; else next[id] = v;
      return next;
    };
    const cur = this.settings.tts;
    const picked = p.provider !== undefined;
    const next = { provider: picked ? p.provider : cur.provider, providerSet: picked || cur.providerSet, fallback: p.fallback === undefined ? cur.fallback : p.fallback, packs: p.packs === undefined ? cur.packs : p.packs !== false, voicePack: p.voicePack === undefined ? cur.voicePack : p.voicePack === null ? 'auto' : p.voicePack, voicePackByCharacter: mergePicks(cur.voicePackByCharacter, p.voicePackByCharacter), endpoints: { ...cur.endpoints }, local: { ...cur.local, ...(p.local && typeof p.local === 'object' ? p.local : {}) }, elevenlabs: { ...cur.elevenlabs, ...(p.elevenlabs && typeof p.elevenlabs === 'object' ? p.elevenlabs : {}) } };
    let ok = true;
    for (const [id, u] of Object.entries(p.endpoints && typeof p.endpoints === 'object' ? p.endpoints : {})) {
      if (!(id in next.endpoints)) continue;
      const v = String(u || '').trim();
      if (v && !endpointOkFor(id, v)) ok = false;
      else next.endpoints[id] = v;
    }
    this.settings = settingsLib.normalizeSettings({ ...this.settings, tts: next });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok, reason: ok ? undefined : 'bad-endpoint', settings: this.settingsView() };
  }

  // 高级设置 → 语音输入 (core/asr.js): on/off, the engine (lobehub / local / off), falling back to the other one,
  // the language, LobeHub's model and the local server (endpoint, API shape, model, timeout). Its optional key
  // goes through main.js into tts-keys.json, never into settings.json.
  setAsr(patch) {
    const r = asrLib.applyAsrPatch(this.settings.asr, patch);
    this.settings = settingsLib.normalizeSettings({ ...this.settings, asr: r.asr });
    this.settingsStore.save(this.settings);
    if (this.asr) {
      this.asr.reset(); // a new engine, endpoint or model: try every provider again
      if (!asrLib.asrActive(this.settings.asr)) this.asr.cancel();
    }
    this.emit('settings', this.settingsView());
    return { ok: r.ok, reason: r.ok ? undefined : r.errors[0], errors: r.errors, settings: this.settingsView() };
  }

  // What the owner said (the recorder's bytes and mime type) -> text, with the providers of settings.asr.
  // -> { ok: true, text, lang, provider, ms, fellBackFrom } | { ok: false, reason, message, provider, tried }
  async asrTranscribe(bytes, mime, { ms } = {}) {
    if (!this.asr) return { ok: false, reason: 'not-configured', message: 'ASR is not available', provider: null, tried: [] };
    const r = await this.asr.transcribe(bytes, mime, this.settings.asr, { ms });
    // 插个嘴 source 'voice': the transcript (auto-sent ones are dropped again when the chat message arrives)
    if (r && r.ok && r.text) this.interjector.input('voice', r.text);
    return r;
  }

  asrCancel() {
    if (this.asr) this.asr.cancel();
  }

  // 测试连接: a short silent clip to the configured provider(s), or only `provider`; works with ASR switched off too.
  async asrTest({ provider } = {}) {
    if (!this.asr) return { ok: false, reason: 'not-configured', results: [] };
    const only = asrLib.PROVIDER_IDS.includes(provider) ? provider : undefined;
    const set = this.settings.asr.engine === 'off' && !only ? { ...this.settings.asr, engine: 'lobehub' } : this.settings.asr;
    return this.asr.test(set, { only });
  }

  // 同屏伙伴: other model-chan who visit the desktop (no agent of their own; they only play). Characters (an old
  // per-persona id: her default one); never the companion herself in another look, nor one girl twice.
  setVisitors(ids) {
    const own = this.pet ? this.pet.speciesId : null;
    const bases = new Set(own ? [own] : []);
    const list = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const e = C.characterById(this.packs, raw) || (Object.hasOwn(SPECIES, raw) ? C.characterById(this.packs, C.defaultCharacter(this.packs, raw, this._adultOk())) : null);
      if (!e || !C.available(e, this._adultOk()) || bases.has(e.base)) continue;
      bases.add(e.base);
      list.push(e.id);
    }
    this.settings = settingsLib.normalizeSettings({ ...this.settings, visitors: list });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok: true, settings: this.settingsView() };
  }

  // 后台 (admin console) sections without a setter of their own: 主动行为 (proactive), 好感度 (affectionRules),
  // the console's theme (ui), 系统 (system) and 音乐创作 (music, core/music.js). The patch is merged into the section and normalised by
  // settings.js like everything else; out-of-range values fall back to the default there.
  setSection(name, patch) {
    if (!['proactive', 'interject', 'affectionRules', 'ui', 'system', 'update', 'music', 'scene', 'wallpaper'].includes(name)) return { ok: false, reason: 'unknown-section' };
    const p = patch && typeof patch === 'object' ? patch : {};
    const merged = { ...this.settings[name], ...p };
    // interject.sources is the one nested object: a patch of one source keeps the others
    if (name === 'interject' && p.sources && typeof p.sources === 'object') merged.sources = { ...this.settings.interject.sources, ...p.sources };
    // music.fal / music.elevenlabs (T-5651) are nested too: a patch of one field keeps the others
    if (name === 'music') for (const sub of ['fal', 'elevenlabs']) if (p[sub] && typeof p[sub] === 'object') merged[sub] = { ...this.settings.music[sub], ...p[sub] };
    this.settings = settingsLib.normalizeSettings({ ...this.settings, [name]: merged });
    if (name === 'interject' && !this.settings.interject.enabled) this.interjector.cancel();
    this.settingsStore.save(this.settings);
    this._applyRules();
    this.emit('settings', this.settingsView());
    return { ok: true, settings: this.settingsView() };
  }

  // 对外接口 (local HTTP API): off by default; switching it on creates a random token if there is none.
  setApi({ enabled, port, newToken = false } = {}, makeToken = () => require('node:crypto').randomBytes(24).toString('base64url')) {
    const cur = this.settings.api;
    const token = newToken || !cur.token ? makeToken() : cur.token;
    this.settings = settingsLib.normalizeSettings({ ...this.settings, api: { enabled: enabled === undefined ? cur.enabled : !!enabled, port: port === undefined ? cur.port : Number(port), token } });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok: true, settings: this.settingsView() };
  }

  // A line sent through the local API (no LLM call): shown, and read aloud with voice on.
  sayExternal(text) {
    const t = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!this.pet || !t) return { ok: false, reason: this.pet ? 'empty' : 'no-pet' };
    this._say(t, 'api', 'api');
    return { ok: true };
  }

  answerAgeGate(isAdult) {
    this.settings = settingsLib.answerAgeGate(this.settings, !!isAdult, this.now());
    this.settingsStore.save(this.settings);
    const outfitChanged = this._applySettings();
    return { ok: true, settings: this.settingsView(), outfitChanged, view: this.view() };
  }

  // After a settings change: an adult outfit that may no longer be shown is swapped for the last
  // all-ages one (design 8.4), then everything is saved and the UI refreshed.
  _applySettings() {
    if (!this.pet) {
      this.emit('settings', this.settingsView());
      return null;
    }
    const r = this._enforce();
    this._save();
    return r.changed ? { from: r.from, to: r.to } : null;
  }

  setAdultContent(on) {
    const r = settingsLib.setAdultContent(this.settings, !!on);
    if (!r.ok) return { ok: false, reason: r.reason, settings: this.settingsView() };
    this.settings = r.settings;
    this.settingsStore.save(this.settings);
    const outfitChanged = this._applySettings();
    return { ok: true, settings: this.settingsView(), outfitChanged, view: this.view() };
  }

  // ---- wardrobe (design 5, 9.5) ---------------------------------------------------------------
  // Only an unlocked outfit the user may see can be put on; the choice is saved with the pet.
  // `characterId` (her page in the settings window, T-2784): put it on another character met before — saved
  // in her own wardrobe, worn the next time she is with you; none = the current character.
  equipOutfit(id, characterId) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    // her own wardrobe (T-2764): the outfit is saved for that character, not for her other looks
    const cid = characterId ? this._charOf(characterId) : this._cid();
    if (!cid) return { ok: false, reason: 'unknown' };
    const w = this._wearer(cid);
    if (!w) return { ok: false, reason: 'not-met' };
    const r = outfits.equipOutfit(w, this.settings, String(id || ''), this._look(cid));
    if (!r.ok) return r;
    this._keepWardrobe(cid, w);
    this._save();
    return { ok: true, outfit: r.outfit, view: this.view() };
  }

  // 衣柜 of character `id` (her page in the settings window, T-2784): her outfits as view().outfits lists the
  // current one's — what she may wear, locked or not, which one she has on. null: her base not met yet.
  outfitsOf(id) {
    if (!this.pet) return null;
    const cid = this._charOf(id);
    const base = cid && this._baseOf(cid);
    const e = base && this.pet.characters[base];
    if (!e) return null;
    const w = { speciesId: base, ...this._wearer(cid, e) };
    const look = this._look(cid);
    return outfits.listOutfits(w, this.settings, look).map((o) => ({ ...o, look: packsLib.lockedLook(this.lookFor(cid, o.id), o.locked) }));
  }

  // The user opened the wardrobe or topic panel: its unlocked items are no longer "new".
  // `characterId`: whose 衣柜 (her page in the settings window, T-2784); none = the current character.
  markSeen(kind, characterId) {
    if (!this.pet || !['outfit', 'topic'].includes(kind)) return { ok: false };
    const cid = characterId ? this._charOf(characterId) : this._cid();
    const c = cid && this.pet.characters[this._baseOf(cid)];
    if (!c) return { ok: false };
    const list = kind === 'outfit' ? outfits.listOutfits({ speciesId: this._baseOf(cid), ...this._wearer(cid, c) }, this.settings, this._look(cid)) : dialogue.listTopics(c, this.settings);
    const ids = list.filter((x) => x.isNew).map((x) => `${kind}:${x.id}`);
    if (ids.length) {
      c.seenUnlocks = [...(c.seenUnlocks || []), ...ids];
      this._save();
    }
    return { ok: true, marked: ids.length };
  }

  // Care actions: instant, deterministic, no LLM cost (reaction line is canned).
  act(kind, food) {
    if (!this.pet) return { ok: false };
    if (this.busy) return { ok: false, reason: 'busy' }; // no side actions while the pet is working
    const t = this.now();
    const c = this._c();
    const sp = getSpecies(c.speciesId);
    let r;
    if (kind === 'feed') r = state.feed(c, food, t);
    else if (kind === 'pat') r = state.pat(c, t);
    else if (kind === 'play') r = state.play(c, t);
    else if (kind === 'sleep') r = state.putToSleep(c, t);
    else if (kind === 'touch') return this.touch(food); // act('touch', zone | { x, y })
    else return { ok: false };

    let line = null;
    if (kind === 'sleep') line = sp.fallback.sleepy[0];
    else if (r.reason === 'full') line = FULL_LINE;
    else if (r.reason === 'tired') line = TIRED_LINE;
    else if (r.ok) line = this._fallback(sp, { feed: 'fed', pat: 'patted', play: 'played' }[kind]);
    if (line) this._say(line, 'fallback', kind);
    else this._save();
    this._reportAffection(r.affection);
    return r;
  }

  // 重置姿势 (T-2830): asleep, she wakes up (no affection lost, no line); the pose itself is the pet window's
  // (main.js resetPose). Allowed while busy: it changes nothing of the chat. → { ok, woke }
  resetPose() {
    if (!this.pet) return { ok: false, woke: false };
    const woke = resetWake.wakeForReset(this._c(), this.now());
    if (woke) this._save();
    return { ok: true, woke };
  }

  // Touch one body part: instant, offline, no LLM cost. `target` is a zone id ('head', 'chest', …) or
  // the click point in the sprite's visible box, { x, y } in 0..1 (+ `pose`, and `opaque: false` for a
  // transparent pixel), resolved with the character's zone table. No target = the head, like a pat.
  // Returns { ok, zone, reaction, line, affection, woken }; a point on no body part is
  // { ok: false, reason: 'miss', zone: null } and changes nothing.
  // 小游戏 (docs/mini-games.md §6): one of today's quests was done in a game → affection (source `game`, at most
  // three a day) and her line for it. Returns the affection result.
  gameQuest(title) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const c = this._c();
    // scored the way core/pet-state.js score() does (that file stays as it is, test/vrm-pack-style.test.js)
    const r = gainAffection(c, 'game', this.now());
    if (r.unlockedStages.length) c.unlockedTopics = dialogue.unlockedTopicIds(c.peakStage);
    this._save();
    this._reportAffection(r);
    return { ok: true, title: String(title || ''), affection: r };
  }

  // 像素房间 (docs/her-room-design.md §2.1, §3.2): her three numbers the room shows and moves — 精力, 心情 and 饱腹
  // (100 − hunger) of her base. The room's 专注 is the game's own (src/main/games.js).
  roomStats() {
    if (!this.pet) return null;
    const c = this._c();
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);
    return { base: this.pet.speciesId, energy: n(c.energy, 50), mood: n(c.mood, 50), fullness: 100 - n(c.hunger, 50) };
  }

  // 像素房间: how each room's character looks (her pack's daily outfit, for the room picker's avatars), and the
  // room's owner in the outfit her room asks for (`theme.outfit`) — only in her own room; without that outfit in
  // her pack she looks as she does now
  roomLooks(themes = []) {
    if (!this.pet) return { characters: {}, looks: {} };
    const base = this.pet.speciesId;
    const cid = this._cid();
    const characters = {};
    const looks = {};
    for (const t of themes) {
      if (!t || !Object.hasOwn(SPECIES, t.character)) continue;
      if (!characters[t.character]) characters[t.character] = { id: t.character, name: SPECIES[t.character].nameZh, look: this.lookFor(t.character, outfits.DEFAULT_OUTFIT) };
      if (t.status === 'open' && t.character === base && typeof t.outfit === 'string') {
        const has = outfits.listOutfits(this._wearer(cid), this.settings, this._look(cid)).some((o) => o.id === t.outfit && !o.locked);
        looks[t.id] = has ? this.lookFor(cid, t.outfit) : null;
      }
    }
    return { characters, looks };
  }

  // a room activity was settled (main worked it out, core/room-play.js): only energy, mood and hunger change,
  // held to 0–100. Her sleep state on the desktop is not touched — sleeping in the room does not put her to sleep
  // there. Saved and pushed (`update`), so her panel and the settings window show the new numbers at once.
  roomSettle({ energy, mood, fullness } = {}) {
    if (!this.pet) return null;
    const c = this._c();
    const cl = (v) => Math.max(0, Math.min(100, Math.round(v)));
    if (Number.isFinite(energy)) c.energy = cl(energy);
    if (Number.isFinite(mood)) c.mood = cl(mood);
    if (Number.isFinite(fullness)) c.hunger = cl(100 - fullness);
    c.lastInteractionAt = this.now();
    this._save();
    return this.roomStats();
  }

  touch(target) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    const sp = getSpecies(this.pet.speciesId);
    let zone = 'head';
    if (typeof target === 'string' && target) zone = target;
    else if (target && typeof target === 'object' && typeof target.zone === 'string') zone = target.zone;
    else if (target && typeof target === 'object' && ('x' in target || 'y' in target)) {
      zone = touchZones.zoneAt(Number(target.x), Number(target.y), { character: sp, pose: target.pose || null, opaque: target.opaque !== false });
      if (!zone) return { ok: false, reason: 'miss', zone: null };
    }
    if (!touchZones.ZONE_IDS.includes(zone)) return { ok: false, reason: 'unknown-zone', zone };
    const t = this.now();
    const c = this._c();
    const r = state.touchBody(c, zone, t);
    const line = touchZones.touchLine(sp, r.reaction, { settings: this.settings, rnd: this.rnd, last: this._lastTouchLine });
    this._lastTouchLine = line;
    this._say(line, 'fallback', `touch:${zone}`, null, InteractionVoice.touchMood(r.reaction.mood));
    this._reportAffection(r.affection);
    const a = r.affection;
    const affection = { source: a ? a.source : null, delta: a ? a.delta : 0, blocked: a ? a.blocked : null, value: c.affection, stage: c.relStage };
    return { ok: true, zone, reaction: r.reaction, line, affection, woken: r.woken };
  }

  // 互动语音: the short lines her interactions may say right now (her stage, her character), each with
  // the mood it is read in, for main.js to synthesise ahead into the voice cache. Touch lines are the
  // first touch of each part; a streak or an LLM line (met, stage_up) is synthesised when it happens.
  voiceLines() {
    if (!this.pet) return [];
    const sp = getSpecies(this.pet.speciesId);
    const out = [];
    const add = (text, mood) => { const t = Voice.speakable(text); if (t && !out.some((x) => x.text === t && x.mood === mood)) out.push({ text: t, mood }); };
    const M = InteractionVoice.MOOD;
    // the most common first: the care actions and the drag lines, then every part she has
    for (const [act, kind] of [['pat', 'patted'], ['feed', 'fed'], ['play', 'played']]) for (const l of fallbackPool(sp, kind, this._c(), this.settings)) add(l, M[act]);
    add(sp.fallback.sleepy[0], M.sleep);
    add(FULL_LINE, M.feed);
    add(TIRED_LINE, M.play);
    for (const k of InteractionVoice.LOCAL) for (const l of InteractionVoice.localLines(sp, k)) add(l, M[k]);
    const zones = this.settings.prefs.touchZones === false ? [] : touchZones.zonesFor(sp, null).map((z) => z.id);
    for (const zone of zones.filter((z) => touchZones.ZONES[z])) {
      const reaction = touchZones.reactionFor(zone, this._c().relStage, 1);
      for (const l of touchZones.touchLines(sp, reaction, this.settings)) add(l, InteractionVoice.touchMood(reaction.mood));
    }
    return out.slice(0, PREWARM_MAX);
  }

  // Called on a timer. Advances needs and maybe lets the pet speak up.
  async heartbeat() {
    if (!this.pet) return;
    const t = this.now();
    const c = this._c();
    const { events, decay } = resetWake.tick(c, t);
    this._save();
    const lost = decay + (this._pendingDecay || 0);
    this._pendingDecay = 0;
    if (lost > 0) this.emit('affection', { type: 'decay', delta: -lost, value: c.affection });
    if (events.includes('woke')) this.emit('say', { text: '哈——睡饱啦。', source: 'fallback', kind: 'woke', origin: this._logPet('哈——睡饱啦。', 'woke') });
    this._sayRetiredNotice();
    this.interjector.tick(); // 插个嘴: a remark nobody reacted to counts as ignored
    // 主动行为 off: she still lives (needs, decay, waking up) but never speaks up on her own
    const pro = this.settings.proactive;
    if (!pro.enabled) return;
    const kind = lost > 0 ? 'missed' : nextEvent(c, t, pro, this.rnd);
    if (kind) await this._speak(kind);
  }

  // Test hook (PIXELPET_TEST only): force pet fields (owner-level ones on the save, the rest on the current
  // character). Forcing `affection` re-derives the stages the same way real scoring would, including the
  // stage-up event.
  debugSet(patch) {
    if (!this.pet) return null;
    const { affection, ...rest } = patch || {};
    const c = this._c();
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'speciesId' || k === 'characters') continue;
      if (SHARED_KEYS.includes(k) && k !== 'createdAt') this.pet[k] = v;
      else c[k] = v;
      // the outfit is per character (T-2764): forcing it dresses the current one
      if (k === 'equippedOutfit' || k === 'lastSafeOutfit') { const w = this._wearer(this._cid(), c); w[k] = v; this._keepWardrobe(this._cid(), w); }
    }
    if (typeof affection === 'number') {
      const r = state.setAffectionForTest(c, affection);
      if (r.stageUp) setImmediate(() => this._onStageUp(r));
    }
    this._save();
    return this.view();
  }

  // ⋯ → 角色列表 → her page → 好感度: unlock every stage, topic and outfit of `speciesId` (default: the
  // current character) at once (for impatient players and for checking the content). Only a character met
  // before has affection to fill. Returns what became available, as the user may see it; only the current
  // companion announces her stage-up (another one is not on the desktop to say it).
  unlockAll(speciesId) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const id = this._target(speciesId);
    if (!id) return { ok: false, reason: 'unknown-character' };
    const c = Object.hasOwn(this.pet.characters, id) ? this.pet.characters[id] : null;
    if (!c) return { ok: false, reason: 'not-met' };
    const isCurrent = id === this.pet.speciesId;
    if (isCurrent && this.busy) return { ok: false, reason: 'busy' };
    const r = state.unlockAll(c, this.now());
    const unlocks = {
      topics: dialogue.topicsForStages(r.unlockedStages, c, this.settings),
      outfits: outfits.outfitsForStages(r.unlockedStages, c, this.settings, this._look(this._charOf(speciesId))),
    };
    this._save();
    if (isCurrent && r.unlockedStages.length) setImmediate(() => this._onStageUp(r));
    return { ok: true, view: this.view(), unlocks, already: r.unlockedStages.length === 0, speciesId: id };
  }

  // ⋯ → 重新开始: the current character continues in a fresh LobeHub topic. Nothing is deleted: the old
  // topic stays in LobeHub (its id is kept in `pastTopicIds`), and her agent, affection and 聊天记录 stay
  // as they are. The next run goes without `-t`, so LobeHub opens the new topic itself.
  newTopic() {
    if (!this.pet) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    const c = this._c();
    const previous = c.topicId || null;
    if (previous) c.pastTopicIds = [...(Array.isArray(c.pastTopicIds) ? c.pastTopicIds : []), previous].slice(-50);
    c.topicId = null;
    c.topicEpoch = (c.topicEpoch || 0) + 1;
    this._save();
    return { ok: true, previous, view: this.view() };
  }

  // Release the pet: optionally delete every character's LobeHub agent as well. `deleted`: how many were.
  async release({ deleteAgent = false } = {}) {
    if (!this.pet) return { ok: true };
    let deleted = 0;
    if (deleteAgent) {
      const ids = [...Object.values(this.pet.characters), ...Object.values(this.pet.retiredCharacters || {})].map((c) => c && c.agentId).filter(Boolean);
      for (const id of new Set(ids)) if (await this.lh.deleteAgent(id)) deleted += 1;
    }
    this.pet = null;
    this.lh.setWorkspace(null);
    this.store.clear();
    this.log.clear(); // 聊天记录 goes with the pet
    this.emit('update', null);
    return { ok: true, deleted };
  }
}

module.exports = { PetService };
