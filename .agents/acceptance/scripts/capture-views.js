// Capture the same four views on any revision of the app (fake lh, run under xvfb): the desktop pet right after
// waking 大肥鱼, the stage-up notice, 高级设置 → 外观 and the fully unlocked wardrobe, plus a log of what each showed.
// usage: xvfb-run -a node .agents/acceptance/scripts/capture-views.js <repo or worktree> <out dir>
// For before/after pairs: `git worktree add /tmp/pp-base <base>` + `ln -s "$PWD/node_modules" /tmp/pp-base/`, run it on both.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const [ROOT, OUT] = process.argv.slice(2);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const note = (s) => { log.push(`[${new Date().toISOString()}] ${s}`); console.log(s); };
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cap-'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-capfake-'));
  fs.writeFileSync(path.join(fake, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fake } });
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const act = async (a) => { await hover(); await page.click(`[data-act="${a}"]`); };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
  try {
    note(`revision ${require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()}`);
    await page.waitForSelector('.char-card', { timeout: 20000 });
    await page.locator('.char-card').nth(0).click();
    await page.fill('#pet-name', '小蓝');
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
    await page.waitForTimeout(1500);
    const look = await page.evaluate(() => ({ look: document.getElementById('pet-look') && document.getElementById('pet-look').dataset.key, video: !document.getElementById('vwrap').classList.contains('hidden') && document.getElementById('pet-video').src.split('/').slice(-2).join('/') }));
    note(`desktop: pet-look=${look.look || '-'} video=${look.video || '-'}`);
    await page.screenshot({ path: path.join(OUT, 'desktop.png') });
    // a real stage-up: 14 points, then the pat that crosses 15
    await page.evaluate(() => window.pet.debugSet({ affection: 14, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
    await hover();
    await page.locator('#pet-body .pet-hit:not(.hidden)').click();
    await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 8000 });
    await idle();
    await page.waitForTimeout(900);
    await hover();
    note(`toast: ${(await page.textContent('#unlock-toast')).replace(/\s+/g, ' ').trim()}`);
    await page.screenshot({ path: path.join(OUT, 'stage-up-toast.png') });
    await page.click('#toast-close');
    await act('menu');
    await page.click('[data-menu="advanced"]');
    await page.waitForSelector('#panel:not(.hidden) .pack-list');
    await page.locator('.pack-list').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const packs = await page.$$eval('.pack-opt[data-pack]', (els) => els.map((e) => `${e.dataset.pack}${e.classList.contains('on') ? '(使用中)' : ''}: ${e.querySelector('.meta').textContent.replace(/\s+/g, ' ').trim()}`));
    note(`外观: ${packs.join(' | ')}`);
    await page.screenshot({ path: path.join(OUT, 'appearance.png') });
    await page.locator('#unlock-all').scrollIntoViewIfNeeded();
    await page.click('#unlock-all');
    await page.waitForSelector('#panel-msg.ok:not(.hidden)', { timeout: 10000 });
    note(`unlock-all: ${await page.textContent('#panel-msg')} · ${await page.textContent('#panel-sub')}`);
    await idle();
    await page.click('#panel-close');
    await page.waitForTimeout(600);
    await act('wardrobe');
    await page.waitForSelector('#panel:not(.hidden) .card');
    await page.waitForTimeout(1500);
    const cards = await page.$$eval('.card', (els) => els.map((e) => `${e.dataset.outfit}:${e.querySelector('.nm').textContent}`));
    note(`wardrobe ${cards.length} cards: ${cards.join(', ')}`);
    await page.screenshot({ path: path.join(OUT, 'wardrobe.png') });
  } finally {
    fs.writeFileSync(path.join(OUT, 'capture-log.txt'), log.join('\n') + '\n');
    await app.close().catch(() => {});
  }
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
