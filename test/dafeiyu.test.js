'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SPECIES, SPECIES_IDS } = require('../src/core/species');

const DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'dafeiyu');
const REQUIRED_CLIPS = ['idle', 'happy', 'sad', 'hungry', 'sleep', 'eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'talk', 'play', 'pat', 'hatch', 'evolve', 'lifted', 'walk'];

test('the roster is the model-chan: DeepSeek 大肥鱼 (kept, video), Claude and Grok', () => {
  assert.deepEqual(SPECIES_IDS, ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']);
  assert.equal(SPECIES.dafeiyu.nameZh, '大肥鱼');
  assert.equal(SPECIES.dafeiyu.vendor, 'DeepSeek');
  assert.equal(SPECIES.dafeiyu.art, 'video');
});

test('every status and reaction has a clip, and each clip is a real WebM file', () => {
  for (const key of REQUIRED_CLIPS) {
    const files = [].concat(SPECIES.dafeiyu.clips[key] || []);
    assert.ok(files.length, `missing clip mapping: ${key}`);
    for (const file of files) {
      const buf = fs.readFileSync(path.join(DIR, file));
      assert.deepEqual([...buf.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], `${file} is not WebM`);
    }
  }
  // dsh-pet's own click reactions play in turn; lifted is its drag clip, not the click clip
  assert.equal(SPECIES.dafeiyu.clips.pat.length, 4);
  assert.equal(SPECIES.dafeiyu.clips.lifted, 'lifted.webm');
  assert.notDeepEqual(fs.readFileSync(path.join(DIR, 'lifted.webm')), fs.readFileSync(path.join(DIR, 'pat.webm')));
});

test('pack characters do not carry video fields, so the renderer draws them from their pack', () => {
  for (const id of ['grok', 'claude', 'gemini', 'gpt']) {
    assert.equal(SPECIES[id].art, 'pack');
    assert.equal(SPECIES[id].clips, null);
    assert.equal(SPECIES[id].defaultPack, `${id}-pixel`);
  }
});

test('the required credit and non-commercial terms ship with the assets and the README', () => {
  const notice = fs.readFileSync(path.join(DIR, 'NOTICE.md'), 'utf8');
  assert.match(notice, /github\.com\/PC2005-cloud\/dsh-pet/);
  assert.match(notice, /commercial use is forbidden/i);
  assert.match(notice, /CC BY-NC-SA 4\.0/);
  assert.ok(fs.existsSync(path.join(DIR, 'LICENSE-dsh-pet.txt')));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /github\.com\/PC2005-cloud\/dsh-pet/);
});

test('克洛蒂 has her own 原设立绘 clips (T-1270): every state is a portrait WebM, cropped by art.frame, her pixel pack still the default', () => {
  const sp = SPECIES.claude;
  assert.equal(sp.art, 'video');
  assert.equal(sp.defaultPack, 'claude-pixel', 'she starts in her pixel pack; the clips are a 外观 choice');
  assert.deepEqual(Object.keys(sp.clips).sort(), [...require('../src/core/fx').STATES].sort(), 'a clip for every state, lifted and walk included');
  const dir = path.join(__dirname, '..', 'src', 'renderer', sp.clipDir);
  for (const file of Object.values(sp.clips).flat()) {
    const buf = fs.readFileSync(path.join(dir, file));
    assert.deepEqual([...buf.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], `${file} is not WebM`);
  }
  assert.deepEqual(sp.clipFrame, { crop: [0, 0.03, 1, 0.985], aspect: 0.5625, height: 226 });
  assert.match(sp.clipsLook.license, /CC BY-NC-SA/);
  // 大肥鱼 keeps her landscape crop
  assert.deepEqual(SPECIES.dafeiyu.clipFrame, { crop: [0.27, 0.136, 0.73, 0.951], aspect: 16 / 9, height: 150 });
});
