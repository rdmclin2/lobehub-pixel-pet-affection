'use strict';
// AI 可读的文件夹 (T-5075, core/ai-folders.js, docs/permissions.md): the stored list is normalised; the local tools
// stay inside it (`..` and symlinks resolved first); commands need their own switch; while the list is in
// effect a turn never hands its tools to `lh connect`; and the 授权 page's macOS permissions (main/permissions.js).
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('../src/core/ai-folders');
const settingsLib = require('../src/core/settings');
const { runLocalTool, functionToolsFor, LOCAL_FUNCTION_TOOLS, ResponsesClient } = require('../src/core/responses-client');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const { createPermissions, fakeMac, SETTINGS_URL } = require('../src/main/permissions');
const { startFakeResponses } = require('./fixtures/fake-responses-server');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const signal = new AbortController().signal;
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const runs = (dir) => (fs.existsSync(path.join(dir, 'runs.log')) ? fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

// ---- the stored list -------------------------------------------------------------------------------------
test('normalizeFolders: absolute, ~ expanded, .. collapsed, no trailing slash, no repeats, no folder inside another, junk dropped', () => {
  const home = '/home/me';
  assert.deepEqual(F.normalizeFolders(['~/Documents/', '/data/a/../b', '/data/b', '/data/b/sub', 'relative/x', '', '  ', 42, null, '/bad\0path', '~'], { home }), ['/data/b', '/home/me'], '~/Documents is inside ~ (added later), so only ~ stays');
  assert.deepEqual(F.normalizeFolders(['/x/y', '/x'], { home }), ['/x'], 'a later parent swallows an earlier child');
  assert.equal(F.normalizeFolders(null), null, 'null = no limit stays null');
  assert.deepEqual(F.normalizeFolders('nope'), []);
  assert.equal(F.normalizeFolders(Array.from({ length: 80 }, (_, i) => `/f${i}`)).length, F.MAX_FOLDERS);
  assert.equal(F.isInside('/a/b', '/a'), true);
  assert.equal(F.isInside('/a', '/a'), true);
  assert.equal(F.isInside('/ab', '/a'), false, 'a sibling with the same prefix is outside');
  assert.equal(F.isInside('/a/../b', '/a'), false);
});

test('settings: local is normalised; a file without it means "not decided"; decideLocal keeps old 本机能力 owners unlimited, everyone else strict', () => {
  assert.deepEqual(settingsLib.normalizeSettings(null).local, { folders: null, allowCommands: null, asked: [] });
  assert.deepEqual(settingsLib.normalizeSettings({ local: { folders: ['/a/', '/a/b'], allowCommands: 'yes', asked: ['downloads', 'camera', 'downloads'] } }).local, { folders: ['/a'], allowCommands: null, asked: ['downloads'] });
  assert.deepEqual(F.decideLocal(undefined, { localOn: true }), { folders: null, allowCommands: true, asked: [] }, 'had 本机能力 on: as before until a folder is added');
  assert.deepEqual(F.decideLocal(undefined, { localOn: false }), { folders: [], allowCommands: false, asked: [] }, 'everyone else: no folder, no commands');
  assert.deepEqual(F.decideLocal({ folders: ['/x'], allowCommands: true }, { localOn: false }).folders, ['/x'], 'a decided list is kept');
  // adding the first folder to an unlimited list starts the limit
  assert.deepEqual(F.addFolders({ folders: null, allowCommands: true }, ['/w']).folders, ['/w']);
  assert.deepEqual(F.removeFolder({ folders: ['/w', '/v'] }, '/w/').folders, ['/v']);
  assert.equal(F.toolScope({ folders: null }), null);
  assert.deepEqual(F.toolScope({ folders: ['/w'], allowCommands: true }, { extraRead: ['/drop/a.txt'] }), { folders: ['/w'], allowCommands: true, extraRead: ['/drop/a.txt'] });
});

// ---- the path check ------------------------------------------------------------------------------------
test('checkPath: inside passes; .. and symlinks that lead out are refused; a new file is checked through its real parent; empty list refuses', async () => {
  const root = tmp('aif-root-');
  const outside = tmp('aif-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'yes');
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret-link.txt'));
  const scope = { folders: [root], allowCommands: false, extraRead: [] };
  assert.equal(await F.checkPath(path.join(root, 'docs', 'a.txt'), scope), path.join(root, 'docs', 'a.txt'));
  assert.equal(await F.checkPath(path.join(root, 'docs', 'new', 'deep.txt'), scope, { write: true }), path.join(root, 'docs', 'new', 'deep.txt'), 'a file that does not exist yet');
  await assert.rejects(F.checkPath(path.join(root, '..', path.basename(outside), 'secret.txt'), scope), { code: 'EOUTSIDE' });
  await assert.rejects(F.checkPath(path.join(root, 'link-out', 'secret.txt'), scope), { code: 'EOUTSIDE' }, 'a symlinked folder leading out');
  await assert.rejects(F.checkPath(path.join(root, 'secret-link.txt'), scope), { code: 'EOUTSIDE' }, 'a symlinked file leading out');
  await assert.rejects(F.checkPath(path.join(root, 'link-out', 'new.txt'), scope, { write: true }), { code: 'EOUTSIDE' }, 'a new file under a symlinked folder');
  await assert.rejects(F.checkPath('docs/a.txt', scope), { code: 'EOUTSIDE' }, 'relative paths are refused');
  await assert.rejects(F.checkPath(path.join(root, 'docs', 'a.txt'), { folders: [], allowCommands: false, extraRead: [] }), /not allowed any folder yet/);
  // no limit (null): anywhere, as before
  assert.equal(await F.checkPath(path.join(outside, 'secret.txt'), null), path.join(outside, 'secret.txt'));
  // what the owner dropped onto her this turn: readable, not writable
  const dropped = { ...scope, extraRead: [path.join(outside, 'secret.txt')] };
  assert.equal(await F.checkPath(path.join(outside, 'secret.txt'), dropped), path.join(outside, 'secret.txt'));
  await assert.rejects(F.checkPath(path.join(outside, 'secret.txt'), dropped, { write: true }), { code: 'EOUTSIDE' });
});

test('runLocalTool with a scope: read / list / write stay inside; run_command needs allowCommands and a cwd inside (default: the first folder)', async () => {
  const root = tmp('aif-tool-');
  const outside = tmp('aif-tool-out-');
  fs.writeFileSync(path.join(outside, 'o.txt'), 'outside');
  const strict = { folders: [root], allowCommands: false, extraRead: [] };
  assert.match(await runLocalTool('write_file', { path: path.join(root, 'n', 'a.txt'), content: 'hi' }, signal, strict), /wrote 2 bytes/);
  assert.equal(await runLocalTool('read_file', { path: path.join(root, 'n', 'a.txt') }, signal, strict), 'hi');
  assert.equal(await runLocalTool('list_directory', { path: root }, signal, strict), 'n/');
  await assert.rejects(runLocalTool('read_file', { path: path.join(outside, 'o.txt') }, signal, strict), /outside the folders the owner allowed/);
  await assert.rejects(runLocalTool('list_directory', { path: outside }, signal, strict), /outside/);
  await assert.rejects(runLocalTool('write_file', { path: path.join(outside, 'x.txt'), content: 'x' }, signal, strict), /outside/);
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
  await assert.rejects(runLocalTool('run_command', { command: 'echo hi' }, signal, strict), /running commands is turned off/);
  const cmds = { ...strict, allowCommands: true };
  const pwd = process.platform === 'win32' ? 'cd' : 'pwd';
  assert.equal((await runLocalTool('run_command', { command: pwd }, signal, cmds)).trim(), `exit 0\n${root}`, 'default cwd: the first folder');
  await assert.rejects(runLocalTool('run_command', { command: pwd, cwd: outside }, signal, cmds), /outside/);
  await assert.rejects(runLocalTool('run_command', { command: 'echo' }, signal, { folders: [], allowCommands: true, extraRead: [] }), /not allowed any folder yet/);
});

test('functionToolsFor: no scope = the four tools as before; with one, run_command only when allowed and every description names the folders', () => {
  assert.equal(functionToolsFor(null), LOCAL_FUNCTION_TOOLS);
  const off = functionToolsFor({ folders: ['/w'], allowCommands: false, extraRead: [] });
  assert.deepEqual(off.map((t) => t.name), ['read_file', 'list_directory', 'write_file']);
  for (const t of off) assert.match(t.description, /\/w/);
  const on = functionToolsFor({ folders: ['/w'], allowCommands: true, extraRead: [] });
  assert.deepEqual(on.map((t) => t.name), ['read_file', 'list_directory', 'write_file', 'run_command']);
  assert.match(on[3].description, /cwd must be inside an allowed folder \(default: \/w\)/);
});

// ---- PetService: deciding once, editing, and how a turn is routed --------------------------------------------
const servers = [];
test.after(() => { for (const s of servers) s.close(); });
async function service({ available = true, plan = () => ({ pieces: ['好'] }), settings = null, pet = null } = {}) {
  const dir = tmp('aif-svc-');
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const srv = await startFakeResponses(plan);
  servers.push(srv);
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const env = available ? { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'k' } : { LOBEHUB_SERVER: srv.url };
  const store = new Store(path.join(dir, 'data'));
  if (pet) store.save(pet);
  const settingsStore = new settingsLib.MemorySettingsStore(settings);
  const svc = new PetService({ lh, responses: new ResponsesClient({ lh, env, readCredentials: () => null }), store, settingsStore, rnd: () => 0.5 });
  svc.on('error', () => {});
  svc.init();
  return { dir, srv, svc, settingsStore };
}

test('init decides once: a fresh install starts strict; an owner who had 本机能力 on keeps no limit (and commands) until adding a folder', async (t) => {
  const fresh = await service();
  t.after(() => fresh.srv.close());
  assert.deepEqual(fresh.svc.settings.local, { folders: [], allowCommands: false, asked: [] });
  assert.deepEqual(fresh.settingsStore.data.local, { folders: [], allowCommands: false, asked: [] }, 'saved');

  const { svc: first } = await service({ settings: { local: { folders: [], allowCommands: false } } });
  await first.hatch({ speciesId: 'testchan', name: 'E', localAbilities: true });
  const legacyPet = JSON.parse(JSON.stringify(first.pet));
  const old = await service({ pet: legacyPet });
  t.after(() => old.srv.close());
  assert.deepEqual(old.svc.settings.local, { folders: null, allowCommands: true, asked: [] });
  assert.equal(old.svc.view().local.limited, false);
  // decided: a later start does not decide again
  old.svc.setAiFolders({ add: ['/tmp/aif-legacy'] });
  assert.deepEqual(old.svc.settings.local, { folders: ['/tmp/aif-legacy'], allowCommands: true, asked: [] });
  old.svc.init();
  assert.deepEqual(old.svc.settings.local.folders, ['/tmp/aif-legacy']);
  assert.equal(old.svc.view().local.limited, true);
  old.svc.setAiFolders({ remove: '/tmp/aif-legacy/', allowCommands: false });
  assert.deepEqual(old.svc.settings.local, { folders: [], allowCommands: false, asked: [] });
});

const callTool = (name, args) => ({ json: { id: 'tpc_T', status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(args) }] } });

