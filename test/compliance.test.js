'use strict';
// Design 8.1: no growth stages / minor or infant framing in anything shown to the user or sent to the agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');
// Display and prompt sources. lh-client / lh-path / local-device are CLI plumbing ("child process").
const FILES = ['core/persona.js', 'core/species.js', 'core/dialogue.js', 'core/affection.js', 'core/proactive.js', 'core/pet-state.js', 'core/migrate.js', 'core/outfits.js', 'main/pet-service.js', 'renderer/app.js', 'renderer/index.html', 'renderer/sprites.js', 'renderer/style.css'];
const BANNED = /幼崽|少年|少女|萝莉|正太|\bbaby\b|\bchild\b|成长阶段|成长进化|破壳而出/;

test('no growth stage or minor framing in display or prompt sources', () => {
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // migrate.js reads legacy save values ('baby' / 'child') to convert them; that is data, not display.
      if (f === 'core/migrate.js' && /baby: 0, child: 15/.test(line)) return;
      assert.doesNotMatch(line, BANNED, `${f}:${i + 1}: ${line.trim()}`);
    });
  }
});

test('"未成年" only appears inside the refusal rules of the system role', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hits = src.split('\n').filter((l) => /未成年/.test(l));
    for (const l of hits) assert.match(l, /一律拒绝/, `${f}: ${l.trim()}`);
  }
});

test('every species persona states an adult age', () => {
  const { SPECIES } = require('../src/core/species');
  for (const sp of Object.values(SPECIES)) assert.match(sp.personality, /成年/, sp.id);
});
