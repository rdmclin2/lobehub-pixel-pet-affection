'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const tz = require('../src/core/touch-zones');
const st = require('../src/core/pet-state');
const { AFFECTION_RULES } = require('../src/core/affection');
const { SPECIES, validateCharacter } = require('../src/core/species');
const { checkReply } = require('../src/core/content-guard');
const { PetService } = require('../src/main/pet-service');

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 30, 12, 0, 0).getTime(); // midday: no tuck-in window, not night
const SHIPPED = ['claude', 'gemini', 'gpt', 'grok', 'dafeiyu'];

function petAt(affection, speciesId = 'claude') {
  const pet = st.createPet({ speciesId, name: 'T', agentId: 'a', now: T0 });
  st.setAffectionForTest(pet, affection);
  pet.dailyCounts = { greet: 1 }; // the daily greet bonus is covered elsewhere; keep deltas readable
  pet.mood = 50; // no mood modifier (×0.5 below 25, ×1.2 from 75)
  return pet;
}

// ---- hit testing ------------------------------------------------------------------------------
test('a point in the middle of each zone hits that zone (default table)', () => {
  const at = (x, y) => tz.zoneAt(x, y);
  assert.equal(at(0.5, 0.03), 'head');
  assert.equal(at(0.15, 0.12), 'head'); // hair beside the face
  assert.equal(at(0.5, 0.12), 'face');
  assert.equal(at(0.5, 0.26), 'chest');
  assert.equal(at(0.5, 0.41), 'hands'); // folded in front
  assert.equal(at(0.1, 0.4), 'hands'); // arm / sleeve at her side
  assert.equal(at(0.9, 0.4), 'hands');
  assert.equal(at(0.25, 0.4), 'belly'); // between the folded hands and the arm
  assert.equal(at(0.5, 0.53), 'butt');
  assert.equal(at(0.5, 0.72), 'legs');
  assert.equal(at(0.5, 0.94), 'feet');
});

test('the five required parts are all reachable, for every shipped character', () => {
  for (const id of SHIPPED) {
    const hit = new Set();
    for (let y = 0; y <= 1; y += 0.01) for (let x = 0; x <= 1; x += 0.01) hit.add(tz.zoneAt(x, y, { character: SPECIES[id] }));
    for (const z of tz.REQUIRED_ZONES) assert.ok(hit.has(z), `${id}: ${z} unreachable`);
  }
});

test('zone boundaries: edges are inclusive and the first zone in order wins', () => {
  assert.equal(tz.zoneAt(0.5, 0.19), 'head'); // head ends at 0.19, chest starts there: head is tried first
  assert.equal(tz.zoneAt(0.5, 0.1901), 'chest');
  assert.equal(tz.zoneAt(0.5, 0.34), 'chest');
  assert.equal(tz.zoneAt(0.5, 0.3401), 'belly');
  assert.equal(tz.zoneAt(0.5, 0.36), 'hands'); // hands are tried before belly
  assert.equal(tz.zoneAt(0.5, 0.47), 'hands');
  assert.equal(tz.zoneAt(0.5, 0.4701), 'butt');
  assert.equal(tz.zoneAt(0.5, 0.6), 'butt');
  assert.equal(tz.zoneAt(0.5, 0.6001), 'legs');
  assert.equal(tz.zoneAt(0.5, 0.86), 'legs');
  assert.equal(tz.zoneAt(0.5, 0.8601), 'feet');
  assert.equal(tz.zoneAt(0.5, 1), 'feet');
  assert.equal(tz.zoneAt(0.3, 0.07), 'face');
  assert.equal(tz.zoneAt(0.2999, 0.07), 'head');
});

