'use strict';

const { EventEmitter } = require('node:events');
const state = require('../core/pet-state');
const persona = require('../core/persona');
const { adultAllowed, stageName } = require('../core/affection');
const dialogue = require('../core/dialogue');
const outfits = require('../core/outfits');
const { migratePet, SHARED_KEYS } = require('../core/migrate');
const settingsLib = require('../core/settings');
const { getSpecies, SPECIES } = require('../core/species');
const packsLib = require('../core/packs');
const modelsLib = require('../core/models');
const path = require('node:path');
const contentGuard = require('../core/content-guard');
const { nextEvent, LlmBudget, fallbackLine, fallbackPool } = require('../core/proactive');
const memes = require('../core/memes');
const touchZones = require('../core/touch-zones');
const { endpointOkFor } = require('../core/tts');
const Voice = require('../core/voice');
const InteractionVoice = require('../core/interaction-voice');
const chatLog = require('../core/chat-log');
const cur = state.cur;
const { ensureLocalDevice, bindConfig, unbindConfig, LOCAL_TOOLS } = require('../core/local-device');

const LOCAL_RECHECK_MS = 6 * 60 * 60 * 1000; // re-confirm the device binding a few times a day
const LOCAL_RETRY_MS = 5 * 60 * 1000; // after a failure, do not hammer `lh` on every message
const MODELS_TTL_MS = 10 * 60 * 1000; // how long the list of the user's models is reused
// Offline lines that may come with a random meme picture (the pet's own murmurs, not app notes).
const FULL_LINE = '呃……肚子圆滚滚的，吃不下了。';
const TIRED_LINE = '好累……让我睡一会儿。';
const PREWARM_MAX = 60; // lines synthesised ahead per character (互动语音)
const MEME_KINDS = ['hungry', 'bored', 'greet_morning', 'greet_evening', 'met', 'missed', 'stage_up', 'fed', 'patted', 'played', 'woke', 'switch'];

// Owns the pet's lifecycle. Electron-free so it can be tested with a fake `lh`.
// `this.pet` is the whole save (schema 3): owner-level fields plus one entry per character met
// (`pet.characters[id]`, her own agent, topic, name, affection and needs); `this._c()` is the current one.
class PetService extends EventEmitter {
  constructor({ lh, responses = null, store, settingsStore = new settingsLib.MemorySettingsStore(), now = () => Date.now(), rnd = Math.random, budget = new LlmBudget(), packs = null, ttsStatus = null, log = new chatLog.MemoryChatLog() }) {
    super();
    this.log = log; // 聊天记录 (core/chat-log.js): every message with its origin
    // pet packs (how the companions look); by default only the built-in ones
    this.packs = packs || packsLib.loadPacks([{ dir: path.join(__dirname, '..', 'renderer', 'packs'), source: 'builtin' }]).packs;
    this.lh = lh;
    // the direct path for turns that use this computer (core/responses-client.js); null: always `lh connect`
    this.responses = responses;
    this._responsesFailedAt = 0;
    this.ttsStatus = ttsStatus; // 语音: whether each engine has a key and its last error (main.js; never the keys)
    this.store = store;
    this.settingsStore = settingsStore;
    this.settings = settingsStore.load();
    this.now = now;
    this.rnd = rnd;
    this.budget = budget;
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
  }

  _c() {
    return cur(this.pet);
  }

