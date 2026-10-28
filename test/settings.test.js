'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../src/core/settings');

test('defaults: age gate pending, adult content off', () => {
  const d = s.normalizeSettings(null);
  assert.equal(d.ageConfirmed, false);
  assert.equal(d.adultContent, false);
  assert.equal(s.needsAgeGate(d), true);
});

test('answering 18+ turns adult content on; under 18 keeps it off and the switch refuses', () => {
  const adult = s.answerAgeGate(null, true, 123);
  assert.equal(adult.ageConfirmed, true);
  assert.equal(adult.ageConfirmedAt, 123);
  assert.equal(adult.adultContent, true);
  assert.equal(s.needsAgeGate(adult), false);
  const off = s.setAdultContent(adult, false);
  assert.equal(off.ok, true);
  assert.equal(off.settings.adultContent, false);
  const minor = s.answerAgeGate(null, false, 123);
  assert.equal(minor.adultContent, false);
  assert.equal(s.needsAgeGate(minor), false);
  const refused = s.setAdultContent(minor, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'age-not-confirmed');
});

test('a hand-edited file cannot turn adult content on without confirmation, and an old gate version asks again', () => {
  assert.equal(s.normalizeSettings({ adultContent: true }).adultContent, false);
  const old = { ageGateVersion: s.AGE_GATE_VERSION - 1, answered: true, ageConfirmed: true, adultContent: true };
  assert.equal(s.needsAgeGate(old), true);
  assert.equal(s.normalizeSettings(old).adultContent, false);
});

test('SettingsStore round-trips through settings.json and survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const st = new s.SettingsStore(dir);
  st.save(s.answerAgeGate(null, true, 5));
  const back = new s.SettingsStore(dir).load();
  assert.equal(back.ageConfirmed, true);
  assert.equal(back.adultContent, true);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  assert.equal(new s.SettingsStore(dir).load().adultContent, false);
});
