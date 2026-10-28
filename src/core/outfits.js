'use strict';

// Tiered outfits (design section 5). Every outfit unlocks at a relationship stage and is gated the same
// way as topics: by `peakStage` (unlocks are never taken back) and by rating. `adult` outfits exist only
// when the user confirmed 18+ AND turned adult content on, and never for the third-party character
// Dafeiyu. Turning adult content off puts the pet back into the last all-ages outfit it wore.
//
// Content boundary (design 8.2): nothing is revealing. The adult tier is about style only (a long maid
// dress, an off-shoulder evening gown, a retro one-piece swimsuit, a knee-length silk robe). Every
// companion has one generated picture per outfit it can wear (`artFor`, made for this project with
// gpt-image-2.5 through LobeHub, see NOTICE.md); every picture shows an adult woman.

const { getStage, stageIndex, stageName, adultAllowed } = require('./affection');

const OUTFITS = [
  { id: 'daily', stage: 'stranger', rating: 'all', label: '日常服', desc: '白衬衫配牛仔裤，最平常的样子。' },
  { id: 'scarf', stage: 'stranger', rating: 'all', label: '针织围巾套装', desc: '米色毛衣加一条红色针织围巾。' },
  { id: 'casual', stage: 'familiar', rating: 'all', label: '休闲卫衣', desc: '宽松灰色连帽卫衣和运动裤。' },
  { id: 'beret', stage: 'familiar', rating: 'all', label: '贝雷帽画家装', desc: '条纹衫、背带裤和一顶贝雷帽。' },
  { id: 'pajamas', stage: 'close', rating: 'all', label: '毛绒睡衣', desc: '长袖长裤的波点睡衣，配睡帽。' },
  { id: 'cat_ears', stage: 'close', rating: 'all', label: '猫耳家居服', desc: '粉色家居服和猫耳发箍。' },
  { id: 'yukata', stage: 'flirty', rating: 'all', label: '浴衣', desc: '藏青色长款浴衣，红色腰带。' },
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

// Dafeiyu's own look is its animated clips (assets/dafeiyu): its default outfit shows them.
const SIGNATURE = { dafeiyu: { label: '招牌女仆装', desc: '大肥鱼原本的样子（动画）。' } };

// The picture of `speciesId` wearing `outfitId`, relative to the renderer page; null = the species' clips.
function artFor(speciesId, outfitId) {
  if (SIGNATURE[speciesId] && outfitId === DEFAULT_OUTFIT) return null;
  return `assets/chars/${speciesId}/${byId(outfitId) ? outfitId : DEFAULT_OUTFIT}.webp`;
}

function lockCondition(stageId, affection, adult) {
  const s = getStage(stageId);
  const need = Math.max(0, Math.ceil(s.min - affection));
  return `${stageName(stageId, adult)}（♥${s.min}）解锁${need > 0 ? `，还差 ${need}` : ''}`;
}

const isUnlocked = (pet, o) => stageIndex(o.stage) <= stageIndex(pet.peakStage);
const isVisible = (pet, settings, o) => o.rating === 'all' || adultAllowed(settings, pet.speciesId);

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
    const own = o.id === DEFAULT_OUTFIT && SIGNATURE[pet.speciesId];
    return {
      id: o.id,
      label: own ? own.label : o.label,
      desc: own ? own.desc : o.desc,
      art: artFor(pet.speciesId, o.id),
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
  if (!isVisible(pet, settings, o)) return { ok: false, reason: 'hidden' };
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

module.exports = { OUTFITS, OUTFIT_IDS, DEFAULT_OUTFIT, artFor, listOutfits, checkOutfit, equipOutfit, enforceOutfit, wornOutfit, outfitsForStages };