test('outside the box, transparent pixels and uncovered corners give null', () => {
  for (const [x, y] of [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.01], [0.5, 1.01], [NaN, 0.5], [0.5, Infinity]]) assert.equal(tz.zoneAt(x, y), null, `${x},${y}`);
  assert.equal(tz.zoneAt(0.5, 0.26, { opaque: false }), null);
  assert.equal(tz.zoneAt(0.02, 0.05), null); // beside the head
  assert.equal(tz.zoneAt(0.98, 0.25), null);
  assert.equal(tz.zoneAt(0.05, 0.95), null); // beside the shoes
});

test('a character file can add zones (a tail) and override per pose', () => {
  assert.equal(tz.zoneAt(0.92, 0.2), null);
  assert.equal(tz.zoneAt(0.92, 0.2, { character: SPECIES.gemini }), 'tail');
  assert.equal(tz.zoneAt(0.93, 0.8, { character: SPECIES.gpt }), 'tail');
  assert.equal(tz.zoneAt(0.93, 0.5, { character: SPECIES.dafeiyu }), 'tail');
  assert.equal(tz.zoneAt(0.5, 0.41, { character: SPECIES.gemini }), 'hands'); // the defaults still apply
  const lying = { touch: { poses: { sleep: { head: [[0, 0.4, 0.3, 0.6]] } } } };
  assert.equal(tz.zoneAt(0.1, 0.55, { character: lying, pose: 'sleep' }), 'head');
  assert.equal(tz.zoneAt(0.1, 0.55, { character: lying }), 'butt');
});

test('character touch blocks are validated', () => {
  assert.deepEqual(tz.validateTouch({ zones: { tail: [[0.8, 0.1, 1, 0.3]] } }), []);
  assert.match(tz.validateTouch({ zones: { wing: [[0, 0, 1, 1]] } })[0], /not a zone/);
  assert.match(tz.validateTouch({ zones: { head: [[0, 0, 2, 1]] } })[0], /0\.\.1/);
  assert.match(tz.validateTouch({ lines: { head: { low: ['a'], mid: [] , high: ['c'] } } })[0], /head\.mid/);
  assert.match(tz.validateTouch({ lines: { streak: { annoyed: ['a'] } } })[0], /streak\.angry/);
  for (const id of SHIPPED) assert.deepEqual(validateCharacter({ ...SPECIES[id], art: { kind: 'pack', packs: SPECIES[id].packs } }), [], id);
});

// ---- reactions and affection ------------------------------------------------------------------
test('each zone has its reaction: anim key touch-<zone> with an existing fx state to fall back to', () => {
  const fxStates = require('../src/core/fx').STATES;
  for (const z of tz.ZONE_IDS) for (const stage of ['stranger', 'close', 'lover']) {
    const r = tz.reactionFor(z, stage, 1);
    assert.equal(r.anim, `touch-${z}`);
    assert.ok(fxStates.includes(r.fallback), `${z}/${stage}: ${r.fallback}`);
    if (r.source) assert.ok(AFFECTION_RULES[r.source], `rule ${r.source}`);
  }
  assert.equal(tz.reactionFor('head', 'stranger').fallback, 'pat');
  assert.throws(() => tz.reactionFor('wing', 'stranger'), /Unknown touch zone/);
});

test('head / hands / feet: positive at every stage, with a cooldown and a daily max', () => {
  const pet = petAt(0);
  let r = st.touchBody(pet, 'head', T0);
  assert.equal(r.reaction.mood, 'happy');
  assert.equal(r.affection.delta, 1);
  assert.equal(pet.affection, 1);
  r = st.touchBody(pet, 'head', T0 + 30 * 1000); // 2nd poke, inside the 2-minute cooldown
  assert.equal(r.affection.delta, 0);
  assert.equal(r.affection.blocked, 'cooldown');
  r = st.touchBody(pet, 'head', T0 + 3 * MIN);
  assert.equal(r.affection.delta, 1);
  for (let i = 0; i < 10; i++) st.touchBody(pet, 'head', T0 + (6 + i * 3) * MIN);
  assert.equal(pet.dailyCounts['touch:head'], AFFECTION_RULES['touch:head'].dailyMax);
  r = st.touchBody(pet, 'head', T0 + 60 * MIN);
  assert.equal(r.affection.blocked, 'daily');
  // other zones have their own cooldowns
  pet.mood = 50; // all that patting cheered her up; keep the modifier out of it
  assert.equal(st.touchBody(pet, 'hands', T0 + 61 * MIN).affection.delta, 1);
  const f = st.touchBody(pet, 'feet', T0 + 62 * MIN);
  assert.equal(f.reaction.mood, 'ticklish');
  assert.equal(f.affection.delta, 0.5);
});

