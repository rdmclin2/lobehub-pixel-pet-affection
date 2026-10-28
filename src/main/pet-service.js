'use strict';

const { EventEmitter } = require('node:events');
const state = require('../core/pet-state');
const persona = require('../core/persona');
const { adultAllowed } = require('../core/affection');
const dialogue = require('../core/dialogue');
const outfits = require('../core/outfits');
const { migratePet } = require('../core/migrate');
const settingsLib = require('../core/settings');
const { getSpecies } = require('../core/species');
const contentGuard = require('../core/content-guard');
const { nextEvent, LlmBudget, fallbackLine } = require('../core/proactive');
const { ensureLocalDevice, bindConfig, unbindConfig, LOCAL_TOOLS } = require('../core/local-device');

const LOCAL_RECHECK_MS = 6 * 60 * 60 * 1000; // re-confirm the device binding a few times a day
const LOCAL_RETRY_MS = 5 * 60 * 1000; // after a failure, do not hammer `lh` on every message

// Owns the pet's lifecycle. Electron-free so it can be tested with a fake `lh`.
class PetService extends EventEmitter {
  constructor({ lh, store, settingsStore = new settingsLib.MemorySettingsStore(), now = () => Date.now(), rnd = Math.random, budget = new LlmBudget() }) {
    super();
    this.lh = lh;
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
  }

  // Load the save; a growth-system save (xp / stage) is backed up once and migrated (design 6).
  init() {
    const t = this.now();
    this.settings = this.settingsStore.load();
    const raw = this.store.load();
    const { pet, migrated } = migratePet(raw, t);
    if (migrated) this.store.backupOnce('pet.v1.bak.json');
    this.pet = pet;
    // A pet's agent is reached in the space it was created in (no `space`: an older save, lh's default).
    this.lh.setWorkspace(this.pet && this.pet.space ? this.pet.space.workspaceId : this.pet ? undefined : null);
    if (this.pet) {
      const { decay } = state.tick(this.pet, t);
      // The settings may have changed while the app was closed (e.g. a re-asked age gate).
      const { changed } = outfits.enforceOutfit(this.pet, this.settings);
      if (migrated || decay > 0 || changed) this.store.save(this.pet);
      if (decay > 0) this._pendingDecay = decay;
    }
    return this.view();
  }

  _adult() {
    return !!this.pet && adultAllowed(this.settings, this.pet.speciesId);
  }

  // Settings as the UI needs them: whether to show the age gate, and whether adult content is on.
  settingsView() {
    return { ...this.settings, needsAgeGate: settingsLib.needsAgeGate(this.settings) };
  }

