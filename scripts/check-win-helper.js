#!/usr/bin/env node
'use strict';
// Checks the Windows desktop-wallpaper helper exe (docs/wallpaper-mode.md §1.1, §6.2). Prints the evidence; exit 1 on
// any failed check.
//
//   node scripts/check-win-helper.js [exe]         PE structure (PE32+, x64, console, ASLR/NX), the import table
//                                                  (user32 SendMessageTimeoutW / SetParent / FindWindowExW …), and
//                                                  sha256 = src/main/wallpaper/helper.json (default exe:
//                                                  build/win-helper/pixelpet-desktop-helper.exe)
//   … --wine                                       also run it under wine: --version, --self-test, and the stdin
//                                                  protocol through the app's own HelperClient (win-helper.js)
//   … --package dist/win-unpacked                  the packaged app: resources/pixelpet-desktop-helper.exe exists,
//                                                  is the same file, and its sha256 = helper.json inside app.asar
//   … --installer dist/<name>-setup.exe            the NSIS installer carries the exe (7z listing, needs 7za)
//
// No objdump needed: the PE and its import directory are read here, so it runs on the Windows CI runner too.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE_NAME = 'pixelpet-desktop-helper.exe';
const DEFAULT_EXE = path.join(ROOT, 'build/win-helper', EXE_NAME);
const MANIFEST = path.join(ROOT, 'src/main/wallpaper/helper.json');
// what the helper must import for the WorkerW attach (desktop-helper.c); a build missing one is not this helper
const REQUIRED_IMPORTS = {
  'USER32.dll': ['SendMessageTimeoutW', 'SetParent', 'FindWindowExW', 'FindWindowW', 'EnumWindows', 'SetWindowPos', 'SetWindowLongPtrW', 'GetWindowLongPtrW', 'RegisterWindowMessageW', 'SystemParametersInfoW', 'SetProcessDpiAwarenessContext'],
  'SHELL32.dll': ['SHQueryUserNotificationState'],
  'WTSAPI32.dll': ['WTSRegisterSessionNotification'],
  'KERNEL32.dll': ['CreateThread', 'GetProcAddress'],
};
// none of these: no hooks, no injection, no network (the helper's promise in desktop-helper.c)
const FORBIDDEN_IMPORTS = ['SetWindowsHookExW', 'SetWindowsHookExA', 'WriteProcessMemory', 'CreateRemoteThread', 'VirtualAllocEx', 'WSAStartup', 'InternetOpenW', 'WinHttpOpen', 'URLDownloadToFileW'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures += 1; return ok; };

// ---- PE reader ---------------------------------------------------------------------------------------------------
function parsePE(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('no MZ header');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('no PE signature');
  const coff = pe + 4;
  const machine = buf.readUInt16LE(coff);
  const nSections = buf.readUInt16LE(coff + 2);
  const timestamp = buf.readUInt32LE(coff + 4);
  const optSize = buf.readUInt16LE(coff + 16);
  const characteristics = buf.readUInt16LE(coff + 18);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x20b) throw new Error(`not PE32+ (optional header magic 0x${magic.toString(16)})`);
  const subsystem = buf.readUInt16LE(opt + 68);
  const dllCharacteristics = buf.readUInt16LE(opt + 70);
  const nDirs = buf.readUInt32LE(opt + 108);
  const dir = (i) => (i < nDirs ? { rva: buf.readUInt32LE(opt + 112 + i * 8), size: buf.readUInt32LE(opt + 116 + i * 8) } : { rva: 0, size: 0 });
  const sections = [];
  for (let i = 0, s = opt + optSize; i < nSections; i += 1, s += 40) {
    sections.push({ name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''), vsize: buf.readUInt32LE(s + 8), rva: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
  }
  const off = (rva) => {
    const s = sections.find((x) => rva >= x.rva && rva < x.rva + Math.max(x.vsize, x.rawSize));
    if (!s) throw new Error(`rva 0x${rva.toString(16)} outside every section`);
    return rva - s.rva + s.raw;
  };
  const cstr = (o) => buf.toString('latin1', o, buf.indexOf(0, o));
  const imports = {};
  const imp = dir(1);
  if (imp.rva) {
    for (let d = off(imp.rva); ; d += 20) {
      const lookup = buf.readUInt32LE(d) || buf.readUInt32LE(d + 16);
      const nameRva = buf.readUInt32LE(d + 12);
      if (!lookup && !nameRva) break;
      const fns = [];
      for (let t = off(lookup); ; t += 8) {
        const v = buf.readBigUInt64LE(t);
        if (v === 0n) break;
        if (v & 0x8000000000000000n) fns.push(`#${Number(v & 0xffffn)}`); else fns.push(cstr(off(Number(v & 0x7fffffffn)) + 2));
      }
      imports[cstr(off(nameRva))] = fns;
    }
  }
  return { machine, timestamp, characteristics, subsystem, dllCharacteristics, sections: sections.map((s) => s.name), imports };
}