test('limited list, direct way: the tools run here inside the folders; run_command is not offered; a path outside comes back as an error', async (t) => {
  const root = tmp('aif-turn-');
  const outside = tmp('aif-turn-out-');
  fs.writeFileSync(path.join(root, 'in.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'o.txt'), 'outside');
  const plan = (body) => {
    if (!body.tools.length || (!Array.isArray(body.input) && !body.input.includes('看看'))) return { pieces: ['嗨'] };
    if (!Array.isArray(body.input)) return callTool('read_file', { path: path.join(outside, 'o.txt') });
    if (body.input[0].output.startsWith('Error')) return callTool('read_file', { path: path.join(root, 'in.txt') });
    return { pieces: ['读到了'] };
  };
  const { srv, svc, dir } = await service({ plan });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E', localAbilities: true });
  assert.equal(svc.localVia, 'direct');
  svc.setAiFolders({ add: [root] });
  const r = await svc.chat('看看');
  assert.equal(r.ok, true);
  const bodies = srv.requests.map((q) => q.body);
  const withTools = bodies.slice(bodies.findIndex((b) => typeof b.input === 'string' && b.input.includes('看看')));
  assert.deepEqual(withTools[0].tools.map((x) => x.name), ['read_file', 'list_directory', 'write_file']);
  assert.match(withTools[0].input, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'the prompt names the folders');
  assert.match(withTools[1].input[0].output, /^Error: path is outside the folders the owner allowed/);
  assert.equal(withTools[2].input[0].output, 'inside');
  assert.equal(runs(dir).filter((x) => x.tools && x.tools.length).length, 0, 'nothing through lh connect');
});

test('limited list: no direct way → the turn goes without tools (never through lh connect) and says why; a failed direct turn falls back the same way', async (t) => {
  const { srv, svc, dir } = await service({ available: false });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([{ deviceId: 'dev_X', hostname: 'h', platform: process.platform, online: true, channels: [] }]));
  await svc.setLocalAbilities(true);
  assert.notEqual(svc.localVia, 'direct');
  svc.setAiFolders({ add: ['/tmp'] });
  assert.equal((await svc.chat('看看')).ok, true);
  const run = runs(dir).pop();
  assert.deepEqual(run.tools || [], [], 'no --tool');
  assert.ok(!run.device, 'no --device');
  assert.match(svc.view().local.warning, /这次用不了本机工具/);

  // direct way up but failing before any tool ran: same turn, no tools, through lh agent run
  let fail = true;
  const b = await service({ plan: () => (fail ? { status: 502, body: 'bad' } : { pieces: ['好'] }) });
  t.after(() => b.srv.close());
  fail = false;
  await b.svc.hatch({ speciesId: 'testchan', name: 'E', localAbilities: true });
  b.svc.setAiFolders({ add: ['/tmp'] });
  fail = true;
  const before = runs(b.dir).length;
  assert.equal((await b.svc.chat('看看')).ok, true);
  const fallback = runs(b.dir).slice(before);
  assert.equal(fallback.length, 1);
  assert.deepEqual(fallback[0].tools || [], []);
  assert.ok(!fallback[0].device);
  assert.match(b.svc.view().local.warning, /这次用不了本机工具/);
});

test('no limit (an old 本机能力 owner): the turn still falls back to lh connect with its tools, as before', async (t) => {
  const { srv, svc, dir } = await service({ available: false, settings: { local: { folders: null, allowCommands: true } } });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([{ deviceId: 'dev_X', hostname: 'h', platform: process.platform, online: true, channels: [] }]));
  await svc.setLocalAbilities(true);
  await svc.chat('看看');
  const run = runs(dir).pop();
  assert.deepEqual(run.tools, ['lobe-local-system']);
  assert.equal(run.device, 'dev_X');
});

