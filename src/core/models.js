'use strict';

// Which LLM a companion's LobeHub agent runs on. Each character may only use models of her own vendor
// (`models` in src/characters/<id>.json): ids matching `match`, offered by LobeHub's hosted provider or by
// the vendor's own provider when the user enabled it. The user picks one per character (⋯ → 角色列表 → her page →
// 模型, kept in settings.models); without a pick, the first available id of `prefer` is used, else the first
// match. Models that only make images (Nano Banana) are left out. Electron-free so it can be tested.

const { SPECIES } = require('./species');

const HOSTED = 'lobehub'; // LobeHub's own provider: every vendor's models, billed through LobeHub
const KEY_RE = /^[a-z0-9-]{2,40}:[A-Za-z0-9._-]{1,80}$/;

// "provider:model" — how a choice is stored and compared.
const keyOf = (m) => `${m.providerId}:${m.id}`;

// Providers whose model lists matter for the roster: the hosted one and each character's own vendor.
function providersToQuery(enabledProviderIds) {
  const want = new Set([HOSTED]);
  for (const sp of Object.values(SPECIES)) for (const p of (sp.models && sp.models.providers) || []) want.add(p);
  return [...want].filter((p) => enabledProviderIds.includes(p));
}

// The models `speciesId` may use, from a catalog of { id, displayName, providerId, enabled, type, abilities }.
// Hosted models come first (most users only have those), then the vendor's own provider; list order kept.
function optionsFor(speciesId, catalog) {
  const sp = SPECIES[speciesId];
  const rule = sp && sp.models;
  if (!rule) return [];
  const re = new RegExp(rule.match);
  const providers = [HOSTED, ...(rule.providers || [])];
  const seen = new Set();
  const out = [];
  for (const p of providers) {
    for (const m of catalog) {
      if (m.providerId !== p || m.enabled === false || (m.type && m.type !== 'chat')) continue;
      if ((m.abilities || {}).imageOutput || !re.test(m.id)) continue;
      const key = keyOf(m);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, id: m.id, providerId: m.providerId, label: m.displayName || m.id, hosted: p === HOSTED });
    }
  }
  return out;
}

// The model the agent should run on: the user's pick if it is still offered, else the character default.
// null when the catalog has nothing for her (the agent then keeps whatever model it has).
function pick(speciesId, options, chosenKey) {
  if (!options.length) return null;
  const chosen = chosenKey && options.find((o) => o.key === chosenKey);
  if (chosen) return chosen;
  const prefer = (SPECIES[speciesId] && SPECIES[speciesId].models && SPECIES[speciesId].models.prefer) || [];
  for (const id of prefer) {
    const o = options.find((x) => x.id === id);
    if (o) return o;
  }
  return options[0];
}

module.exports = { HOSTED, KEY_RE, keyOf, providersToQuery, optionsFor, pick };
