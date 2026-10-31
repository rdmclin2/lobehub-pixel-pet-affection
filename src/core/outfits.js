'use strict';

// Tiered outfits (design section 5). Every outfit unlocks at a relationship stage and is gated the same
// way as topics: by `peakStage` (unlocks are never taken back) and by rating. `adult` outfits exist only
// when the user confirmed 18+ AND turned adult content on AND the character allows it (none of the
// model-chan do). A character only offers the outfits it has art for (`outfits` in its file).
// Turning adult content off puts the pet back into the last all-ages outfit it wore.
//
// Content boundary (design 8.2): nothing is revealing. The adult tier is about style only (a long maid
// dress, an off-shoulder evening gown, a retro one-piece swimsuit, a knee-length silk robe). The art
// for each outfit comes from the companion's pet pack (src/core/packs.js); every built-in picture
// shows an adult woman (see NOTICE.md).

const { getStage, stageIndex, stageName, adultAllowed } = require('./affection');
const { SPECIES } = require('./species');

const OUTFITS = [
  { id: 'daily', stage: 'stranger', rating: 'all', label: '日常服', desc: '白衬衫配牛仔裤，最平常的样子。' },
  { id: 'scarf', stage: 'stranger', rating: 'all', label: '针织围巾套装', desc: '米色毛衣加一条红色针织围巾。' },
  { id: 'casual', stage: 'familiar', rating: 'all', label: '休闲卫衣', desc: '宽松灰色连帽卫衣和运动裤。' },
  { id: 'beret', stage: 'familiar', rating: 'all', label: '贝雷帽画家装', desc: '条纹衫、背带裤和一顶贝雷帽。' },
  { id: 'pajamas', stage: 'close', rating: 'all', label: '毛绒睡衣', desc: '长袖长裤的波点睡衣，配睡帽。' },
  { id: 'cat_ears', stage: 'close', rating: 'all', label: '猫耳家居服', desc: '粉色家居服和猫耳发箍。' },
  // All-ages beachwear, unlike retro_swimsuit (adult): a high-necked sporty one-piece under knee-length shorts
  // and an open sun jacket. 亲近 like the other off-duty looks (pajamas, cat ears): she would go to the beach
  // with you once you are close, before the 知己 yukata.
  { id: 'swimsuit', stage: 'close', rating: 'all', label: '运动泳装', desc: '高领短袖的运动款连体泳衣，外搭及膝沙滩裤和防晒开衫。' },
  { id: 'yukata', stage: 'flirty', rating: 'all', label: '浴衣', desc: '藏青色长款浴衣，红色腰带。' },
  // All-ages too, a step lighter than the swimsuit: a loose two-layer flounce top that hides the chest, a
  // mid-thigh frilled swim skirt and a short cardigan; only a strip of waist, the arms and lower legs show.
  // 暧昧 like the yukata, since it shows more than the 亲近 swimsuit (docs/compliance-review.md 3d).
  { id: 'bikini', stage: 'flirty', rating: 'all', label: '沙滩比基尼', desc: '两层荷叶边的比基尼上衣、到大腿中部的荷叶边泳裙，外搭短开衫。' },
  { id: 'maid', stage: 'flirty', rating: 'adult', label: '女仆装', desc: '长袖及膝女仆裙、白围裙和发带（不暴露）。' },
  { id: 'offshoulder_gown', stage: 'flirty', rating: 'adult', label: '露肩晚礼服', desc: '酒红色及地晚礼服，只露出肩膀。' },
  { id: 'couple_hoodie', stage: 'lover', rating: 'all', label: '情侣卫衣', desc: '印着爱心的粉色情侣卫衣。' },
  { id: 'flower_crown', stage: 'lover', rating: 'all', label: '花冠长裙', desc: '白色长裙和一顶花冠。' },
  { id: 'retro_swimsuit', stage: 'lover', rating: 'adult', label: '复古连体泳装', desc: '海军蓝复古连体泳装、遮阳帽和凉鞋（保守款）。' },
  { id: 'silk_robe', stage: 'lover', rating: 'adult', label: '丝绸睡袍', desc: '香槟色及膝丝绸睡袍，系好腰带，内搭长睡裤。' },
];

const OUTFIT_IDS = OUTFITS.map((o) => o.id);
const DEFAULT_OUTFIT = 'daily';
const byId = (id) => OUTFITS.find((o) => o.id === id) || null;

