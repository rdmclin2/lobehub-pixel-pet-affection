'use strict';
// T-3386: macOS release builds are re-signed with the project's fixed self-signed certificate so the system keeps
// the owner's permission answers across updates (scripts/mac-sign.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const afterSign = require('../scripts/mac-sign');
const { identityHash, pinsCertificate } = afterSign;
const pkg = require('../package.json');

test('the hook is registered with electron-builder', () => {
  assert.equal(pkg.build.afterSign, 'scripts/mac-sign.js');
});

test('identityHash reads the SHA-1 of a self-signed (not trusted) code-signing identity', () => {
  const out = [
    'Policy: Code Signing',
    '  Matching identities',
    '  1) 3F2A9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B "Pixel Pet Affection Self-Signed" (CSSMERR_TP_NOT_TRUSTED)',
    '     1 identities found',
  ].join('\n');
  assert.equal(identityHash(out), '3F2A9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B');
  assert.equal(identityHash('     0 identities found'), null);
  assert.equal(identityHash(''), null);
});

test('pinsCertificate accepts a certificate requirement and refuses an ad-hoc (code hash) one', () => {
  assert.equal(pinsCertificate('Executable=/x\ndesignated => identifier "com.rdmclin2.pixelpet.affection" and certificate leaf = H"3f2a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b"'), true);
  assert.equal(pinsCertificate('Executable=/x\ndesignated => cdhash H"0123456789abcdef0123456789abcdef01234567"'), false);
  assert.equal(pinsCertificate(''), false);
});

test('without a certificate the build keeps the ad-hoc signature, unless one is required', async () => {
  const saved = { p12: process.env.PIXELPET_MAC_CERT_P12, req: process.env.PIXELPET_MAC_CERT_REQUIRED };
  try {
    delete process.env.PIXELPET_MAC_CERT_P12;
    delete process.env.PIXELPET_MAC_CERT_REQUIRED;
    const ctx = { electronPlatformName: 'darwin', appOutDir: '/nowhere', packager: { appInfo: { productFilename: 'Pixel Pet Affection' } } };
    await afterSign(ctx); // no-op, no codesign run
    await afterSign({ ...ctx, electronPlatformName: 'win32' });
    process.env.PIXELPET_MAC_CERT_REQUIRED = '1';
    await assert.rejects(afterSign(ctx), /PIXELPET_MAC_CERT_P12 is not set/);
    await afterSign({ ...ctx, electronPlatformName: 'linux' }); // other platforms never need it
  } finally {
    if (saved.p12 === undefined) delete process.env.PIXELPET_MAC_CERT_P12; else process.env.PIXELPET_MAC_CERT_P12 = saved.p12;
    if (saved.req === undefined) delete process.env.PIXELPET_MAC_CERT_REQUIRED; else process.env.PIXELPET_MAC_CERT_REQUIRED = saved.req;
  }
});