test('chest / butt: told off and penalised while not close, flustered when close, shy and slightly positive at the top', () => {
  for (const zone of ['chest', 'butt']) {
    const low = petAt(20); // familiar
    let r = st.touchBody(low, zone, T0);
    assert.equal(r.reaction.mood, 'angry');
    assert.equal(r.reaction.tier, 'low');
    assert.equal(r.affection.source, `touch_rude:${zone}`);
    assert.equal(r.affection.delta, -2);
    assert.equal(low.affection, 18);
    // the penalty has a cooldown: a burst of clicks costs it once
    r = st.touchBody(low, zone, T0 + 10 * 1000);
    assert.equal(r.affection.delta, 0);
    assert.equal(r.affection.blocked, 'cooldown');
    assert.equal(low.affection, 18);
    assert.equal(st.touchBody(low, zone, T0 + 2 * MIN).affection.delta, -2);

    const mid = petAt(40); // close
    r = st.touchBody(mid, zone, T0);
    assert.equal(r.reaction.mood, 'shy');
    assert.equal(r.reaction.source, null);
    assert.equal(r.affection, null);
    assert.equal(mid.affection, 40);

    const high = petAt(90); // lover / 挚友
    r = st.touchBody(high, zone, T0);
    assert.equal(r.reaction.mood, 'shy');
    assert.equal(r.reaction.tier, 'high');
    assert.equal(r.affection.delta, 0.5);
    assert.equal(st.touchBody(high, zone, T0 + 10 * MIN).affection.blocked, 'daily'); // once a day
  }
});

test('legs and tail are shy (no score) for strangers and positive once close', () => {
  const low = petAt(0);
  const r = st.touchBody(low, 'legs', T0);
  assert.equal(r.reaction.mood, 'shy');
  assert.equal(r.affection, null);
  assert.equal(st.touchBody(petAt(40), 'legs', T0).affection.delta, 0.5);
  assert.equal(st.touchBody(petAt(40), 'tail', T0).affection.delta, 0.5);
});

test('poking one spot again and again escalates: annoyed from the 3rd, angry (and a penalty) from the 6th', () => {
  const pet = petAt(40);
  const moods = [];
  for (let i = 0; i < 7; i++) {
    const r = st.touchBody(pet, 'head', T0 + i * 1000);
    moods.push(`${r.reaction.count}:${r.reaction.mood}${r.reaction.streak ? '/' + r.reaction.streak : ''}`);
  }
  assert.deepEqual(moods, ['1:happy', '2:happy', '3:annoyed/annoyed', '4:annoyed/annoyed', '5:annoyed/annoyed', '6:angry/angry', '7:angry/angry']);
  assert.equal(pet.lastAffectionAt['touch_rude:spam'], T0 + 5000);
  assert.equal(pet.affection, 40 + 1 - 1); // +1 for the first pat, −1 once for the spam (cooldown)
  // a pause, or another spot, starts a new streak
  assert.equal(st.touchBody(pet, 'head', T0 + 7000 + tz.STREAK.windowMs + 1).reaction.count, 1);
  assert.equal(st.touchBody(pet, 'hands', T0 + 30000).reaction.count, 1);
});

test('a stranger poking her chest repeatedly stays angry (one rude penalty per cooldown)', () => {
  const pet = petAt(10);
  for (let i = 0; i < 7; i++) assert.equal(st.touchBody(pet, 'chest', T0 + i * 1000).reaction.mood, 'angry');
  assert.equal(pet.affection, 8);
});