  // Load the save; a growth-system save (xp / stage) is backed up once and migrated (design 6).
  init() {
    const t = this.now();
    this.settings = this.settingsStore.load();
    const raw = this.store.load();
    const { pet, migrated, from, remapped } = migratePet(raw, t);
    if (migrated) this.store.backupOnce(`pet.v${from}.bak.json`);
    if (remapped) this.store.backupOnce('pet.retired.bak.json');
    this.pet = pet;
    // looks chosen for characters that no longer exist are dropped
    const ap = this.settings.appearance || {};
    if (Object.keys(ap).some((k) => !SPECIES[k])) {
      this.settings = settingsLib.normalizeSettings({ ...this.settings, appearance: Object.fromEntries(Object.entries(ap).filter(([k]) => SPECIES[k])) });
      this.settingsStore.save(this.settings);
    }
    // told once, on the first heartbeat / warmup: who took over a retired character
    this._retiredNotice = remapped && pet ? { from: remapped, to: pet.speciesId } : null;
    // A pet's agent is reached in the space it was created in (no `space`: an older save, lh's default).
    this.lh.setWorkspace(this.pet && this.pet.space ? this.pet.space.workspaceId : this.pet ? undefined : null);
    if (this.pet) {
      // only the current character lives on while the app is closed; the others stay where they were
      const { decay } = state.tick(this._c(), t);
      // The settings may have changed while the app was closed (e.g. a re-asked age gate).
      const { changed } = outfits.enforceOutfit(this._c(), this.settings, this._look(this.pet.speciesId));
      if (migrated || remapped || decay > 0 || changed) this.store.save(this.pet);
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

  // The wardrobe context of the look `speciesId` wears: { adult, outfits } when it is an 18+ pack (its
  // outfits, adult ones included, replace her file's list), else null.
  _look(speciesId) {
    const p = this.packs.get(packsLib.chosenPack(this.packs, this.settings.appearance, speciesId, this._adultOk()));
    return p && p.adult ? { adult: true, outfits: Object.keys(p.outfits) } : null;
  }

  // Settings as the UI needs them: whether to show the age gate, and whether adult content is on.
  settingsView() {
    return { ...this.settings, needsAgeGate: settingsLib.needsAgeGate(this.settings), petScaleRange: settingsLib.PET_SCALE, systemRoleMax: settingsLib.SYSTEM_ROLE_MAX, ttsStatus: this.ttsStatus ? this.ttsStatus() : null };
  }

  // `pet` is the current character as one flat object (owner-level fields + her entry), as before schema 3.
  // `characters` lists the roster with who has been met, under which name, and her affection, plus what
  // ⋯ → 角色列表 → her page configures for her: her look (thumbnail), pack, model and affection progress.
  view() {
    if (!this.pet) return null;
    const c = this._c();
    const sp = getSpecies(this.pet.speciesId);
    const { characters, retiredCharacters, ...shared } = this.pet;
    const adult = this._adult();
    return {
      pet: { ...shared, ...c },
      status: state.currentStatus(c),
      affection: state.toAffectionProgress(c, { adult }),
      topics: dialogue.listTopics(c, this.settings),
      outfits: outfits.listOutfits(c, this.settings, this._look(this.pet.speciesId)).map((o) => ({ ...o, look: this.lookFor(this.pet.speciesId, o.id) })),
      outfit: outfits.wornOutfit(c, this.settings, this._look(this.pet.speciesId)),
      look: this.lookFor(this.pet.speciesId, outfits.wornOutfit(c, this.settings, this._look(this.pet.speciesId))),
      appearance: this.appearanceView(this.pet.speciesId),
      model: this.modelView(),
      settings: this.settingsView(),
      species: { id: sp.id, name: sp.name, nameZh: sp.nameZh, vendor: sp.vendor, title: sp.title, accent: sp.accent },
      characters: Object.values(SPECIES).map((x) => {
        const e = characters[x.id];
        const ad = adultAllowed(this.settings, x.id);
        const met = e ? { name: e.name, affection: e.affection, stage: stageName(e.relStage, ad), progress: state.toAffectionProgress(e, { adult: ad }) } : null;
        return {
          id: x.id, nameZh: x.nameZh, vendor: x.vendor, title: x.title, accent: x.accent, current: x.id === sp.id, met,
          look: this.lookFor(x.id, e ? outfits.wornOutfit(e, this.settings, this._look(x.id)) : outfits.DEFAULT_OUTFIT),
          appearance: this.appearanceView(x.id),
          model: this.modelView(x.id),
          systemRole: this.settings.systemRoles[x.id] || '',
        };
      }),
      space: this.pet.space ? { personal: !this.pet.space.workspaceId, name: this.pet.space.name } : null,
      busy: this.busy,
      local: { enabled: !!this.pet.localAbilities, ok: this._localOk, error: this.localError, warning: this.localWarning },
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

  // A line for the bubble. The agent may have tagged a meme picture ([梗图:id], core/memes.js): the tag
  // never reaches the bubble; with memes on, the picture goes with the line (an offline murmur gets a
  // random one now and then).
  // `turn`: the owner's round this line answers ({ origin, turnId }, from _logUser); without one the
  // line is the pet's own and its origin comes from `kind` (greeting, proactive, touch, …).
  _say(text, source, kind, reason = null, voiceMood = null, turn = null) {
    if (this.pet) this._c().lastSpokeAt = this.now();
    const sp = this.pet ? getSpecies(this.pet.speciesId) : null;
    const ex = memes.extractMeme(text, sp);
    const origin = this._logPet(ex.text || text, kind, turn);
    let meme = null;
    if (sp && this.settings.prefs.memes) meme = ex.meme || (source === 'fallback' && MEME_KINDS.includes(kind) ? memes.randomMeme(sp, this.rnd) : null);
    const m = meme && sp.memes.find((x) => x.id === meme);
    this.emit('say', { text: ex.text || text, source, kind, reason, meme: m ? { id: m.id, label: m.label, url: memes.memeUrl(sp.id, m.id) } : null, speciesId: sp ? sp.id : null, origin, ...(voiceMood !== null ? { voiceMood } : {}) });
    if (this.pet) this._save();
  }

  // ---- 聊天记录 (core/chat-log.js) ----------------------------------------------------------------
  // The owner's message opens a round; her reply (or the note that none came) closes it with the same turnId.
  _logUser(text, origin, kind, attachments = null) {
    const turnId = `t${this.now().toString(36)}${Math.floor(this.rnd() * 1e6).toString(36)}`;
    const a = attachments && (attachments.images || (attachments.files && attachments.files.length)) ? { attachments } : {};
    try {
      this.log.append({ speciesId: this.pet.speciesId, role: 'user', origin, kind, turnId, text, ...a }, this.now());
    } catch (e) {
      this.emit('error', e);
    }
    return { origin, turnId };
  }

  _logPet(text, kind, turn = null, status = null) {
    const origin = turn ? turn.origin : chatLog.originOfKind(kind);
    if (!this.pet) return origin;
    try {
      this.log.append({ speciesId: this.pet.speciesId, role: 'pet', origin, kind, turnId: turn ? turn.turnId : `s${this.now().toString(36)}${Math.floor(this.rnd() * 1e6).toString(36)}`, text: String(text || ''), ...(status ? { status } : {}) }, this.now());
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
    const pick = ({ id: mid, at, role, text, attachments, status }) => ({ id: mid, at, role, text, ...(attachments ? { attachments } : {}), ...(status ? { status } : {}) });
    return { ok: true, session: { ...s, name: this._nameOf(s.speciesId), messages: s.messages.map(pick) } };
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
  async hatch({ speciesId, name, localAbilities = false, space = null, onStep = () => {}, onLoginPrompt = () => {} }) {
    if (this.pet) throw new Error('A pet already exists');
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
    this.pet = state.createSave(first, this.now());
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
  async _ensureReady() {
    while (this._readying) await this._readying.catch(() => {});
    this._readying = this._doEnsureReady();
    try {
      await this._readying;
    } finally {
      this._readying = null;
    }
  }

  async _doEnsureReady() {
    const p = this._c();
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
    // the model follows the character: her pick or default among her own vendor's models
    try {
      await this.refreshModels();
      await this._applyModel();
    } catch (e) {
      this.emit('error', e); // keep the agent's current model; retried on the next turn
    }
    if (this.pet.localAbilities) await this._verifyLocal();
  }

  // ---- the model (⋯ → 角色列表 → her page → 模型) ----------------------------------------------------------
  // The user's enabled chat models, from the hosted provider and the roster's vendor providers. Cached for
  // MODELS_TTL_MS; `force` reloads (the panel's 刷新). A failure (an older lh, offline) keeps the previous
  // list, or none, and is not retried before the TTL either; the agent then keeps the model it has.
  async refreshModels({ force = false } = {}) {
    if (!force && this._catalogAt && this.now() - this._catalogAt < MODELS_TTL_MS) return this._catalog;
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

  // The packs a character can wear and the one she wears (settings.appearance[id], or her default).
  appearanceView(speciesId) {
    return { packId: packsLib.chosenPack(this.packs, this.settings.appearance, speciesId, this._adultOk()), options: packsLib.packsFor(this.packs, speciesId, this._adultOk()) };
  }

  // The character a per-character setting is for: `speciesId` when given, else the current one.
  _target(speciesId) {
    if (speciesId === undefined || speciesId === null || speciesId === '') return this.pet.speciesId;
    return typeof speciesId === 'string' && Object.hasOwn(SPECIES, speciesId) ? speciesId : null;
  }

  // Point the agent at the model the current character should run on, once per change.
  async _applyModel() {
    if (!this.pet || !this._catalog) return;
    const c = this._c();
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
  async switchCharacter(speciesId, { name } = {}) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    if (!SPECIES[speciesId]) return { ok: false, reason: 'unknown' };
    if (speciesId === this.pet.speciesId) return { ok: true, view: this.view(), same: true };
    const from = this.pet.speciesId;
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
    state.tick(this._c(), this.now());
    this.pet.speciesId = speciesId;
    outfits.enforceOutfit(next, this.settings, this._look(speciesId));
    // she cannot visit herself: the new companion leaves the visitors (同屏伙伴)
    if (this.settings.visitors.includes(speciesId)) this.setVisitors(this.settings.visitors.filter((v) => v !== speciesId));
    if (created) {
      this._save();
      if (this.pet.localAbilities) await this._verifyLocal({ force: true });
      await this._speak('met');
    } else this._say(sp.fallback.greet[0], 'fallback', 'switch');
    return { ok: true, view: this.view(), from, created };
  }

  _tools() {
    return this.pet.localAbilities && this._localOk ? LOCAL_TOOLS : [];
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

  // One agent turn. A turn that may use this computer goes the direct way when it is up; if that fails before
  // any of her tools ran, the same turn is sent again through `lh connect` (a tool that already ran must not
  // run twice, so then the error stands).
  async _runTurn(args) {
    const tools = this._tools();
    if (!tools.length || this.localVia !== 'direct') return this.lh.run({ ...args, tools, device: this._device() });
    try {
      return await this.responses.run({ ...args, tools });
    } catch (e) {
      if (e.code === 'ECANCELED' || e.code === 'ETIMEDOUT' || e.toolsRan) throw e;
      this.emit('error', e);
      this._responsesFailedAt = this.now();
      await this._verifyLocal({ force: true });
      this._throwIfCanceled();
      if (this._localOk) this.localWarning = `直连 LobeHub 失败，这次改用 lh connect（${String(e.message).slice(0, 80)}）`;
      return this.lh.run({ ...args, tools: this._tools(), device: this._device() });
    }
  }

  // Ask the agent to say something for a system-triggered event.
  async _speak(kind) {
    const t = this.now();
    const c = this._c();
    const sp = getSpecies(c.speciesId);
    if (this.busy || !this.budget.canSpend(t)) {
      this._say(this._fallback(sp, kind), 'fallback', kind, this.busy ? 'agent busy' : 'hourly LLM budget spent');
      return;
    }
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    try {
      this.budget.spend(t);
      await this._ensureReady();
      this._throwIfCanceled();
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt: persona.buildEventPrompt(kind, c, t, this.settings) });
      if (res.topicId) c.topicId = res.topicId;
      if (kind === 'greet_morning' || kind === 'greet_evening') c.lastGreetDay = new Date(t).toDateString();
      this._say(this._guard(res.text), 'llm', kind);
    } catch (e) {
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

  // `images`: local picture files to upload so the model can see them (pasted screenshots).
  // `files`: paths of dropped files/folders; they are NOT uploaded: the agent reads them with her local
  // tools (run here, or through the bound device), so local abilities must be on.
  // `origin`: 'user' for the chat box; the local HTTP API passes 'api' (an outside script, not the owner).
  async chat(text, images = [], files = [], { origin = 'user' } = {}) {
    const clean = String(text || '').trim();
    const paths = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f).slice(0, 10);
    if (!this.pet || (!clean && images.length === 0 && paths.length === 0)) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    if (paths.length && !this.pet.localAbilities) return { ok: false, reason: 'local-off' };
    const t = this.now();
    const c = this._c();
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    const turn = this._logUser(clean, origin === 'api' ? 'api' : 'user', 'chat', { images: images.length, files: paths.map((f) => path.basename(f)) });
    try {
      state.touch(c, t);
      await this._ensureReady();
      this._throwIfCanceled();
      if (paths.length && !this._localOk) {
        this._logPet('', 'chat', turn, 'error');
        return { ok: false, reason: 'local-error', message: this.localError };
      }
      const local = this._tools().length > 0;
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
      const prompt = persona.buildChatPrompt(body, c, t, { local, settings: this.settings });
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt });
      if (res.topicId) c.topicId = res.topicId;
      const { affection } = state.chatted(c, this.now(), { textLength: [...clean].length || (images.length || paths.length ? 2 : 0) });
      const text = this._guard(res.text);
      this._say(text, 'llm', 'chat', null, null, turn);
      this._reportAffection(affection);
      return { ok: true, text, cost: res.cost, affection };
    } catch (e) {
      if (e.code !== 'ECANCELED') this.emit('error', e);
      this._logPet('', 'chat', turn, e.code === 'ECANCELED' ? 'canceled' : 'error');
      this._save(); // touch() above may have woken the pet; keep the sprite in sync
      if (e.code === 'ECANCELED') return { ok: false, reason: 'canceled' };
      return { ok: false, reason: 'error', code: e.code || null, message: e.message };
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
      outfits: outfits.outfitsForStages(r.unlockedStages, this._c(), this.settings, this._look(this.pet.speciesId)),
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
    try {
      state.touch(c, t);
      await this._ensureReady();
      this._throwIfCanceled();
      const res = await this._runTurn({ agentId: c.agentId, topicId: c.topicId, prompt: persona.buildTopicPrompt(topic, c, t, this.settings) });
      if (res.topicId) c.topicId = res.topicId;
      const { affection } = state.talkedTopic(c, topic.id, this.now());
      const text = this._guard(res.text);
      this._say(text, 'llm', `topic:${topic.id}`, null, null, turn);
      this._reportAffection(affection);
      return { ok: true, text, affection };
    } catch (e) {
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

  // How `speciesId` looks in `outfitId` with its chosen pack (null: Dafeiyu's signature clips).
  lookFor(speciesId, outfitId) {
    return packsLib.resolveLook(this.packs, { packId: packsLib.chosenPack(this.packs, this.settings.appearance, speciesId, this._adultOk()), fallbackId: packsLib.fallbackPack(speciesId), speciesId, outfitId });
  }

  // ⋯ → 角色列表 → her page → 外观: dress `speciesId` (default: the current companion) in another pack of
  // her species, kept in settings.appearance[speciesId].
  setAppearance(packId, speciesId) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const id = this._target(speciesId);
    if (!id) return { ok: false, reason: 'unknown-character' };
    const p = this.packs.get(packId);
    const clips = packId === packsLib.clipsId(id);
    if (!clips && (!p || p.species !== id)) return { ok: false, reason: 'unknown' };
    if (p && p.adult && !this._adultOk()) return { ok: false, reason: 'adult' };
    this.settings = settingsLib.normalizeSettings({ ...this.settings, appearance: { ...this.settings.appearance, [id]: packId } });
    this.settingsStore.save(this.settings);
    // leaving an 18+ look takes its adult outfit off (back to the last all-ages one)
    const e = this.pet.characters[id];
    if (e) outfits.enforceOutfit(e, this.settings, this._look(id));
    this._save();
    return { ok: true, view: this.view() };
  }

  // After packs were imported or removed.
  setPacks(packs) {
    this.packs = packs;
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

  // 高级设置 → 桌宠行为: roaming, click sound, voice, memes, collisions (settings.PREFS).
  setPrefs(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...this.settings.prefs };
    for (const k of Object.keys(settingsLib.PREFS)) if (typeof p[k] === 'boolean') next[k] = p[k];
    this.settings = settingsLib.normalizeSettings({ ...this.settings, prefs: next });
    this.settingsStore.save(this.settings);
    this.emit('settings', this.settingsView());
    return { ok: true, settings: this.settingsView() };
  }

  // 高级设置 → 语音: the engine that reads (auto = each character's own / fish / minimax / local / system), the fallback (system / silent),
  // the endpoints and the local server's API / model / voice. API keys go through main.js into tts-keys.json, never into settings.json.
  setTts(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const cur = this.settings.tts;
    const picked = p.provider !== undefined;
    const next = { provider: picked ? p.provider : cur.provider, providerSet: picked || cur.providerSet, fallback: p.fallback === undefined ? cur.fallback : p.fallback, packs: p.packs === undefined ? cur.packs : p.packs !== false, endpoints: { ...cur.endpoints }, local: { ...cur.local, ...(p.local && typeof p.local === 'object' ? p.local : {}) } };
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

  // 同屏伙伴: other model-chan who visit the desktop (no agent of their own; they only play).
  setVisitors(ids) {
    const own = this.pet ? this.pet.speciesId : null;
    const list = (Array.isArray(ids) ? ids : []).filter((id) => SPECIES[id] && id !== own);
    this.settings = settingsLib.normalizeSettings({ ...this.settings, visitors: list });
    this.settingsStore.save(this.settings);
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
    const r = outfits.enforceOutfit(this._c(), this.settings, this._look(this.pet.speciesId));
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
  equipOutfit(id) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const r = outfits.equipOutfit(this._c(), this.settings, String(id || ''), this._look(this.pet.speciesId));
    if (!r.ok) return r;
    this._save();
    return { ok: true, outfit: r.outfit, view: this.view() };
  }

  // The user opened the wardrobe or topic panel: its unlocked items are no longer "new".
  markSeen(kind) {
    if (!this.pet || !['outfit', 'topic'].includes(kind)) return { ok: false };
    const c = this._c();
    const list = kind === 'outfit' ? outfits.listOutfits(c, this.settings, this._look(this.pet.speciesId)) : dialogue.listTopics(c, this.settings);
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

  // Touch one body part: instant, offline, no LLM cost. `target` is a zone id ('head', 'chest', …) or
  // the click point in the sprite's visible box, { x, y } in 0..1 (+ `pose`, and `opaque: false` for a
  // transparent pixel), resolved with the character's zone table. No target = the head, like a pat.
  // Returns { ok, zone, reaction, line, affection, woken }; a point on no body part is
  // { ok: false, reason: 'miss', zone: null } and changes nothing.
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
    const { events, decay } = state.tick(c, t);
    this._save();
    const lost = decay + (this._pendingDecay || 0);
    this._pendingDecay = 0;
    if (lost > 0) this.emit('affection', { type: 'decay', delta: -lost, value: c.affection });
    if (events.includes('woke')) this.emit('say', { text: '哈——睡饱啦。', source: 'fallback', kind: 'woke', origin: this._logPet('哈——睡饱啦。', 'woke') });
    this._sayRetiredNotice();
    const kind = lost > 0 ? 'missed' : nextEvent(c, t, {}, this.rnd);
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
      outfits: outfits.outfitsForStages(r.unlockedStages, c, this.settings, this._look(id)),
    };
    this._save();
    if (isCurrent && r.unlockedStages.length) setImmediate(() => this._onStageUp(r));
    return { ok: true, view: this.view(), unlocks, already: r.unlockedStages.length === 0, speciesId: id };
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