function findImport(imports, dll, fn) {
  const key = Object.keys(imports).find((k) => k.toLowerCase() === dll.toLowerCase());
  return !!key && imports[key].includes(fn);
}

function checkExe(exe) {
  console.log(`== ${path.relative(process.cwd(), exe) || exe}`);
  if (!check(fs.existsSync(exe), `exe exists (${exe})`)) return null;
  const buf = fs.readFileSync(exe);
  let pe;
  try { pe = parsePE(buf); } catch (e) { check(false, `PE parses: ${e.message}`); return null; }
  check(true, `PE parses: MZ + "PE\\0\\0" + PE32+ optional header, ${buf.length} bytes, sections ${pe.sections.join(' ')}`);
  check(pe.machine === 0x8664, `machine 0x${pe.machine.toString(16)} (IMAGE_FILE_MACHINE_AMD64 = 0x8664)`);
  check(pe.subsystem === 3, `subsystem ${pe.subsystem} (IMAGE_SUBSYSTEM_WINDOWS_CUI = 3: stdin / stdout pipes)`);
  check((pe.characteristics & 0x2) !== 0 && (pe.characteristics & 0x2000) === 0, `characteristics 0x${pe.characteristics.toString(16)} (EXECUTABLE_IMAGE, not a DLL)`);
  check((pe.dllCharacteristics & 0x40) !== 0 && (pe.dllCharacteristics & 0x100) !== 0, `DllCharacteristics 0x${pe.dllCharacteristics.toString(16)} (DYNAMIC_BASE 0x40 + NX_COMPAT 0x100${pe.dllCharacteristics & 0x20 ? ' + HIGH_ENTROPY_VA 0x20' : ''})`);
  check(pe.timestamp === 0, `COFF timestamp ${pe.timestamp} (0: reproducible build)`);
  console.log('      imports:');
  for (const [dll, fns] of Object.entries(pe.imports)) console.log(`        ${dll}: ${fns.join(', ')}`);
  for (const [dll, fns] of Object.entries(REQUIRED_IMPORTS)) {
    const missing = fns.filter((f) => !findImport(pe.imports, dll, f));
    check(missing.length === 0, `${dll} imports ${fns.join(' ')}${missing.length ? ` — MISSING ${missing.join(' ')}` : ''}`);
  }
  const bad = Object.values(pe.imports).flat().filter((f) => FORBIDDEN_IMPORTS.includes(f));
  check(bad.length === 0, `no hook / injection / network imports${bad.length ? ` — FOUND ${bad.join(' ')}` : ''}`);
  const dlls = Object.keys(pe.imports).map((d) => d.toLowerCase());
  const extra = dlls.filter((d) => !['kernel32.dll', 'user32.dll', 'shell32.dll', 'wtsapi32.dll', 'msvcrt.dll'].includes(d) && !d.startsWith('api-ms-win-crt-'));
  check(extra.length === 0, `only system DLLs (no libgcc / libwinpthread to ship)${extra.length ? ` — EXTRA ${extra.join(' ')}` : ''}`);
  // the resources from desktop-helper.rc: the manifest (asInvoker, PerMonitorV2) and the version strings (UTF-16)
  const ascii = buf.toString('latin1');
  check(ascii.includes('level="asInvoker"') && ascii.includes('PerMonitorV2'), 'embedded manifest: requestedExecutionLevel asInvoker, dpiAwareness PerMonitorV2');
  const u16 = (t) => buf.includes(Buffer.from(t, 'utf16le'));
  check(u16('Pixel Pet 桌面壁纸助手') && u16('pixelpet-desktop-helper.exe') && u16('Pixel Pet Affection'), 'version resource: FileDescription「Pixel Pet 桌面壁纸助手」, OriginalFilename, ProductName');
  return { sha: sha256(buf), pe };
}

