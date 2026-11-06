'use strict';

// 音乐创作 with the REAL model (T-5091), run.js `musiclive` — costs LobeHub tokens, so it is never part of `all`.
// The real app, the real `lh` login and LobeHub's real Responses API: a real agent is created, the owner types a
// natural-language request, and the model itself decides to call compose_music (nothing scripts the call).
// The music service (T-6158; settings.json music.provider, written before launch):
//   MUSIC_LIVE_PROVIDER=fal (default) | elevenlabs | minimax     MUSIC_LIVE_MODE=fake (default) | real
//   fake  the service is a local stand-in on 127.0.0.1 (fal / ElevenLabs: test/fixtures/fake-music-services.js, MiniMax:
//         test/fixtures/fake-minimax-music.js; both serve a real 3 s mp3): tool choice → saved file → playable card
//   real  the real service with the local key (FAL_KEY / ELEVENLABS_API_KEY / MINIMAX_API_KEY, env or ~/.zshrc via scripts/minimax-key.js,
//         never printed): whatever the service answers is shown (a song card, or her reason)
//   MUSIC_LIVE_MINIMAX=fake|real is the old spelling of MUSIC_LIVE_PROVIDER=minimax MUSIC_LIVE_MODE=fake|real.
//   L1 hatch with real lh (local abilities off: no tools on this computer) → a real agent
//   L2 「给我写一首关于…的歌」→ the model calls compose_music on its own (作曲中…); the request carries its arguments
//   L3 the song card is under her reply and ▶ plays it · or (real only) the refusal reaches the owner as her reason
// The agent (personal space) is deleted at the end with LOBEHUB_WORKSPACE_ID=personal. Evidence in
// out/e2e/music-live-<provider>-<mode>/ (png, webm, log, chat-log.json, <provider>-requests.json for fake).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function musicLiveScenario(ctx) {
  const { ROOT, OUT, step, launch, hover, clickAct } = ctx;
  const { clickChatBubble } = require('./pet-panel');
  return async function musicLive() {
    const legacy = process.env.MUSIC_LIVE_MINIMAX;
    const PROVIDER = legacy ? 'minimax' : ['minimax', 'elevenlabs'].includes(process.env.MUSIC_LIVE_PROVIDER) ? process.env.MUSIC_LIVE_PROVIDER : 'fal';
    const MODE = (legacy || process.env.MUSIC_LIVE_MODE) === 'real' ? 'real' : 'fake';
    const LABEL = { fal: 'fal.ai', elevenlabs: 'ElevenLabs', minimax: 'MiniMax' }[PROVIDER];
    const S = `musiclive-${PROVIDER}-${MODE}`;
    const SHOTS = path.join(OUT, `music-live-${PROVIDER}-${MODE}`);
    fs.mkdirSync(SHOTS, { recursive: true });
    const VIDEO = path.join(SHOTS, 'video');
    const lhEnv = { ...process.env, LOBEHUB_JWT: '' };
    const { SAMPLE } = require('../test/fixtures/fake-music-services');
    const KEY_ENV = { fal: 'FAL_KEY', elevenlabs: 'ELEVENLABS_API_KEY', minimax: 'MINIMAX_API_KEY' }[PROVIDER];
    const EP_ENV = { fal: 'FAL_MUSIC_ENDPOINT', elevenlabs: 'ELEVENLABS_MUSIC_ENDPOINT', minimax: 'MINIMAX_MUSIC_ENDPOINT' }[PROVIDER];
    const REAL_HOST = { fal: 'https://queue.fal.run', elevenlabs: 'https://api.elevenlabs.io', minimax: 'https://api.minimax.cn' }[PROVIDER];
    // fake: the stand-in answers after a few seconds so 作曲中… stays on screen long enough to be seen
    let mm = null;
    if (MODE === 'fake' && PROVIDER === 'fal') {
      const { startFakeMusicServices, FAL_OK } = require('../test/fixtures/fake-music-services');
      mm = await startFakeMusicServices({ falPlan: () => ({ statuses: [FAL_OK[0], FAL_OK[0], FAL_OK[1], FAL_OK[1], FAL_OK[2]] }) });
      mm.bodies = () => mm.fal.submits.map((q) => ({ model: q.model, input: q.input }));
    } else if (MODE === 'fake' && PROVIDER === 'elevenlabs') {
      const { startFakeMusicServices } = require('../test/fixtures/fake-music-services');
      mm = await startFakeMusicServices({ elPlan: () => ({ delayMs: 4000 }) });
      mm.bodies = () => mm.el.requests.map((q) => ({ query: q.query, body: q.body }));
    } else if (MODE === 'fake') {
      const { startFakeMiniMaxMusic } = require('../test/fixtures/fake-minimax-music');
      mm = await startFakeMiniMaxMusic(() => ({ delayMs: 4000 }));
      mm.bodies = () => mm.requests.map((q) => q.body);
    }
    let key = '';
    if (MODE === 'real') {
      key = require('../scripts/minimax-key').read(KEY_ENV).value;
      if (!key) throw new Error(`MUSIC_LIVE_MODE=real needs ${KEY_ENV} (env or an export line in ~/.zshrc)`);
    }
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-musiclive-'));
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, music: { provider: PROVIDER, ...(PROVIDER === 'fal' ? { pollIntervalSec: 2 } : {}) } }));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1', PIXELPET_DIRECT: '1', FAL_KEY: '', ELEVENLABS_API_KEY: '', MINIMAX_API_KEY: '', [KEY_ENV]: MODE === 'fake' ? `e2e-fake-${PROVIDER}-key` : key, [EP_ENV]: mm ? mm.url : '' };
    const { app, page } = await launch(env, { video: VIDEO });
    // never accept 「开启本机能力」 on the owner's behalf (launch() accepts every dialog): dismiss it and note it
    const dialogs = [];
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => { dialogs.push(d.message()); if (/本机能力/.test(d.message())) d.dismiss().catch(() => {}); else d.accept().catch(() => {}); });
    let agentId = null;
    const evidence = [`service: ${LABEL} ${MODE === 'fake' ? `stand-in ${mm.url}` : `real (${REAL_HOST}; ${KEY_ENV} from local config, ${key.length} chars, not shown)`}; settings music.provider=${PROVIDER}; model: real LobeHub Responses API`];
    const note = (s) => { evidence.push(s); return s.length > 400 ? `${s.slice(0, 397)}…` : s; };
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    const idle = (ms = 400000) => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: ms });
    const musicDir = path.join(data, 'music');
    const songs = () => (fs.existsSync(musicDir) ? fs.readdirSync(musicDir).filter((f) => !f.endsWith('.part')) : []);
    // the agent is created in the personal space; delete it there (LOBEHUB_WORKSPACE_ID=personal)
    const deleteAgent = () => execFileSync('lh', ['agent', 'delete', agentId, '--yes'], { env: { ...lhEnv, LOBEHUB_WORKSPACE_ID: 'personal' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const onSignal = () => { if (agentId) { try { deleteAgent(); } catch { /* best effort */ } } process.exit(143); };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    try {
      await page.waitForSelector('.char-card');
      await step(S, 'L1 real lh login: hatch with local abilities off → a real LobeHub agent', async () => {
        await page.locator('.char-card[data-species="claude"]').first().click();
        await page.uncheck('#local-opt'); // never run tools on, or bind an agent to, a real computer
        await page.click('#hatch-btn');
        const where = await Promise.race([
          page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'),
          page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked'),
        ]);
        if (where === 'asked') await page.click('#space-go');
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
        const v = await page.evaluate(async () => (await window.pet.boot()).view);
        agentId = v.pet.agentId;
        assert.match(agentId, /^agt_/);
        assert.equal(v.local.enabled, false);
        await idle(150000);
        await page.waitForTimeout(500);
        await shot('l1-hatched');
        return note(`agent ${agentId}; local abilities off; greeting ${JSON.stringify(await page.textContent('#bubble'))}`);
      }, page);

      let musicLog = [];
      const ASK = process.env.MUSIC_LIVE_ASK || '给我写一首关于夏夜萤火虫的歌吧，轻快一点，短一些就好';
      await step(S, `L2 「${ASK}」→ the real model calls compose_music by itself; the bubble says 作曲中…`, async () => {
        await hover(page);
        if (!(await page.isVisible('#chat-input'))) await clickChatBubble(page);
        await page.fill('#chat-input', ASK);
        await shot('l2-typed');
        await page.click('#chat-send');
        await page.waitForSelector('#bubble[data-music="composing"] .music-status', { timeout: 180000 });
        await shot('l2-composing'); // at once: a real refusal ends 作曲中… within a second
        const status = await page.textContent('#bubble');
        if (MODE === 'fake') { await page.waitForTimeout(1500); await shot('l2-composing-clock'); }
        musicLog = await page.evaluate(() => window.petFx.musicLog());
        assert.ok(musicLog.some((e) => e.ev === 'composing' && e.stage === 'submitting'), `compose_music ran (${JSON.stringify(musicLog)})`);
        assert.match(status, /作曲中…|这次没写成/);
        const mmBody = mm ? mm.bodies()[0] : null;
        if (mm) assert.ok(mmBody, `the stand-in got the ${LABEL} request`);
        return note(`bubble while composing ${JSON.stringify(status)}; music events ${JSON.stringify(musicLog)}${mmBody ? `; ${LABEL} request body from the model's arguments ${JSON.stringify(mmBody)}` : ''}`);
      }, page);

      await step(S, MODE === 'fake' ? 'L3 her reply comes with the song card; ▶ plays the saved mp3' : `L3 what real ${LABEL} answered reaches the owner (song card, or her reason)`, async () => {
        await idle();
        await page.waitForTimeout(600);
        musicLog = await page.evaluate(() => window.petFx.musicLog());
        const bubble = await page.textContent('#bubble');
        const pet = JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages.filter((m) => m.role === 'pet').at(-1);
        fs.copyFileSync(path.join(data, 'chat-log.json'), path.join(SHOTS, 'chat-log.json'));
        const done = musicLog.find((e) => e.ev === 'done');
        const failed = musicLog.find((e) => e.ev === 'failed');
        if (MODE === 'fake' || done) {
          assert.ok(done, `a done event (${JSON.stringify(musicLog)})`);
          await page.waitForSelector('#music-dock .music-card', { timeout: 15000 });
          await shot('l3-song-card');
          const file = done.filePath;
          assert.equal(path.dirname(file), musicDir);
          if (MODE === 'fake') assert.deepEqual(fs.readFileSync(file), fs.readFileSync(SAMPLE));
          await page.hover('#music-dock');
          await page.click('#music-dock [data-music-play]');
          await page.waitForFunction(() => { const a = document.querySelector('#music-dock .music-card audio'); return a && !a.paused && a.currentTime > 0.4; }, null, { timeout: 15000 });
          const st = await page.evaluate(() => { const c = document.querySelector('#music-dock .music-card'); const a = c.querySelector('audio'); return { state: c.dataset.musicState, title: c.querySelector('.music-title').textContent, sub: c.querySelector('.music-sub').textContent, t: a.currentTime, d: a.duration }; });
          assert.equal(st.state, 'playing');
          await shot('l3-playing');
          assert.equal(pet.attachments.music[0].filePath, file);
          const v = await page.evaluate(async () => (await window.pet.boot()).view);
          assert.equal(v.local.enabled, false, 'local abilities still off');
          note(`dialogs seen: ${JSON.stringify(dialogs)} (本机能力 ones dismissed, never accepted); local abilities still off`);
          return note(`reply ${JSON.stringify(bubble)}; card ${JSON.stringify(st)}; file ${file} (${fs.statSync(file).size} bytes); chat-log pet message ${JSON.stringify(pet)}`);
        }
        assert.ok(failed, `a failed event (${JSON.stringify(musicLog)})`);
        assert.equal(songs().length, 0);
        assert.equal(await page.isVisible('#music-dock'), false);
        assert.ok(bubble.trim().length > 0);
        await shot(`l3-${PROVIDER}-answer`);
        return note(`${LABEL} refused: ${JSON.stringify(failed.error)}; her reply ${JSON.stringify(bubble)}; no file saved; chat-log pet message ${JSON.stringify(pet)}`);
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'music-live-log.txt'), evidence.join('\n\n') + '\n');
      if (mm) { try { fs.writeFileSync(path.join(SHOTS, `${PROVIDER}-requests.json`), JSON.stringify(mm.requests.map((q) => ({ at: q.at, method: q.method, path: q.path, body: q.body })), null, 2) + '\n'); } catch { /* ignore */ } }
      await app.close().catch(() => {});
      if (mm) await mm.close();
      if (agentId) {
        try { deleteAgent(); console.log(`musiclive: deleted agent ${agentId} (LOBEHUB_WORKSPACE_ID=personal)`); } catch (e) { console.error(`musiclive: could not delete ${agentId}: ${e.message}`); }
        fs.appendFileSync(path.join(SHOTS, 'music-live-log.txt'), `agent ${agentId} delete requested with LOBEHUB_WORKSPACE_ID=personal\n`);
      }
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
  };
};