// A character's own look (its file's `signature`) replaces the generic name of the default outfit.
const signature = (speciesId) => (SPECIES[speciesId] && SPECIES[speciesId].signature) || null;
// Outfits a character has art for; an unknown character has only the default outfit.
const hasArt = (speciesId, id) => id === DEFAULT_OUTFIT || !!(SPECIES[speciesId] && SPECIES[speciesId].outfits.includes(id));

function lockCondition(stageId, affection, adult) {
  const s = getStage(stageId);
  const need = Math.max(0, Math.ceil(s.min - affection));
  return `${stageName(stageId, adult)}（♥${s.min}）解锁${need > 0 ? `，还差 ${need}` : ''}`;
}

const isUnlocked = (pet, o) => stageIndex(o.stage) <= stageIndex(pet.peakStage);
const isVisible = (pet, settings, o) => hasArt(pet.speciesId, o.id) && (o.rating === 'all' || adultAllowed(settings, pet.speciesId));

// The outfit the pet is actually wearing: its saved one if that is still visible and unlocked, else the
// last all-ages outfit it wore, else the default.
function wornOutfit(pet, settings) {
  for (const id of [pet.equippedOutfit, pet.lastSafeOutfit, DEFAULT_OUTFIT]) {
    const o = byId(id);
    if (o && isUnlocked(pet, o) && isVisible(pet, settings, o)) return o.id;
  }
  return DEFAULT_OUTFIT;
}

// Every outfit for the wardrobe. Adult outfits are hidden entirely (not shown as locked) when adult
// content is not allowed; every other outfit is listed, locked ones with their unlock condition.
function listOutfits(pet, settings) {
  const adult = adultAllowed(settings, pet.speciesId);
  const worn = wornOutfit(pet, settings);
  const seen = pet.seenUnlocks || [];
  return OUTFITS.filter((o) => isVisible(pet, settings, o)).map((o) => {
    const unlocked = isUnlocked(pet, o);
    const own = o.id === DEFAULT_OUTFIT && signature(pet.speciesId);
    return {
      id: o.id,
      label: own ? own.label : o.label,
      desc: own ? own.desc : o.desc,
      stage: o.stage,
      stageName: stageName(o.stage, adult),
      rating: o.rating,
      unlocked,
      locked: !unlocked,
      condition: unlocked ? null : lockCondition(o.stage, pet.affection, adult),
      equipped: o.id === worn,
      isNew: unlocked && o.stage !== 'stranger' && !seen.includes(`outfit:${o.id}`),
    };
  });
}

// Validate an equip request. { ok: true, outfit } or { ok: false, reason: 'unknown'|'hidden'|'locked', condition }.
function checkOutfit(pet, settings, id) {
  const o = byId(id);
  if (!o) return { ok: false, reason: 'unknown' };
  if (!isVisible(pet, settings, o)) return { ok: false, reason: hasArt(pet.speciesId, o.id) ? 'hidden' : 'unavailable' };
  if (!isUnlocked(pet, o)) return { ok: false, reason: 'locked', condition: lockCondition(o.stage, pet.affection, adultAllowed(settings, pet.speciesId)) };
  return { ok: true, outfit: o };
}

// Put an outfit on (mutates `pet`). All-ages outfits are remembered as the fallback for when adult
// content is switched off.
function equipOutfit(pet, settings, id) {
  const r = checkOutfit(pet, settings, id);
  if (!r.ok) return r;
  pet.equippedOutfit = r.outfit.id;
  if (r.outfit.rating === 'all') pet.lastSafeOutfit = r.outfit.id;
  return { ok: true, outfit: { id: r.outfit.id, label: r.outfit.label } };
}

// After the adult switch or the age answer changed: if the saved outfit may no longer be shown, change
// into the fallback and save that. Returns { changed, from, to }.
function enforceOutfit(pet, settings) {
  const from = pet.equippedOutfit;
  const to = wornOutfit(pet, settings);
  if (from === to) return { changed: false, from, to };
  pet.equippedOutfit = to;
  return { changed: true, from, to };
}

// Outfits that a stage-up just unlocked, as the user may see them.
function outfitsForStages(stageIds, pet, settings) {
  return OUTFITS.filter((o) => stageIds.includes(o.stage) && isVisible(pet, settings, o)).map((o) => ({ id: o.id, label: o.label }));
}

module.exports = { OUTFITS, OUTFIT_IDS, DEFAULT_OUTFIT, signature, hasArt, listOutfits, checkOutfit, equipOutfit, enforceOutfit, wornOutfit, outfitsForStages };