function checkSha(sha, manifest, where) {
  check(!!manifest && /^[0-9a-f]{64}$/.test(manifest.sha256 || ''), `${where} has a sha256 (${manifest && manifest.sha256})`);
  check(!!manifest && manifest.sha256 === sha, `exe sha256 ${sha} = ${where}`);
}

// ---- wine --------------------------------------------------------------------------------------------------------
function wineCmd() {
  for (const c of [process.env.WINE, 'wine', 'wine64'].filter(Boolean)) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch { /* next */ }
  }
  return null;
}

async function runWine(exe) {
  const wine = wineCmd();
  if (!check(!!wine, `wine available (${wine || 'none: apt-get install wine64'})`)) return;
  const env = { ...process.env, WINEDEBUG: process.env.WINEDEBUG || '-all' };
  console.log(`      $ ${execFileSync(wine, ['--version'], { encoding: 'utf8' }).trim()}`);
  const run = (args) => {
    try { return { code: 0, out: execFileSync(wine, [exe, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }) }; } catch (e) { return { code: e.status, out: String(e.stdout || '') }; }
  };
  const lines = (s) => s.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  const v = run(['--version']);
  console.log(`      wine ${EXE_NAME} --version → exit ${v.code}\n        ${lines(v.out).join('\n        ')}`);
  const vj = lines(v.out).map((l) => JSON.parse(l))[0] || {};
  check(v.code === 0 && vj.version && vj.arch === 'x64', '--version answers {version, arch: x64}, exit 0');
  const st = run(['--self-test']);
  console.log(`      wine ${EXE_NAME} --self-test → exit ${st.code}\n        ${lines(st.out).join('\n        ')}`);
  const sj = lines(st.out).map((l) => JSON.parse(l));
  const rep = sj.find((m) => m.selfTest) || {};
  check(st.code === 0 && rep.parser === true && rep.parserErrors === 0 && rep.ptrBits === 64, '--self-test: request parser ok (0 errors), 64-bit, exit 0');
  const errs = Object.fromEntries(sj.filter((m) => m.id).map((m) => [m.id, m.error]));
  check(errs[101] === 'bad-request' && errs[102] === 'bad-hwnd' && errs[103] === 'bad-hwnd' && errs[104] === 'bad-hwnd', '--self-test: malformed requests answered bad-request / bad-hwnd, no window touched');
  const bad = run(['--nope']);
  check(bad.code === 2, `an unknown argument → usage, exit ${bad.code} (2)`);

  // the stdin protocol, spoken by the app's own client (src/main/wallpaper/win-helper.js) to the real exe under wine
  const { HelperClient } = require(path.join(ROOT, 'src/main/wallpaper/win-helper.js'));
  const mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let child = null;
  const viaWine = (file, args, opts) => { child = spawn(wine, [file, ...args], { ...opts, env }); return child; };
  const c = new HelperClient({ command: [exe], expectSha: mf.sha256, spawn: viaWine, timeoutMs: 120000, maxRestarts: 0 });
  const s = c.start();
  check(s.ok, `HelperClient.start(): sha256 check against helper.json passed, spawned under wine (${JSON.stringify(s)})`);
  if (!s.ok) return;
  const r1 = await c.request('status', { hwnd: '0x0' });
  const r2 = await c.request('attach', { hwnd: '0x1', rect: { x: 0, y: 0, w: 10, h: 10 } });
  const r3 = await c.request('frobnicate', { hwnd: '0x0' });
  console.log(`      protocol: status 0x0 → ${JSON.stringify(r1)}\n                attach 0x1 → ${JSON.stringify(r2)}\n                frobnicate → ${JSON.stringify(r3)}`);
  check(r1.ok === false && r1.reason === 'bad-hwnd' && r2.ok === false && r2.reason === 'bad-hwnd' && r3.reason === 'bad-hwnd', 'JSON-lines protocol: requests for non-windows answered bad-hwnd by id');
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  c.stop();
  const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res('timeout'), 60000))]);
  check(code === 0, `stdin closed (app quit) → the helper detaches and exits (exit ${code})`);
}

