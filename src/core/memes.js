'use strict';

// Meme pictures in the speech bubble (dsh-pet memes.ts / whisper.ts). A character lists its memes in its
// file (`memes`: [{ id, label, desc }], pictures in src/renderer/assets/memes/<character>/<id>.webp).
// The agent may end a reply with one tag, `[梗图:<id>]`, picked from the list it is given with every
// message; the tag is stripped from the text and the picture shown under it. Offline lines (hunger,
// greetings, …) get a random one now and then. Only the list a character has is ever offered.

const TAG_RE = /\[(?:梗图|meme)[:：]\s*([a-z0-9_-]{1,40})\s*\]/gi;
const RANDOM_CHANCE = 0.35; // an offline line comes with a picture about a third of the time

const memesOf = (species) => (species && Array.isArray(species.memes) ? species.memes : []);

// The per-message hint (persona.buildStateBlock): which pictures exist and how to attach one.
function memeHint(species) {
  const list = memesOf(species);
  if (!list.length) return '';
  const items = list.map((m) => `${m.id}（${m.label}：${m.desc}）`).join('；');
  return `[梗图] 回复特别合适时，可以在最后单独一行写 [梗图:编号] 配一张你的表情包，最多一张，不合适就不写。可选：${items}`;
}

// Strip every meme tag from `text`; the first one naming a picture this character has is the meme.
function extractMeme(text, species) {
  const ids = new Set(memesOf(species).map((m) => m.id));
  let meme = null;
  const clean = String(text || '').replace(TAG_RE, (_all, id) => {
    const k = id.toLowerCase();
    if (!meme && ids.has(k)) meme = k;
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, meme };
}

// What of a reply still being written may be shown (流式回复, pet-service onDelta): every finished meme tag is
// taken out, and so is a tail that may still become one (`[梗`, `[梗图:ca`, `[mem`) — a tag cut between two
// pieces never flashes in the bubble. The picture itself comes with the final reply (extractMeme).
const OPEN_TAG_RE = /\[(?:梗(?:图(?:[:：]\s*[a-z0-9_-]{0,40}\s*)?)?|m(?:e(?:m(?:e(?:[:：]\s*[a-z0-9_-]{0,40}\s*)?)?)?)?)?$/i;
function streamingText(soFar) {
  return String(soFar || '').replace(TAG_RE, '').replace(OPEN_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// A random picture for an offline line, or null (most of the time, or when the character has none).
function randomMeme(species, rnd = Math.random) {
  const list = memesOf(species);
  if (!list.length || rnd() >= RANDOM_CHANCE) return null;
  return list[Math.floor(rnd() * list.length) % list.length].id;
}

const memeUrl = (speciesId, id) => `assets/memes/${speciesId}/${id}.webp`;

module.exports = { TAG_RE, RANDOM_CHANCE, memeHint, extractMeme, streamingText, randomMeme, memeUrl, memesOf };
