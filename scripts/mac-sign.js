'use strict';
// electron-builder afterSign hook (package.json build.afterSign): re-sign the macOS app with the project's fixed
// self-signed certificate (T-3386).
//
// Why: an ad-hoc signature (identity "-") is identified by its code hash, which changes with every build, so macOS
// (TCC) treats each update as a new app and forgets every "Allow" the owner gave (microphone, Downloads...). A
// signature made with a certificate is identified by `identifier "<appId>" and certificate leaf = H"<sha1>"`, which
// stays the same from version to version, so the owner answers each prompt once. The certificate is self-signed
// (no Apple Developer ID): Gatekeeper still asks for 右键 →“打开” on first launch, exactly as before.
//
// Input (CI secrets, see .github/workflows/release.yml):
//   PIXELPET_MAC_CERT_P12       base64 of a .p12 holding the certificate and its private key
//   PIXELPET_MAC_CERT_PASSWORD  its password
// Without them (forks, local builds) the app keeps electron-builder's ad-hoc signature, as before.
// PIXELPET_MAC_CERT_REQUIRED=1 turns a missing certificate into an error (release builds must not regress silently).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const log = (...a) => console.log('[mac-sign]', ...a);

// `security find-identity -p codesigning <keychain>` lines look like
//   1) 3F2A...40 hex... "Pixel Pet Affection Self-Signed" (CSSMERR_TP_NOT_TRUSTED)
// The first SHA-1 listed, or null. (Self-signed means "not trusted"; codesign signs with it all the same.)
function identityHash(findIdentityOutput) {
  const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"/m.exec(String(findIdentityOutput || ''));
  return m ? m[1] : null;
}

// The designated requirement `codesign -d -r -` prints must pin the certificate, not a code hash.
function pinsCertificate(requirementOutput) {
  const s = String(requirementOutput || '');
  return /designated\s*=>.*certificate leaf\s*=\s*H"[0-9a-f]{40}"/i.test(s) && !/cdhash/i.test(s);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function signApp(appPath, { p12Base64, password }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-sign-'));
  const keychain = path.join(tmp, 'sign.keychain-db');
  const kcPass = crypto.randomBytes(16).toString('hex');
  const p12 = path.join(tmp, 'cert.p12');
  const before = sh('security', ['list-keychains', '-d', 'user']).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  try {
    fs.writeFileSync(p12, Buffer.from(p12Base64, 'base64'), { mode: 0o600 });
    sh('security', ['create-keychain', '-p', kcPass, keychain]);
    sh('security', ['set-keychain-settings', '-lut', '3600', keychain]);
    sh('security', ['unlock-keychain', '-p', kcPass, keychain]);
    sh('security', ['import', p12, '-k', keychain, '-P', password || '', '-T', '/usr/bin/codesign']);
    sh('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPass, keychain]);
    // codesign looks the identity up in the search list
    sh('security', ['list-keychains', '-d', 'user', '-s', keychain, ...before]);
    const hash = identityHash(sh('security', ['find-identity', '-p', 'codesigning', keychain]));
    if (!hash) throw new Error('the certificate in PIXELPET_MAC_CERT_P12 is not a code-signing identity');
    log(`signing ${path.basename(appPath)} with ${hash}`);
    // --deep re-signs the helpers and frameworks inside the bundle with the same identity (no hardened runtime,
    // no entitlements: the same shape as the ad-hoc signature it replaces).
    sh('codesign', ['--force', '--deep', '--timestamp=none', '--keychain', keychain, '--sign', hash, appPath], { stdio: ['ignore', 'inherit', 'inherit'] });
    sh('codesign', ['--verify', '--deep', '--strict', appPath]);
    // codesign -d prints part of its answer on stderr: capture both
    const req = sh('/bin/sh', ['-c', 'codesign -d -r - "$1" 2>&1', 'sh', appPath]);
    if (!pinsCertificate(req)) throw new Error(`the signature does not pin the certificate:\n${req}`);
    log(req.trim().split('\n').filter((l) => /designated/.test(l)).join('\n'));
  } finally {
    try { sh('security', ['list-keychains', '-d', 'user', '-s', ...before]); } catch { /* best effort */ }
    try { sh('security', ['delete-keychain', keychain]); } catch { /* best effort */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// electron-builder calls this after its own (ad-hoc) signing and before it builds the dmg / zip.
async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const p12Base64 = process.env.PIXELPET_MAC_CERT_P12;
  if (!p12Base64) {
    if (process.env.PIXELPET_MAC_CERT_REQUIRED === '1') throw new Error('PIXELPET_MAC_CERT_P12 is not set but PIXELPET_MAC_CERT_REQUIRED=1');
    log('no PIXELPET_MAC_CERT_P12: keeping the ad-hoc signature');
    return;
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  signApp(appPath, { p12Base64, password: process.env.PIXELPET_MAC_CERT_PASSWORD });
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.identityHash = identityHash;
module.exports.pinsCertificate = pinsCertificate;
