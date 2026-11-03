'use strict';

// 通用设定 (docs/vrm-dance.md §12): a VRM model is not tied to one of the model-chan characters. A pack whose
// `species` is "generic" (商店 → VRM 角色, 导入 VRM 默认) becomes a companion of her own: when the packs are
// loaded (core/packs.js loadPacks) each one gets a base of its own, made from the template below with the
// model's name — so her name, affection, chat history and LobeHub agent are hers alone (they are kept per base,
// core/pet-state.js), and the rest of the app treats her like any other character.
//
// The base id is derived from the pack id (letters only: settings keep `models.<base>` / `systemRoles.<base>`
// under /^[a-z]{2,20}$/), so the same model always comes back to the same state after a re-download.

const crypto = require('node:crypto');

const GENERIC_BASE = 'generic';
const PREFIX = 'vrmx';

// "vrmx" + 12 letters from the pack id's sha1
function baseIdOf(packId) {
  const h = crypto.createHash('sha1').update(String(packId)).digest();
  let s = PREFIX;
  for (let i = 0; i < 12; i++) s += String.fromCharCode(97 + (h[i] % 26));
  return s;
}
const isGenericBase = (id) => typeof id === 'string' && id.length === PREFIX.length + 12 && id.startsWith(PREFIX) && /^[a-z]+$/.test(id);

// A soft colour from the id, so cards and her body tint differ between models
function accentOf(packId) {
  const h = crypto.createHash('sha1').update(`accent:${packId}`).digest();
  const hue = (h[0] * 360) / 256;
  const [s, l] = [0.45, 0.45];
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// The character file (core/species.js validateCharacter) of a generic pack's own base.
function characterFor(pack, id = baseIdOf(pack.id)) {
  const name = clean(pack.name, 40) || 'VRM 伙伴';
  const author = clean(pack.author, 60);
  return {
    id,
    order: 100,
    vendor: '通用',
    model: '通用',
    name,
    nameZh: name,
    title: 'VRM 伙伴',
    accent: accentOf(pack.id),
    blurb: `用 VRM 模型「${name}」陪你的桌面伙伴，用通用设定，好感、名字和聊天记录只属于她自己。${author ? `模型作者：${author}。` : ''}`,
    personality: `你是桌面上的 VRM 伙伴“${name}”（成年角色，设定年龄 18 岁）。你的样子来自同名的 VRM 模型；除了名字和外表，你没有固定的出身设定，不要冒充模型原作里的角色，被问到时坦然说自己是用这个模型的桌宠伙伴。你温和、好奇、有点俏皮，喜欢陪主人做事、聊天、跳舞，会记得和主人之间的事。你和主人之间只用全年龄的友好语气，不调情、不暧昧。`,
    catchphrase: '嗯嗯~',
    likes: '跳舞、陪主人聊天、被夸好看',
    fallback: {
      hungry: ['有点饿了……喂我一点吧？', '肚子在叫了，嘿嘿。'],
      bored: ['陪我玩一会儿嘛。', '要不要看我跳支舞？'],
      happy: ['今天心情很好！', '和你待在一起真开心。'],
      sleepy: ['有点困了……', '眼皮在打架……'],
      greet: [`你好呀，我是${name}，以后请多关照！`, '我来啦！'],
      fed: ['谢谢，好吃！', '吃饱了，有力气跳舞了。'],
      patted: ['嘿嘿，痒痒的。', '再摸一下也可以哦。'],
      played: ['好玩！再来一次！', '和你玩真开心。'],
    },
    adult: false,
    outfits: ['daily'],
    art: { kind: 'pack', packs: [pack.id] },
    credits: [`VRM 模型「${name}」${author ? `，作者 ${author}` : ''}；授权见模型文件（设置 → 角色 → 她的页 → 授权信息）`],
    generic: { pack: pack.id },
  };
}

// The base of a generic companion whose pack is not loaded (deleted, not downloaded again yet): her saved state
// stays hers (core/migrate.js never hands it to another character). Named from the store's index when she came
// from 商店, so 「需要下载」 can bring her back; an imported model that is gone keeps a placeholder name.
function ghostFor(id) {
  const e = require('./catalog').storeIndex().characters.find((c) => c.kind === 'vrm' && baseIdOf(c.id) === id);
  return characterFor(e ? { id: e.id, name: e.name, author: e.author } : { id: `${id}-missing`, name: 'VRM 伙伴（模型已删除）' }, id);
}

module.exports = { GENERIC_BASE, ghostFor, PREFIX, baseIdOf, isGenericBase, characterFor, accentOf };
