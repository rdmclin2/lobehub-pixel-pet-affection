'use strict';

// 音乐创作 in the chat (T-5090), run.js `music` / `musicchat`: the real app (pet window + settings window) with a fake
// lh, a stand-in for LobeHub's Responses API that answers 「来段轻松的纯音乐」 with a compose_music call the way a model
// would (test/fixtures/fake-responses-server.js), and stand-ins for the three music services — fal.ai's queue (the
// default, T-5651) and ElevenLabs (test/fixtures/fake-music-services.js), MiniMax direct (fake-minimax-music.js) —
// that return a real 3 s mp3. No tokens, no music quota.
//   C1 natural language → the turn offers compose_music only (local abilities off: no read_file / run_command) → the
//      bubble says 作曲中… with the time so far
//   C2 the song is saved under userData/music; the bubble shows her reply with a card: title, length, path
//   C3 ▶ plays it in the bubble (<audio>, blob: from the file's bytes); 打开 / 文件夹 go to the system; a path
//      outside the music folder is refused
//   C4 聊天记录 keeps the song with her reply
//   C5 settings window → 聊天: the desktop round shows the song card; ▶ plays it there
//   C6 a song asked for in the settings window's 聊天: 作曲中… tag, then the card under her reply
//   C7 fal.ai refuses (余额不足 / 账户锁定, HTTP 403): she says why, no file
//   C8 设置 → 音乐创作 → 让她作曲 off: the next turn has no tool and her prompt says it is off
//   C9 设置 → 音乐创作 → 服务 switched to ElevenLabs, then MiniMax 官方: the same words go to that service
// Screenshots + evidence in out/e2e/music/ (chat-*.png, music-chat-log.txt, requests JSON).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function musicChatScenario(ctx) {
  const { ROOT, OUT, FAKE_LH, step, launch, openAdminWindow, hover, clickAct } = ctx;
  return async function musicChat() {
    const S = 'music';
    const SHOTS = path.join(OUT, 'music');
    fs.mkdirSync(SHOTS, { recursive: true });
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { startFakeResponses } = require('../test/fixtures/fake-responses-server');
    const { startFakeMiniMaxMusic, SAMPLE } = require('../test/fixtures/fake-minimax-music');
    const { startFakeMusicServices } = require('../test/fixtures/fake-music-services');

    // what a model does with these words when compose_music is offered (and when it is not)
    const SONGS = {
      rain: { prompt: 'Relaxed lo-fi hip hop, warm Rhodes piano, soft rain, rainy evening', instrumental: true, title: '雨夜小憩', mood: '轻松', durationSec: 60, structure: ['Intro', 'Verse', 'Outro'] },
      summer: { prompt: 'Bright summer city pop, female vocals, guitar', lyrics: '[Verse]\n蝉鸣落在窗台上\n冰汽水冒着泡\n[Chorus]\n夏天的风 吹过来\n把烦恼都带走', title: '夏天的风', genre: 'city pop', mood: 'happy' },
    };
    let n = 0;
    const srv = await startFakeResponses((body) => {
      n++;
      const id = body.previous_response_id || 'tpc_E2E_MUSIC';
      if (Array.isArray(body.input) && body.input[0] && body.input[0].type === 'function_call_output') {
        const out = JSON.parse(body.input[0].output);
        return out.ok ? { pieces: ['写好啦～', `《${out.title}》`, '，点下面的 ▶ 就能听。'], gapMs: 150, id } : { pieces: ['这次没写成：', out.error], gapMs: 150, id };
      }
      const text = String(body.input || '');
      const last = text.split('\n').pop();
      const offered = (body.tools || []).some((t) => t.name === 'compose_music');
      const want = /纯音乐/.test(last) ? 'rain' : /夏天/.test(last) ? 'summer' : null;
      if (want && !offered) return { pieces: ['这次我没法作曲：', /关掉了/.test(text) ? '音乐创作在设置里关着。' : '作曲现在用不了。'], gapMs: 120, id };
      if (want) return { pieces: ['好呀，', '我给你写一段～'], gapMs: 150, calls: [[`call_${n}`, 'compose_music', SONGS[want]]], id };
      return { pieces: ['你好呀～'], id };
    });
    let mmPlan = () => ({ delayMs: 1500 });
    const mm = await startFakeMiniMaxMusic((b, k) => mmPlan(b, k));
    // fal (default): queued → running → done, one poll each (music.pollIntervalSec 3 s): ~6 s per song
    let falPlan = () => ({});
    const ms = await startFakeMusicServices({ falPlan: (b, k) => falPlan(b, k), elPlan: () => ({ delayMs: 1500 }) });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-musicchat-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-musicchatfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_DIRECT: '1', LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'e2e-fake-key', LOBEHUB_CLI_HOME: path.relative(os.homedir(), fakeDir), MINIMAX_API_KEY: 'e2e-fake-minimax-key', MINIMAX_MUSIC_ENDPOINT: mm.url, FAL_KEY: 'e2e-fake-fal-key', FAL_MUSIC_ENDPOINT: ms.url, ELEVENLABS_API_KEY: 'e2e-fake-elevenlabs-key', ELEVENLABS_MUSIC_ENDPOINT: ms.url };
    const { app, page } = await launch(env);
    const evidence = [];
    const note = (s) => { evidence.push(s); return s.length > 300 ? `${s.slice(0, 297)}…` : s; };
    const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
    const musicDir = path.join(data, 'music');
    const songs = () => (fs.existsSync(musicDir) ? fs.readdirSync(musicDir).filter((f) => !f.endsWith('.part')) : []);
    const sendText = async (text) => {
      await hover(page);
      if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
      await page.fill('#chat-input', text);
      await page.click('#chat-send');
    };
    const chatReq = (i) => srv.requests[i].body;
    let admin = null;
    const until = async (p, fn, arg, ms = 20000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await p.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(120);
      }
    };
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      await page.waitForTimeout(300);
      let reqAt = 0;
      let song = null;

      await step(S, 'C1 「来段轻松的纯音乐」→ the turn offers compose_music only (local abilities off) → the bubble says 作曲中… with the time so far', async () => {
        assert.equal((await page.evaluate(async () => (await window.pet.boot()).view)).local.enabled, false);
        reqAt = srv.requests.length;
        await sendText('来段轻松的纯音乐吧');
        await page.waitForSelector('#bubble[data-music="composing"] .music-status', { timeout: 15000 });
        await page.waitForTimeout(1300); // the clock has ticked
        const status = await page.textContent('#bubble');
        assert.match(status, /好呀，我给你写一段～/);
        assert.match(status, /作曲中…《雨夜小憩》 0:0[1-9]/);
        assert.match(status, /通常要 1–3 分钟，Esc 可停止/);
        await shot(page, 'chat-c1-composing');
        const req = chatReq(reqAt);
        assert.deepEqual(req.tools.map((t) => t.name), ['compose_music']);
        assert.match(req.input, /\[作曲\].*compose_music/);
        assert.equal(ms.fal.submits.length, 1);
        assert.equal(ms.fal.submits[0].model, 'fal-ai/minimax-music/v2.6');
        assert.equal(ms.fal.submits[0].headers.authorization, 'Key e2e-fake-fal-key');
        assert.equal(mm.requests.length, 0, 'MiniMax direct is not used');
        return note(`request tools=${JSON.stringify(req.tools.map((t) => t.name))} (no read_file/run_command); bubble while composing: ${JSON.stringify(status)}; fal queue POST /${ms.fal.submits[0].model} input ${JSON.stringify(ms.fal.submits[0].input)}`);
      }, page);

      await step(S, 'C2 the song is saved under userData/music; the bubble shows her reply with a card: title, length, path', async () => {
        await idle();
        await page.waitForSelector('#music-dock .music-card', { timeout: 15000 });
        await page.waitForTimeout(300);
        const card = await page.evaluate(() => { const c = document.querySelector('#music-dock .music-card'); return { dock: document.getElementById('music-dock').innerText, title: c.querySelector('.music-title').textContent, sub: c.querySelector('.music-sub').textContent, path: c.querySelector('[data-music-path]').textContent.replace(/\u200e/g, ''), pathTitle: c.querySelector('[data-music-path]').title, bubble: document.getElementById('bubble').innerText, audio: !!c.querySelector('audio'), play: c.querySelector('[data-music-play]').getAttribute('aria-label') }; });
        assert.equal(card.bubble, '写好啦～《雨夜小憩》，点下面的 ▶ 就能听。');
        assert.equal(card.title, '雨夜小憩');
        assert.equal(card.sub, '0:03 · MP3 · 纯音乐');
        assert.equal(card.audio, true);
        assert.equal(card.pathTitle, card.path, 'the full path on hover');
        // the card sits right under the bubble, whole, inside the window
        const fit = await page.evaluate(() => { const b = document.getElementById('bubble').getBoundingClientRect(); const c = document.getElementById('music-dock').getBoundingClientRect(); return { ok: c.top >= b.bottom && c.top - b.bottom < 24 && c.left >= 0 && c.right <= innerWidth && c.bottom <= innerHeight, b: [b.top, b.bottom], c: [c.top, c.bottom, c.left, c.right], w: [innerWidth, innerHeight] }; });
        assert.ok(fit.ok, `card ${JSON.stringify(fit)}`);
        assert.equal(card.play, '播放《雨夜小憩》');
        assert.equal(path.dirname(card.path), musicDir);
        assert.match(path.basename(card.path), /^\d{8}-\d{6}-雨夜小憩\.mp3$/);
        assert.deepEqual(fs.readFileSync(card.path), fs.readFileSync(SAMPLE));
        song = card.path;
        await shot(page, 'chat-c2-song-card');
        const out = JSON.parse(chatReq(reqAt + 1).input[0].output);
        assert.equal(out.filePath, song);
        assert.match(out.fileUrl, /^file:\/\//);
        return note(`bubble: ${JSON.stringify(card.bubble)}; card under it: ${JSON.stringify(card.dock)}; file ${song} (${fs.statSync(song).size} bytes, = the audio fal's result pointed to; status polls ${ms.fal.polls}); output to the model: ${chatReq(reqAt + 1).input[0].output}`);
      }, page);

      await step(S, 'C3 ▶ plays the song in the bubble (<audio>, blob:); 打开 / 文件夹 go to the system; a path outside the music folder is refused', async () => {
        await page.hover('#music-dock');
        await page.click('#music-dock [data-music-play]');
        await page.waitForFunction(() => { const a = document.querySelector('#music-dock .music-card audio'); return a && !a.paused && a.currentTime > 0.4; }, null, { timeout: 10000 });
        const st = await page.evaluate(() => { const c = document.querySelector('#music-dock .music-card'); const a = c.querySelector('audio'); return { state: c.dataset.musicState, src: a.src.slice(0, 5), t: a.currentTime, d: a.duration, label: c.querySelector('[data-music-play]').getAttribute('aria-label'), sub: c.querySelector('.music-sub').textContent }; });
        assert.equal(st.state, 'playing');
        assert.equal(st.src, 'blob:');
        assert.ok(Math.abs(st.d - 3.03) < 0.2, `duration ${st.d}`);
        assert.equal(st.label, '暂停《雨夜小憩》');
        await shot(page, 'chat-c3-playing');
        await page.waitForFunction(() => document.querySelector('#music-dock .music-card').dataset.musicState === 'idle', null, { timeout: 8000 }); // played to the end
        await page.click('#music-dock .music-open');
        await page.click('#music-dock .music-reveal');
        await page.waitForTimeout(200);
        const opened = await page.evaluate(() => window.pet.debugOpenedMusic());
        assert.deepEqual(opened.map((o) => [o.file, o.reveal]), [[fs.realpathSync(song), false], [fs.realpathSync(song), true]]);
        const refused = await page.evaluate(() => Promise.all([window.pet.music.audio('/etc/hostname'), window.pet.music.open('/etc/hostname'), window.pet.music.audio('relative.mp3')]));
        assert.deepEqual(refused.map((r) => r.ok), [false, false, false]);
        const log = await page.evaluate(() => window.petFx.musicLog());
        assert.ok(log.some((e) => e.ev === 'play'));
        return note(`playing: ${JSON.stringify(st)}; ended → idle; opened ${JSON.stringify(opened)}; outside the music folder: ${JSON.stringify(refused.map((r) => r.reason))}; music log ${JSON.stringify(log.map((e) => e.ev))}`);
      }, page);

      await step(S, 'C4 聊天记录 keeps the song with her reply (attachments.music)', async () => {
        const pet = logged().filter((m) => m.role === 'pet').at(-1);
        assert.match(pet.text, /雨夜小憩/);
        assert.equal(pet.attachments.music.length, 1);
        assert.equal(pet.attachments.music[0].filePath, song);
        return note(`chat-log pet message: ${JSON.stringify(pet)}`);
      }, page);

      await step(S, 'C5 settings window → 聊天: the desktop round shows the song card (title, length, path); ▶ plays it there', async () => {
        admin = await openAdminWindow(app, page, 'overview');
        await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 900); });
        await admin.evaluate(() => { location.hash = '#/chat/claude'; });
        await until(admin, () => !!document.querySelector('[data-chat-page] [data-music-card]'), null, 15000, 'song card in 聊天');
        await admin.waitForTimeout(500);
        const card = await admin.evaluate(() => { const c = document.querySelector('[data-music-card]'); return { text: c.innerText, path: c.querySelector('[data-music-path]').textContent }; });
        assert.match(card.text, /雨夜小憩/);
        assert.match(card.text, /纯音乐/);
        assert.match(card.text, /0:03 · MP3/);
        assert.equal(card.path, song);
        await shot(admin, 'chat-c5-admin-desktop-round');
        await admin.click('[data-music-card] [data-music-play]');
        await until(admin, () => document.querySelector('[data-music-card]').dataset.musicState === 'playing', null, 8000, 'playing in 聊天');
        await admin.waitForTimeout(700);
        await shot(admin, 'chat-c5-admin-playing');
        const t = await admin.evaluate(() => document.querySelector('[data-music-card] audio').currentTime);
        assert.ok(t > 0.2, `currentTime ${t}`);
        return note(`card in 聊天: ${JSON.stringify(card.text)}; playing, currentTime ${t.toFixed(2)} s`);
      }, () => admin);

      await step(S, 'C6 「写一首关于夏天的歌」 in the settings window\'s 聊天: 作曲中… tag, then the card under her reply', async () => {
        await admin.click('[data-chat-textarea]');
        await admin.keyboard.type('写一首关于夏天的歌');
        await admin.keyboard.press('Enter');
        await until(admin, () => !!document.querySelector('[data-music-status="composing"]'), null, 15000, '作曲中 tag');
        await admin.waitForTimeout(1300);
        const tag = await admin.evaluate(() => document.querySelector('[data-music-status]').innerText);
        assert.match(tag, /作曲中…《夏天的风》 0:0[1-9]/);
        await shot(admin, 'chat-c6-admin-composing');
        await until(admin, () => !document.querySelector('[data-streaming]') && document.querySelectorAll('[data-music-card]').length === 2, null, 20000, 'second song card');
        await admin.waitForTimeout(400);
        const last = await admin.evaluate(() => { const cs = [...document.querySelectorAll('[data-music-card]')]; return cs[cs.length - 1].innerText; });
        assert.match(last, /夏天的风/);
        assert.doesNotMatch(last, /纯音乐/);
        await shot(admin, 'chat-c6-admin-song-card');
        assert.equal(ms.fal.submits.length, 2);
        assert.match(ms.fal.submits[1].input.lyrics, /\[Chorus\]/);
        assert.equal(songs().length, 2);
        return note(`tag while composing ${JSON.stringify(tag)}; card ${JSON.stringify(last)}; fal lyrics ${JSON.stringify(ms.fal.submits[1].input.lyrics)}; files ${songs().join(', ')}`);
      }, () => admin);

      await step(S, 'C7 fal.ai refuses (余额不足 / 账户锁定, HTTP 403): she says why in the bubble, no file is saved', async () => {
        // 收起 the card of the first song (it would otherwise stay up to two minutes)
        if (await page.isVisible('#music-dock')) await page.click('#music-dock-close');
        assert.equal(await page.isVisible('#music-dock'), false);
        falPlan = () => ({ submit: { status: 403, body: { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' } } });
        const before = songs().length;
        await sendText('再来段纯音乐');
        await idle();
        await page.waitForTimeout(300);
        const text = await page.textContent('#bubble');
        assert.match(text, /这次没写成：fal\.ai 账户余额不足或已被锁定，请到 fal\.ai\/dashboard\/billing 充值后再试（错误码 http-403）/);
        assert.equal(await page.isVisible('#music-dock'), false, 'no song card this time');
        assert.equal(songs().length, before);
        await shot(page, 'chat-c7-fal-refused');
        const log = await page.evaluate(() => window.petFx.musicLog());
        assert.ok(log.some((e) => e.ev === 'failed'));
        falPlan = () => ({});
        return note(`bubble ${JSON.stringify(text)}; files still ${before}`);
      }, page);

      await step(S, 'C8 设置 → 音乐创作 → 让她作曲 off: the switch is on the page; the next turn has no tool and her prompt says it is off', async () => {
        await admin.evaluate(() => { location.hash = '/music'; });
        await until(admin, () => !!document.querySelector('[data-path="/music"] [data-key="music.enabled"]'), null, 10000, 'music page');
        await admin.waitForTimeout(400);
        await shot(admin, 'chat-c8-music-settings-switch-on');
        const r = await admin.evaluate(() => window.petAdmin.set('music.enabled', false));
        assert.equal(r.ok, true);
        await admin.waitForTimeout(400);
        await shot(admin, 'chat-c8-music-settings-switch-off');
        assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).music.enabled, false);
        const at = srv.requests.length;
        const falAt = ms.fal.submits.length;
        await sendText('来段纯音乐');
        await idle();
        const req = chatReq(at);
        assert.deepEqual(req.tools, []);
        assert.match(req.input, /这次不能作曲：在「设置 → 音乐创作」里关掉了/);
        assert.equal(ms.fal.submits.length, falAt);
        await page.waitForTimeout(300);
        await shot(page, 'chat-c8-music-off-bubble');
        await admin.evaluate(() => window.petAdmin.set('music.enabled', true));
        return note(`settings.json music.enabled=false → request tools=[]; prompt hint present; fal calls +0; bubble ${JSON.stringify(await page.textContent('#bubble'))}`);
      }, page);

      await step(S, 'C9 设置 → 音乐创作 → 服务 = ElevenLabs, then MiniMax 官方: the same words go to that service (xi-api-key / Bearer), a playable song each time', async () => {
        const out = [];
        for (const [id, check] of [['elevenlabs', () => ms.el.requests.length], ['minimax', () => mm.requests.length]]) {
          const r = await admin.evaluate((v) => window.petAdmin.set('music.provider', v), id);
          assert.equal(r.ok, true, JSON.stringify(r));
          assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).music.provider, id);
          if (await page.isVisible('#music-dock')) await page.click('#music-dock-close');
          const before = songs().length;
          const calls = check();
          const at = srv.requests.length;
          await sendText('来段纯音乐');
          await idle();
          await page.waitForSelector('#music-dock .music-card', { timeout: 20000 });
          assert.equal(check(), calls + 1, `${id} was called`);
          assert.equal(songs().length, before + 1);
          const fnOut = JSON.parse(srv.requests.slice(at).find((q) => Array.isArray(q.body.input) && q.body.input[0].type === 'function_call_output').body.input[0].output);
          assert.equal(fnOut.provider, id);
          await page.waitForTimeout(300);
          await shot(page, `chat-c9-${id}-song`);
          out.push(`${id}: tool output ${JSON.stringify({ ok: fnOut.ok, provider: fnOut.provider, model: fnOut.model, unsupported: fnOut.unsupported })}`);
        }
        const el = ms.el.requests[0];
        assert.equal(el.headers['xi-api-key'], 'e2e-fake-elevenlabs-key');
        assert.equal(el.body.music_length_ms, 60000);
        assert.equal(mm.requests.at(-1).headers.authorization, 'Bearer e2e-fake-minimax-key');
        await admin.evaluate(() => window.petAdmin.set('music.provider', 'fal'));
        return note(`${out.join('; ')}; ElevenLabs body ${JSON.stringify(el.body)} query ${JSON.stringify(el.query)}`);
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'music-chat-log.txt'), evidence.join('\n\n') + '\n');
      try { fs.writeFileSync(path.join(SHOTS, 'music-chat-responses-requests.json'), JSON.stringify(srv.requests.map((q) => ({ at: q.at, body: q.body })), null, 2) + '\n'); } catch { /* ignore */ }
      try { fs.writeFileSync(path.join(SHOTS, 'music-chat-fal-requests.json'), JSON.stringify(ms.requests.map((q) => ({ at: q.at, method: q.method, path: q.path, query: q.query, auth: q.headers.authorization ? q.headers.authorization.replace(/\S+$/, '<key>') : null, xiApiKey: q.headers['xi-api-key'] ? '<key>' : null, body: q.body })), null, 2) + '\n'); } catch { /* ignore */ }
      try { fs.writeFileSync(path.join(SHOTS, 'music-chat-minimax-requests.json'), JSON.stringify(mm.requests.map((q) => ({ at: q.at, auth: q.headers.authorization, body: q.body })), null, 2) + '\n'); } catch { /* ignore */ }
      try { fs.copyFileSync(path.join(data, 'chat-log.json'), path.join(SHOTS, 'music-chat-chat-log.json')); } catch { /* ignore */ }
      await app.close().catch(() => {});
      await srv.close();
      await mm.close();
      await ms.close();
    }
  };
};