// ---- the packaged app --------------------------------------------------------------------------------------------
function checkPackage(dir, buildSha) {
  console.log(`== package ${dir}`);
  const res = path.join(dir, 'resources');
  const exe = path.join(res, EXE_NAME);
  const r = checkExe(exe);
  if (!r) return;
  if (buildSha) check(r.sha === buildSha, `packaged exe is the built one (${r.sha})`);
  const asarPath = path.join(res, 'app.asar');
  if (!check(fs.existsSync(asarPath), `app.asar exists (${asarPath})`)) return;
  const asar = require('@electron/asar');
  let inAsar = null;
  try { inAsar = JSON.parse(asar.extractFile(asarPath, 'src/main/wallpaper/helper.json').toString('utf8')); } catch (e) { check(false, `helper.json inside app.asar: ${e.message}`); return; }
  console.log(`      app.asar:src/main/wallpaper/helper.json → ${JSON.stringify({ file: inAsar.file, sha256: inAsar.sha256, size: inAsar.size })}`);
  checkSha(r.sha, inAsar, 'app.asar:src/main/wallpaper/helper.json');
  check(inAsar.file === EXE_NAME, `manifest names ${inAsar.file}`);
  const listed = asar.listPackage(asarPath);
  check(!listed.some((p) => /\.exe$/i.test(p)), 'no exe inside app.asar (an exe in the archive could not be spawned)');
  check(!fs.existsSync(path.join(res, 'helper.json')), 'no helper.json next to the exe in resources/ (the sha256 comes only from the code in app.asar)');
}

function checkInstaller(file) {
  console.log(`== installer ${file}`);
  if (!check(fs.existsSync(file), 'installer exists')) return;
  let sevenZip = null;
  for (const c of [process.env.SEVEN_ZIP, path.join(ROOT, 'node_modules/7zip-bin/linux/x64/7za'), '7za', '7z'].filter(Boolean)) {
    try { execFileSync(c, ['i'], { stdio: 'pipe' }); sevenZip = c; break; } catch { /* next */ }
  }
  if (!check(!!sevenZip, `7-Zip available (${sevenZip})`)) return;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pp-nsis-'));
  const list = (f) => execFileSync(sevenZip, ['l', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const rowOf = (listing) => listing.split('\n').find((l) => /resources[/\\]pixelpet-desktop-helper\.exe\s*$/.test(l));
  // p7zip opens the app archive inside the NSIS installer directly; other 7-Zip builds list the inner *.7z first
  let archive = file;
  let listing = list(file);
  if (!rowOf(listing)) {
    const pkg = listing.split('\n').map((l) => l.trim().split(/\s+/).pop()).find((n) => /\.7z$/.test(n || ''));
    if (pkg) { execFileSync(sevenZip, ['x', '-y', `-o${tmp}`, file, pkg], { stdio: 'pipe' }); archive = path.join(tmp, pkg); listing = list(archive); }
  }
  const row = rowOf(listing);
  check(!!row, `installer lists resources/${EXE_NAME}${row ? `:  ${row.trim()}` : ''}`);
  if (!row) { fs.rmSync(tmp, { recursive: true, force: true }); return; }
  execFileSync(sevenZip, ['x', '-y', `-o${tmp}/app`, archive, `resources/${EXE_NAME}`, 'resources/app.asar'], { stdio: 'pipe' });
  const got = path.join(tmp, 'app/resources', EXE_NAME);
  if (check(fs.existsSync(got), 'exe extracted from the installer')) {
    const sha = sha256(fs.readFileSync(got));
    const asar = require('@electron/asar');
    const m = JSON.parse(asar.extractFile(path.join(tmp, 'app/resources/app.asar'), 'src/main/wallpaper/helper.json').toString('utf8'));
    checkSha(sha, m, 'the installer\'s app.asar:src/main/wallpaper/helper.json');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const pos = argv.filter((a, i) => !a.startsWith('--') && !['--package', '--installer'].includes(argv[i - 1]));
  const exe = path.resolve(pos[0] || DEFAULT_EXE);
  let built = null;
  if (fs.existsSync(exe) || !opt('--package')) {
    built = checkExe(exe);
    if (built) {
      const mf = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      checkSha(built.sha, mf, 'src/main/wallpaper/helper.json');
      check(mf.sourceSha256 === require('./build-win-helper').sourceSha(), 'helper.json sourceSha256 = desktop-helper.c / .rc / .manifest (the stamp is not stale)');
      if (argv.includes('--wine')) await runWine(exe);
    }
  }
  if (opt('--package')) checkPackage(path.resolve(opt('--package')), built && built.sha);
  if (opt('--installer')) checkInstaller(path.resolve(opt('--installer')));
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { parsePE, REQUIRED_IMPORTS };
