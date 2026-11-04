'use strict';

// 音乐创作 with the REAL model (T-5091), run.js `musiclive` — costs LobeHub tokens, so it is never part of `all`.
// The real app, the real `lh` login and LobeHub's real Responses API: a real agent is created, the owner types a
// natural-language request, and the model itself decides to call compose_music (nothing scripts the call).
//   MUSIC_LIVE_MINIMAX=fake (default)  MiniMax is the local stand-in (test/fixtures/fake-minimax-music.js, a real 3 s
//                                      mp3): proves tool choice → saved file → playable card, without MiniMax credit
//   MUSIC_LIVE_MINIMAX=real            MiniMax is the real endpoint with the local key (MINIMAX_API_KEY / ~/.zshrc via
//                                      scripts/minimax-key.js, never printed): whatever MiniMax answers is shown
//   L1 hatch with real lh (local abilities off: no tools on this computer) → a real agent
//   L2 「给我写一首…」→ the model calls compose_music on its own (作曲中…); the MiniMax request carries its arguments
//   L3 fake: the song card is under her reply and ▶ plays it · real: the outcome MiniMax gave (song, or her reason)
// The agent is deleted at the end. Evidence in out/e2e/music-live-<mode>/ (png, webm, log, chat-log.json).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function musicLiveScenario(ctx) {
  const { ROOT, OUT, step, launch, hover, clickAct } = ctx;
  return async function musicLive() {
    const MODE = process.env.MUSIC_LIVE_MINIMAX === 'real' ? 'real' : 'fake';
    const S = `musiclive-${MODE}`;
    const SHOTS = path.join(OUT, `music-live-${MODE}`);
    fs.mkdirSync(SHOTS, { recursive: true });
    const VIDEO = path.join(SHOTS, 'video');
    const lhEnv = { ...process.env, LOBEHUB_JWT: '' };
    const lh = (...a) => execFileSync('lh', a, { env: lhEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const { startFakeMiniMaxMusic, SAMPLE } = require('../test/fixtures/fake-minimax-music');
    const mm = MODE === 'fake' ? await startFakeMiniMaxMusic(() => ({ delayMs: 4000 })) : null;
    let key = '';
    if (MODE === 'real') {
      key = require('../scripts/minimax-key').key().value;
      if (!key) throw new Error('MUSIC_LIVE_MINIMAX=real needs a MiniMax key (MINIMAX_API_KEY)');
    }
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-musiclive-'));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1', PIXELPET_DIRECT: '1', MINIMAX_API_KEY: MODE === 'fake' ? 'e2e-fake-minimax-key' : key, ...(mm ? { MINIMAX_MUSIC_ENDPOINT: mm.url } : { MINIMAX_MUSIC_ENDPOINT: '' }) };
    const { app, page } = await launch(env, { video: VIDEO });
    let agentId = null;
    const evidence = [`mode: MiniMax ${MODE === 'fake' ? `stand-in ${mm.url}` : 'real https://api.minimax.cn (key from local config, not shown)'}; model: real LobeHub Responses API`];
    const note = (s) => { evidence.push(s); return s.length > 400 ? `${s.slice(0, 397)}…` : s; };
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    const idle = (ms = 400000) => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: ms });
    const musicDir = path.join(data, 'music');
    const songs = () => (fs.existsSync(musicDir) ? fs.readdirSync(musicDir).filter((f) => !f.endsWith('.part')) : []);
    const onSignal = () => { if (agentId) { try { lh('agent', 'delete', agentId, '--yes'); } catch { /* best effort */ } } process.exit(143); };
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
      const ASK = '给我写一首轻快的纯音乐吧，适合下午喝咖啡的时候听';
      await step(S, `L2 「${ASK}」→ the real model calls compose_music by itself; the bubble says 作曲中…`, async () => {
        await hover(page);
        if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
        await page.fill('#chat-input', ASK);
        await shot('l2-typed');
        await page.click('#chat-send');
        await page.waitForSelector('#bubble[data-music="composing"] .music-status', { timeout: 180000 });
        await shot('l2-composing'); // at once: a real MiniMax refusal ends 作曲中… within a second
        const status = await page.textContent('#bubble');
        if (MODE === 'fake') { await page.waitForTimeout(1500); await shot('l2-composing-clock'); }
        musicLog = await page.evaluate(() => window.petFx.musicLog());
        assert.ok(musicLog.some((e) => e.ev === 'composing' && e.stage === 'submitting'), `compose_music ran (${JSON.stringify(musicLog)})`);
        assert.match(status, /作曲中…|这次没写成/);
        const mmBody = mm ? (mm.requests[0] && mm.requests[0].body) : null;
        if (mm) assert.ok(mmBody, 'the stand-in got the MiniMax request');
        return note(`bubble while composing ${JSON.stringify(status)}; music events ${JSON.stringify(musicLog)}${mmBody ? `; MiniMax request body from the model's arguments ${JSON.stringify(mmBody)}` : ''}`);
      }, page);

      await step(S, MODE === 'fake' ? 'L3 her reply comes with the song card; ▶ plays the saved mp3' : 'L3 what real MiniMax answered reaches the owner (song card, or her reason)', async () => {
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
          return note(`reply ${JSON.stringify(bubble)}; card ${JSON.stringify(st)}; file ${file} (${fs.statSync(file).size} bytes); chat-log pet message ${JSON.stringify(pet)}`);
        }
        assert.ok(failed, `a failed event (${JSON.stringify(musicLog)})`);
        assert.equal(songs().length, 0);
        assert.equal(await page.isVisible('#music-dock'), false);
        assert.ok(bubble.trim().length > 0);
        await shot('l3-minimax-answer');
        return note(`MiniMax refused: ${JSON.stringify(failed.error)}; her reply ${JSON.stringify(bubble)}; no file saved; chat-log pet message ${JSON.stringify(pet)}`);
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'music-live-log.txt'), evidence.join('\n\n') + '\n');
      if (mm) { try { fs.writeFileSync(path.join(SHOTS, 'minimax-requests.json'), JSON.stringify(mm.requests.map((q) => ({ at: q.at, body: q.body })), null, 2) + '\n'); } catch { /* ignore */ } }
      await app.close().catch(() => {});
      if (mm) await mm.close();
      if (agentId) { try { lh('agent', 'delete', agentId, '--yes'); } catch { try { execFileSync('lh', ['agent', 'delete', agentId, '--yes'], { env: { ...lhEnv, LOBEHUB_WORKSPACE_ID: 'personal' }, stdio: 'ignore' }); } catch (e) { console.error(`could not delete ${agentId}: ${e.message}`); } } }
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
  };
};