test('touching a sleeping pet wakes her (and costs the woken penalty) before reacting', () => {
  const pet = petAt(40);
  pet.sleeping = true;
  const r = st.touchBody(pet, 'head', T0);
  assert.equal(r.woken, 'woken');
  assert.equal(pet.sleeping, false);
  assert.equal(r.affection.delta, -2 + 1);
});

// ---- lines ------------------------------------------------------------------------------------
test('every shipped character has at least 3 lines per required zone, and lines for every stage tier', () => {
  for (const id of SHIPPED) {
    const lines = SPECIES[id].touch.lines;
    for (const z of tz.REQUIRED_ZONES) {
      const all = tz.TIERS.flatMap((t) => lines[z][t]);
      assert.ok(all.length >= 3, `${id}.${z}: ${all.length}`);
      for (const t of tz.TIERS) assert.ok(lines[z][t].length >= 1, `${id}.${z}.${t}`);
    }
    assert.ok(lines.streak.annoyed.length >= 1 && lines.streak.angry.length >= 1, `${id} streak`);
  }
});

test('the line follows the tier and the streak; characters differ', () => {
  const sp = SPECIES.claude;
  const pick = (zone, stage, count = 1) => tz.touchLines(sp, tz.reactionFor(zone, stage, count));
  assert.deepEqual(pick('chest', 'stranger'), sp.touch.lines.chest.low);
  assert.deepEqual(pick('chest', 'close'), sp.touch.lines.chest.mid);
  assert.deepEqual(pick('chest', 'lover'), sp.touch.lines.chest.high);
  assert.deepEqual(pick('head', 'close', 3), sp.touch.lines.streak.annoyed);
  assert.deepEqual(pick('head', 'close', 6), sp.touch.lines.streak.angry);
  assert.notDeepEqual(tz.touchLines(SPECIES.grok, tz.reactionFor('head', 'stranger')), pick('head', 'stranger'));
  // a character without her own lines falls back to the generic ones
  assert.deepEqual(tz.touchLines(SPECIES.testchan, tz.reactionFor('feet', 'close')), tz.DEFAULT_LINES.feet.mid);
});

test('adult touch lines only for a character that allows it, with adult content on; never for the shipped ones', () => {
  const on = { ageConfirmed: true, adultContent: true };
  const r = tz.reactionFor('chest', 'lover');
  assert.ok(tz.touchLines(SPECIES.testchan, r, on).some((l) => tz.ADULT_LINES.chest.high.includes(l)));
  for (const settings of [null, { ageConfirmed: true, adultContent: false }]) assert.ok(!tz.touchLines(SPECIES.testchan, r, settings).some((l) => tz.ADULT_LINES.chest.high.includes(l)));
  for (const id of SHIPPED) for (const z of tz.ZONE_IDS) for (const stage of ['stranger', 'close', 'lover']) {
    const lines = tz.touchLines(SPECIES[id], tz.reactionFor(z, stage), on);
    const adult = Object.values(tz.ADULT_LINES).flatMap((x) => Object.values(x).flat());
    assert.ok(!lines.some((l) => adult.includes(l)), `${id}.${z}.${stage}`);
  }
});

test('every touch line passes the content guard and the compliance word list', () => {
  const BANNED = /幼崽|少年|少女|萝莉|正太|宝宝|校服|\bbaby\b|\bchild\b|成长阶段|成长进化|破壳|孵化|[一二三四火水草鲸]之?蛋|擦边|未成年|学生/;
  const collect = (lines) => Object.values(lines).flatMap((v) => Object.values(v).flat());
  const all = [...collect(tz.DEFAULT_LINES), ...collect(tz.ADULT_LINES), ...SHIPPED.flatMap((id) => collect(SPECIES[id].touch.lines))];
  assert.ok(all.length > 200, `${all.length} lines`);
  for (const l of all) {
    assert.equal(checkReply(l).ok, true, l);
    assert.doesNotMatch(l, BANNED, l);
  }
});