// ---- the 授权 page (main/permissions.js) ---------------------------------------------------------------------
test('permissions on macOS (faked): 麦克风 read quietly and asked on 授权; a folder is unknown until 授权, then granted and added, or denied with the System Settings link', async (t) => {
  const home = tmp('aif-home-');
  for (const d of ['Downloads', 'Desktop', 'Documents']) fs.mkdirSync(path.join(home, d));
  const { srv, svc } = await service();
  t.after(() => srv.close());
  const mac = fakeMac({ mic: 'not-determined', micAnswer: true, folders: { downloads: 'grant', desktop: 'deny' }, home });
  const p = createPermissions({ service: svc, platform: 'darwin', ...mac });
  let st = await p.status();
  assert.equal(st.mac, true);
  assert.equal(st.mic, 'not-determined');
  assert.deepEqual(st.folders.map((f) => [f.id, f.status]), [['downloads', 'unknown'], ['desktop', 'unknown'], ['documents', 'unknown']]);
  st = await p.request('microphone');
  assert.equal(st.result, 'granted');
  assert.equal(st.mic, 'granted');
  st = await p.request('downloads');
  assert.equal(st.result, 'granted');
  assert.deepEqual(st.local.folders, [path.join(home, 'Downloads')], 'a granted folder joins her list');
  assert.equal(st.folders[0].inList, true);
  st = await p.request('desktop');
  assert.equal(st.result, 'denied');
  assert.deepEqual(st.local.folders, [path.join(home, 'Downloads')], 'a refused one does not');
  assert.deepEqual(svc.settings.local.asked, ['downloads', 'desktop']);
  // asked before: read quietly from now on
  st = await p.status();
  assert.deepEqual(st.folders.map((f) => [f.id, f.status]), [['downloads', 'granted'], ['desktop', 'denied'], ['documents', 'unknown']]);
  assert.deepEqual(await p.openSettings('desktop'), { ok: true, url: SETTINGS_URL.folders });
  assert.deepEqual(await p.openSettings('microphone'), { ok: true, url: SETTINGS_URL.microphone });
  assert.deepEqual(mac.opened, [SETTINGS_URL.folders, SETTINGS_URL.microphone]);
  // removing it from her list does not touch the system permission
  st = await p.setFolders({ remove: path.join(home, 'Downloads') });
  assert.deepEqual(st.local.folders, []);
  assert.equal(st.folders[0].status, 'granted');
});

test('permissions elsewhere: no system rows (mac false, no mic), only the folder list; 添加文件夹… adds what the picker returns', async (t) => {
  const { srv, svc } = await service();
  t.after(() => srv.close());
  const picks = [['/data/a', '/data/a/b', 'relative'], []];
  const p = createPermissions({ service: svc, platform: 'linux', pickFolders: async () => picks.shift() });
  let st = await p.status();
  assert.equal(st.mac, false);
  assert.equal(st.mic, null);
  assert.deepEqual(st.folders, []);
  assert.equal((await p.request('microphone')).reason, 'not-mac');
  st = await p.addFolders();
  assert.deepEqual(st.local.folders, ['/data/a']);
  st = await p.addFolders(); // canceled
  assert.deepEqual(st.local.folders, ['/data/a']);
  st = await p.setFolders({ allowCommands: true });
  assert.equal(st.local.allowCommands, true);
});