  view() {
    if (!this.pet) return null;
    const sp = getSpecies(this.pet.speciesId);
    return {
      pet: { ...this.pet },
      status: state.currentStatus(this.pet),
      affection: state.toAffectionProgress(this.pet, { adult: this._adult() }),
      topics: dialogue.listTopics(this.pet, this.settings),
      outfits: outfits.listOutfits(this.pet, this.settings),
      outfit: outfits.wornOutfit(this.pet, this.settings),
      art: outfits.artFor(this.pet.speciesId, outfits.wornOutfit(this.pet, this.settings)),
      settings: this.settingsView(),
      species: { id: sp.id, name: sp.name, nameZh: sp.nameZh, element: sp.element },
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

  _say(text, source, kind, reason = null) {
    if (this.pet) this.pet.lastSpokeAt = this.now();
    this.emit('say', { text, source, kind, reason });
    if (this.pet) this._save();
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
    const { agentId } = await this.lh.createAgent({
      title: `${petName} (${sp.name})`,
      description: `Pixel Pet · ${sp.nameZh} · ${sp.element}`,
      systemRole: persona.buildSystemRole({ speciesId, name: petName, settings: this.settings }),
    });

    this.pet = state.createPet({ speciesId, name: petName, agentId, now: this.now() });
    this.pet.space = { workspaceId, name: workspaceId ? String((space && space.name) || workspaceId).slice(0, 60) : '个人空间' };
    this.pet.owner = user.name;
    // the agent was just created with the current role
    this.pet.personaVersion = persona.PERSONA_VERSION;
    this.pet.personaKey = persona.personaKey(this.pet, this.settings);
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

  // ---- keeping an existing agent up to date ---------------------------------------------
  // The system role carries the persona version and the current relationship scope; update the
  // LobeHub agent once whenever either changed (older pet, stage up/down, adult toggle).
  async _ensureReady() {
    const p = this.pet;
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
    if (p.localAbilities) await this._verifyLocal();
  }

  // Find this computer's online device (starting `lh connect --daemon` if none) and bind the agent to it.
  async _verifyLocal({ force = false } = {}) {
    const t = this.now();
    if (!force) {
      if (this._localOk && t - this._localCheckedAt < LOCAL_RECHECK_MS) return;
      if (!this._localOk && this._localFailedAt && t - this._localFailedAt < LOCAL_RETRY_MS) return;
    }
    try {
      const { deviceId, via, daemon } = await ensureLocalDevice(this.lh);
      this._deviceId = deviceId;
      let bindWarning = null;
      if (this.pet.boundDeviceId !== deviceId) {
        try {
          await this.lh.updateAgent({ agentId: this.pet.agentId, agencyConfig: bindConfig(deviceId) });
          this.pet.boundDeviceId = deviceId;
        } catch (e) {
          // An old lh has no `agent edit --agency-config-file`. The agent then cannot be bound, but every run can
          // still name the device (`--device <id>`), so local tools keep working; just tell the user to update lh.
          if (!/unknown option/i.test(e.message)) throw e;
          bindWarning = '你的 lh 版本较旧，没能把宠物绑定到这台电脑，已改为每次运行直接指定设备。建议升级：npm install -g @lobehub/cli@latest';
        }
      }
      this._localOk = true;
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
      await this.lh.updateAgent({ agentId: this.pet.agentId, agencyConfig: unbindConfig() });
      this.pet.localAbilities = false;
      this.pet.boundDeviceId = null;
      this._localOk = false;
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
    await this._ensureReady();
  }

  _tools() {
    return this.pet.localAbilities && this._localOk ? LOCAL_TOOLS : [];
  }

  // Stop whatever the agent is doing right now.
  cancel() {
    if (!this.busy) return;
    this._cancelRequested = true;
    this.lh.cancel();
  }

  // Steps that swallow errors (device lookup, persona update) must not let a cancelled turn carry on.
  _throwIfCanceled() {
    if (this._cancelRequested) throw Object.assign(new Error('Canceled'), { code: 'ECANCELED' });
  }

  _device() {
    return this.pet.localAbilities && this._localOk ? this._deviceId : null;
  }

  // Ask the agent to say something for a system-triggered event.
  async _speak(kind) {
    const t = this.now();
    const sp = getSpecies(this.pet.speciesId);
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
      const res = await this.lh.run({
        agentId: this.pet.agentId,
        topicId: this.pet.topicId,
        prompt: persona.buildEventPrompt(kind, this.pet, t, this.settings),
        tools: this._tools(),
        device: this._device(),
      });
      if (res.topicId) this.pet.topicId = res.topicId;
      if (kind === 'greet_morning' || kind === 'greet_evening') this.pet.lastGreetDay = new Date(t).toDateString();
      this._say(this._guard(res.text), 'llm', kind);
    } catch (e) {
      if (e.code === 'ECANCELED') {
        this._save();
        return;
      }
      if (kind === 'greet_morning' || kind === 'greet_evening') this.pet.lastGreetDay = new Date(t).toDateString();
      this._say(this._fallback(sp, kind), 'fallback', kind, e.message);
      this.emit('error', e);
    } finally {
      this.busy = false;
      this.emit('thinking', false);
    }
  }

  // `images`: local picture files to upload so the model can see them (pasted screenshots).
  // `files`: paths of dropped files/folders; they are NOT uploaded: the agent reads them through
  // the bound device, so local abilities must be on.
  async chat(text, images = [], files = []) {
    const clean = String(text || '').trim();
    const paths = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f).slice(0, 10);
    if (!this.pet || (!clean && images.length === 0 && paths.length === 0)) return { ok: false, reason: 'empty' };
    if (this.busy) return { ok: false, reason: 'busy' };
    if (paths.length && !this.pet.localAbilities) return { ok: false, reason: 'local-off' };
    const t = this.now();
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    try {
      state.touch(this.pet, t);
      await this._ensureReady();
      this._throwIfCanceled();
      if (paths.length && !this._localOk) return { ok: false, reason: 'local-error', message: this.localError };
      const local = this._tools().length > 0;
      let body;
      if (images.length) {
        const fileIds = [];
        for (const img of images) fileIds.push(await this.lh.uploadFile(img));
        if (!this.pet.topicId) this.pet.topicId = await this.lh.createTopic(this.pet.agentId, this.pet.name);
        const mid = await this.lh.createUserMessage({ agentId: this.pet.agentId, topicId: this.pet.topicId, content: clean || '（发了一张图片）' });
        await this.lh.addFilesToMessage(mid, fileIds);
        body = `[图片] 主人刚发来 ${images.length} 张图片${clean ? '和上面那句话' : ''}（就在上一条消息里），请先看图，再直接回应。`;
        if (paths.length) body += `\n${persona.buildFilesBlock(paths, true)}`;
      } else {
        body = [clean, paths.length ? persona.buildFilesBlock(paths, !!clean) : ''].filter(Boolean).join('\n');
      }
      const prompt = persona.buildChatPrompt(body, this.pet, t, { local, settings: this.settings });
      const res = await this.lh.run({ agentId: this.pet.agentId, topicId: this.pet.topicId, prompt, tools: this._tools(), device: this._device() });
      if (res.topicId) this.pet.topicId = res.topicId;
      const { affection } = state.chatted(this.pet, this.now(), { textLength: [...clean].length || (images.length || paths.length ? 2 : 0) });
      const text = this._guard(res.text);
      this._say(text, 'llm', 'chat');
      this._reportAffection(affection);
      return { ok: true, text, cost: res.cost, affection };
    } catch (e) {
      if (e.code !== 'ECANCELED') this.emit('error', e);
      this._save(); // touch() above may have woken the pet; keep the sprite in sync
      if (e.code === 'ECANCELED') return { ok: false, reason: 'canceled' };
      return { ok: false, reason: 'error', code: e.code || null, message: e.message };
    } finally {
      this.busy = false;
      this.emit('thinking', false);
    }
  }

  _fallback(sp, kind) {
    return fallbackLine(sp, kind, this.rnd, this.pet, this.settings);
  }

  // Tell the UI what an interaction scored, and celebrate a stage-up (design 9.3, 9.4).
  _reportAffection(r) {
    if (!r) return;
    this.emit('affection', { type: 'gain', source: r.source, delta: r.delta, blocked: r.blocked, value: r.value });
    if (r.stageUp) setImmediate(() => this._onStageUp(r));
  }

  async _onStageUp(r) {
    const unlocks = {
      topics: dialogue.topicsForStages(r.unlockedStages, this.pet, this.settings),
      outfits: outfits.outfitsForStages(r.unlockedStages, this.pet, this.settings),
    };
    this.emit('affection', { type: 'stage-up', stage: r.to, view: this.view(), unlocks });
    await this._speak('stage_up');
  }

  // Start an unlocked topic from the topic panel (design 4, 9.6). Locked or hidden topics are refused
  // here as well, not only greyed out in the UI.
  async talkTopic(id) {
    if (!this.pet) return { ok: false, reason: 'empty' };
    const check = dialogue.getTopic(this.pet, this.settings, id);
    if (!check.ok) return check;
    if (this.busy) return { ok: false, reason: 'busy' };
    const topic = check.topic;
    const t = this.now();
    this.busy = true;
    this._cancelRequested = false;
    this.emit('thinking', true);
    try {
      state.touch(this.pet, t);
      await this._ensureReady();
      this._throwIfCanceled();
      const res = await this.lh.run({ agentId: this.pet.agentId, topicId: this.pet.topicId, prompt: persona.buildTopicPrompt(topic, this.pet, t, this.settings), tools: this._tools(), device: this._device() });
      if (res.topicId) this.pet.topicId = res.topicId;
      const { affection } = state.talkedTopic(this.pet, topic.id, this.now());
      const text = this._guard(res.text);
      this._say(text, 'llm', `topic:${topic.id}`);
      this._reportAffection(affection);
      return { ok: true, text, affection };
    } catch (e) {
      if (e.code === 'ECANCELED') {
        this._save();
        return { ok: false, reason: 'canceled' };
      }
      this.emit('error', e);
      // An offline line keeps the panel responsive, but it does not score: only a real reply does.
      this._say(topic.fallback[0], 'fallback', `topic:${topic.id}`, e.message);
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
    const r = outfits.enforceOutfit(this.pet, this.settings);
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
    const r = outfits.equipOutfit(this.pet, this.settings, String(id || ''));
    if (!r.ok) return r;
    this._save();
    return { ok: true, outfit: r.outfit, view: this.view() };
  }

  // The user opened the wardrobe or topic panel: its unlocked items are no longer "new".
  markSeen(kind) {
    if (!this.pet || !['outfit', 'topic'].includes(kind)) return { ok: false };
    const list = kind === 'outfit' ? outfits.listOutfits(this.pet, this.settings) : dialogue.listTopics(this.pet, this.settings);
    const ids = list.filter((x) => x.isNew).map((x) => `${kind}:${x.id}`);
    if (ids.length) {
      this.pet.seenUnlocks = [...(this.pet.seenUnlocks || []), ...ids];
      this._save();
    }
    return { ok: true, marked: ids.length };
  }

  // Care actions: instant, deterministic, no LLM cost (reaction line is canned).
  act(kind, food) {
    if (!this.pet) return { ok: false };
    if (this.busy) return { ok: false, reason: 'busy' }; // no side actions while the pet is working
    const t = this.now();
    const sp = getSpecies(this.pet.speciesId);
    let r;
    if (kind === 'feed') r = state.feed(this.pet, food, t);
    else if (kind === 'pat') r = state.pat(this.pet, t);
    else if (kind === 'play') r = state.play(this.pet, t);
    else if (kind === 'sleep') r = state.putToSleep(this.pet, t);
    else return { ok: false };

    let line = null;
    if (kind === 'sleep') line = sp.fallback.sleepy[0];
    else if (r.reason === 'full') line = '呃……肚子圆滚滚的，吃不下了。';
    else if (r.reason === 'tired') line = '好累……让我睡一会儿。';
    else if (r.ok) line = this._fallback(sp, { feed: 'fed', pat: 'patted', play: 'played' }[kind]);
    if (line) this._say(line, 'fallback', kind);
    else this._save();
    this._reportAffection(r.affection);
    return r;
  }

  // Called on a timer. Advances needs and maybe lets the pet speak up.
  async heartbeat() {
    if (!this.pet) return;
    const t = this.now();
    const { events, decay } = state.tick(this.pet, t);
    this._save();
    const lost = decay + (this._pendingDecay || 0);
    this._pendingDecay = 0;
    if (lost > 0) this.emit('affection', { type: 'decay', delta: -lost, value: this.pet.affection });
    if (events.includes('woke')) this.emit('say', { text: '哈——睡饱啦。', source: 'fallback', kind: 'woke' });
    const kind = lost > 0 ? 'missed' : nextEvent(this.pet, t, {}, this.rnd);
    if (kind) await this._speak(kind);
  }

  // Test hook (PIXELPET_TEST only): force pet fields. Forcing `affection` re-derives the stages
  // the same way real scoring would, including the stage-up event.
  debugSet(patch) {
    if (!this.pet) return null;
    const { affection, ...rest } = patch || {};
    Object.assign(this.pet, rest);
    if (typeof affection === 'number') {
      const r = state.setAffectionForTest(this.pet, affection);
      if (r.stageUp) setImmediate(() => this._onStageUp(r));
    }
    this._save();
    return this.view();
  }

  // Release the pet: optionally delete the LobeHub agent as well.
  async release({ deleteAgent = false } = {}) {
    if (!this.pet) return { ok: true };
    let deleted = false;
    if (deleteAgent) deleted = await this.lh.deleteAgent(this.pet.agentId);
    this.pet = null;
    this.lh.setWorkspace(null);
    this.store.clear();
    this.emit('update', null);
    return { ok: true, deleted };
  }
}

module.exports = { PetService };
