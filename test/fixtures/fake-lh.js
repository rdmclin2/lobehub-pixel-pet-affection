#!/usr/bin/env node
// Fake `lh` used by tests. State lives in $FAKE_LH_DIR (logged-in flag, agents, call log).
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_LH_DIR;
const flag = path.join(dir, 'loggedin');
const log = (o) => fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(o) + '\n');
const args = process.argv.slice(2);
log({ args, env: { topic: process.env.LOBEHUB_TOPIC_ID || null, workspace: process.env.LOBEHUB_WORKSPACE_ID || null } });
const pinFile = path.join(dir, 'pinned-workspace');

if (args[0] === 'whoami') {
  if (!fs.existsSync(flag)) { console.error('Not logged in'); process.exit(1); }
  console.log(JSON.stringify({ fullName: 'Test Owner', username: 'tester', email: 't@example.com' }));
} else if (args[0] === 'login') {
  // Mirrors the real CLI: URL and code arrive as separate writes.
  console.log('  Open this URL in your browser:');
  console.log('  https://example.com/device');
  console.log('');
  setTimeout(() => console.log(`  Enter code: ${process.env.FAKE_LH_CODE || 'ABCD-1234'}`), 200);
  if (process.env.FAKE_LH_NO_BROWSER) setTimeout(() => console.log('Could not open browser automatically.'), 400);
  setTimeout(() => { fs.writeFileSync(flag, '1'); process.exit(0); }, Number(process.env.FAKE_LH_LOGIN_MS || 300));
} else if (args[0] === 'workspace' && args[1] === 'list') {
  const f = path.join(dir, 'workspaces.json');
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '[]');
} else if (args[0] === 'workspace' && args[1] === 'current') {
  if (process.env.LOBEHUB_WORKSPACE_ID) console.log(JSON.stringify({ source: 'env', workspaceId: process.env.LOBEHUB_WORKSPACE_ID }));
  else if (fs.existsSync(pinFile)) console.log(JSON.stringify({ source: 'settings', workspaceId: fs.readFileSync(pinFile, 'utf8') }));
  else console.log(JSON.stringify({ source: 'personal' }));
} else if (args[0] === 'workspace' && args[1] === 'use' && args.includes('--personal')) {
  fs.rmSync(pinFile, { force: true });
  console.log('✓ Switched to personal');
} else if (args[0] === 'agent' && args[1] === 'create') {
  const id = 'agt_FAKE' + Date.now();
  fs.writeFileSync(path.join(dir, 'last-create.json'), JSON.stringify({ title: args[args.indexOf('-t') + 1], systemRole: args[args.indexOf('-s') + 1] }));
  console.log(`✓ Created agent ${id}`);
} else if (args[0] === 'device' && args[1] === 'list') {
  const f = path.join(dir, 'devices.json');
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '[]');
} else if (args[0] === 'connect' && args[1] === 'status') {
  if (fs.existsSync(path.join(dir, 'daemon-started'))) console.log('─── Daemon Status ───\n  PID              : 4242\n  Connection       : connected\n─────────────────────');
  else console.log('No daemon is running.');
} else if (args[0] === 'connect') {
  if (process.env.FAKE_LH_CONNECT_FAIL) { console.error('connect failed'); process.exit(1); }
  if (process.env.FAKE_LH_CONNECT_DELAY_MS) { setTimeout(() => process.exit(0), Number(process.env.FAKE_LH_CONNECT_DELAY_MS)); return; }
  if (fs.existsSync(path.join(dir, 'daemon-started'))) { console.error('Daemon is already running (PID 4242).'); process.exit(1); }
  // "daemon start": the machine shows up as an online device (unless one is already listed)
  if (!fs.existsSync(path.join(dir, 'devices.json'))) fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([{ deviceId: 'dev_DAEMON', hostname: 'fake', platform: process.platform, online: true, channels: [{ channel: 'cli', connectedAt: new Date().toISOString() }] }]));
  fs.appendFileSync(path.join(dir, 'connects.log'), 'start\n');
  fs.writeFileSync(path.join(dir, 'daemon-started'), '1');
  console.log('Daemon started (PID 4242).');
} else if (args[0] === 'agent' && args[1] === 'edit') {
  if (process.env.FAKE_LH_NO_AGENCY && args.includes('--agency-config-file')) { console.error("error: unknown option '--agency-config-file'"); process.exit(1); }
  const editDelay = Number(process.env.FAKE_LH_EDIT_DELAY_MS || 0);
  if (editDelay) { setTimeout(() => { fs.appendFileSync(path.join(dir, 'edits.log'), JSON.stringify({ agentId: args[2], systemRole: 'late' }) + '\n'); console.log('updated'); }, editDelay); return; }
  const rec = { agentId: args[2], systemRole: args.includes('-s') ? args[args.indexOf('-s') + 1] : null };
  if (args.includes('-m')) { rec.model = args[args.indexOf('-m') + 1]; rec.provider = args[args.indexOf('-p') + 1]; }
  const i = args.indexOf('--agency-config-file');
  if (i >= 0) rec.agencyConfig = JSON.parse(fs.readFileSync(args[i + 1], 'utf8'));
  fs.appendFileSync(path.join(dir, 'edits.log'), JSON.stringify(rec) + '\n');
  console.log('updated');
} else if ((args[0] === 'provider' || args[0] === 'model') && process.env.FAKE_LH_NO_MODELS) {
  console.error(`error: unknown command '${args[0]}'`);
  process.exit(1);
} else if (args[0] === 'provider' && args[1] === 'list') {
  // like a LobeHub account: the hosted provider plus the user's own OpenAI key; Anthropic off
  console.log(JSON.stringify([{ id: 'lobehub', enabled: true }, { id: 'openai', enabled: true }, { id: 'anthropic', enabled: false }, { id: 'glmcodingplan', enabled: true }]));
} else if (args[0] === 'model' && args[1] === 'list') {
  fs.appendFileSync(path.join(dir, 'model-lists.log'), args[2] + '\n');
  const chat = (id, displayName, extra = {}) => ({ id, displayName, enabled: true, type: 'chat', abilities: { functionCall: true }, ...extra });
  const catalogs = {
    lobehub: [chat('deepseek-flash', 'DeepSeek V4.1 Flash'), chat('claude-opus-5-5', 'Claude Opus 5.5'), chat('claude-sonnet-5-5', 'Claude Sonnet 5.5'), chat('claude-haiku-5-5', 'Claude Haiku 5.5'),
      chat('grok-4.7', 'Grok 4.7'), chat('gemini-3.8-flash', 'Gemini 3.8 Flash'), chat('gemini-3.1-flash-image', 'Nano Banana 2', { abilities: { imageOutput: true } }),
      chat('gpt-6-sol', 'GPT-6 Sol'), chat('gpt-6-luna', 'GPT-6 Luna'), chat('glm-5.3', 'GLM-5.3')],
    openai: [chat('gpt-6-luna', 'GPT-6 Luna'), chat('o3', 'o3')],
  };
  console.log(JSON.stringify((catalogs[args[2]] || []).map((m) => ({ ...m, providerId: args[2] }))));
} else if (args[0] === 'agent' && args[1] === 'view') {
  console.log(JSON.stringify({ id: args[2], systemRole: 'x', agencyConfig: {} }));
} else if (args[0] === 'file' && args[1] === 'upload') {
  console.log(JSON.stringify({ id: 'file_FAKE1' }));
} else if (args[0] === 'topic' && args[1] === 'create') {
  console.log('✓ Created topic tpc_FAKETOPIC');
} else if (args[0] === 'message' && args[1] === 'create') {
  console.log(JSON.stringify({ id: 'msg_FAKE1' }));
} else if (args[0] === 'message' && args[1] === 'add-files') {
  console.log('✓ Added 1 file(s)');
} else if (args[0] === 'agent' && args[1] === 'delete') {
  console.log('✓ Deleted agent');
} else if (args[0] === 'agent' && args[1] === 'run') {
  if (process.env.FAKE_LH_FAIL_RUN === 'timeout') { setTimeout(() => {}, 60000); return; }
  if (process.env.FAKE_LH_FAIL_RUN === 'badflag') { console.error("error: unknown option '--json'"); process.exit(1); }
  if (process.env.FAKE_LH_FAIL_RUN === 'auth') { console.error('Not logged in. Run `lh login` first.'); process.exit(1); }
  if (process.env.FAKE_LH_FAIL_RUN === 'empty') { console.log('[]'); process.exit(0); }
  if (process.env.FAKE_LH_FAIL_RUN) { console.error('boom'); process.exit(1); }
  const prompt = args[args.indexOf('-p') + 1];
  const topic = args.includes('-t') ? args[args.indexOf('-t') + 1] : 'tpc_FAKE1';
  if (process.env.FAKE_LH_NO_DEVICE_FLAG && args.includes('--device')) { console.error("error: unknown option '--device'"); process.exit(1); }
  const tools = args.map((a, i) => (a === '--tool' ? args[i + 1] : null)).filter(Boolean);
  const device = args.includes('--device') ? args[args.indexOf('--device') + 1] : null;
  fs.appendFileSync(path.join(dir, 'runs.log'), JSON.stringify({ prompt, tools, device }) + '\n');
  const out = JSON.stringify([
    { type: 'agent_runtime_init', data: { topicId: topic } },
    { type: 'stream_end', data: { finalContent: process.env.FAKE_LH_LONG_REPLY ? Array.from({ length: 14 }, (_, i) => `第${i + 1}行：这是一条很长很长的回复，用来检查气泡会不会滚动。`).join('\n') : `echo: ${prompt.split('\n').pop()}`, usage: { cost: 0.001 } } },
  ]);
  const delay = Number(process.env.FAKE_LH_RUN_DELAY_MS || 0);
  if (delay) setTimeout(() => console.log(out), delay);
  else console.log(out);
} else { console.error('unknown'); process.exit(2); }