test('touchLine avoids repeating the last line when there is a choice', () => {
  const r = tz.reactionFor('head', 'stranger');
  const pool = tz.touchLines(SPECIES.claude, r);
  for (let i = 0; i < 20; i++) assert.notEqual(tz.touchLine(SPECIES.claude, r, { rnd: () => 0, last: pool[0] }), pool[0]);
});

// ---- the service ------------------------------------------------------------------------------
function service(affection = 0, speciesId = 'grok') {
  const said = [];
  const scored = [];
  let t = T0;
  const svc = new PetService({ lh: { setWorkspace() {} }, store: { save() {}, load: () => null }, now: () => t, rnd: () => 0 });
  svc.pet = petAt(affection, speciesId);
  svc.on('say', (s) => said.push(s));
  svc.on('affection', (a) => scored.push(a));
  return { svc, said, scored, advance: (ms) => { t += ms; } };
}

test('PetService.touch(zone) returns { zone, reaction, line, affection } and says the line offline', () => {
  const { svc, said, scored } = service(0);
  const r = svc.touch('head');
  assert.equal(r.ok, true);
  assert.equal(r.zone, 'head');
  assert.equal(r.reaction.mood, 'happy');
  assert.ok(SPECIES.grok.touch.lines.head.low.includes(r.line));
  assert.deepEqual(r.affection, { source: 'touch:head', delta: 1, blocked: null, value: 1, stage: 'stranger' });
  assert.equal(said.at(-1).text, r.line);
  assert.equal(said.at(-1).kind, 'touch:head');
  assert.equal(said.at(-1).source, 'fallback');
  assert.equal(scored.at(-1).source, 'touch:head');
});

test('PetService.touch resolves a click point with the character table; a miss changes nothing', () => {
  const { svc, said } = service(20, 'gemini');
  assert.equal(svc.touch({ x: 0.5, y: 0.26 }).zone, 'chest');
  assert.equal(svc.touch({ x: 0.92, y: 0.2 }).zone, 'tail');
  const before = svc.pet.affection;
  const n = said.length;
  assert.deepEqual(svc.touch({ x: 0.02, y: 0.02 }), { ok: false, reason: 'miss', zone: null });
  assert.deepEqual(svc.touch({ x: 0.5, y: 0.5, opaque: false }), { ok: false, reason: 'miss', zone: null });
  assert.equal(svc.pet.affection, before);
  assert.equal(said.length, n);
  assert.equal(svc.touch('wing').reason, 'unknown-zone');
});

test('PetService: no target = head; act("touch", zone) works; act("pat") is unchanged', () => {
  const { svc, advance } = service(0);
  assert.equal(svc.touch().zone, 'head');
  assert.equal(svc.touch(null).zone, 'head');
  advance(10 * MIN);
  assert.equal(svc.act('touch', 'feet').zone, 'feet');
  advance(10 * MIN);
  const pat = svc.act('pat');
  assert.equal(pat.ok, true);
  assert.equal(pat.affection.source, 'pat');
  assert.equal(pat.zone, undefined);
  svc.busy = true;
  assert.equal(svc.touch('head').reason, 'busy');
});

test('PetService: low-stage chest touch reports the penalty, repeated pokes get the streak line', () => {
  const { svc } = service(20, 'dafeiyu');
  const r = svc.touch('chest');
  assert.equal(r.reaction.mood, 'angry');
  assert.equal(r.affection.delta, -2);
  assert.equal(r.affection.value, 18);
  assert.ok(SPECIES.dafeiyu.touch.lines.chest.low.includes(r.line));
  svc.touch('feet');
  svc.touch('feet');
  const third = svc.touch('feet');
  assert.equal(third.reaction.streak, 'annoyed');
  assert.ok(SPECIES.dafeiyu.touch.lines.streak.annoyed.includes(third.line));
});
