'use strict';

// Thin wrapper around the LobeHub CLI (`lh`). The app never talks to the
// LobeHub API directly; swapping the harness means swapping this file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findLh, withToolPath, spawnTarget } = require('./lh-path');

// Variables that make `lh` attach its output to someone else's run. They are
// only ever set when we are launched from inside an agent run (dev/CI).
const RUN_CONTEXT_VARS = [
  'LOBEHUB_TOPIC_ID',
  'LOBEHUB_OPERATION_ID',
  'LOBEHUB_AGENT_ID',
  'LOBEHUB_ASSISTANT_MESSAGE_ID',
  // The workspace scope is chosen per pet (see LhClient#setWorkspace), never inherited.
  'LOBEHUB_WORKSPACE_ID',
];

function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const k of RUN_CONTEXT_VARS) delete env[k];
  if (env.PIXELPET_CLEAR_JWT === '1') env.LOBEHUB_JWT = '';
  return env;
}

class LhError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = 'LhError';
    this.code = code;
    this.stderr = stderr;
  }
}

// `settleOn(stdout)`: for commands whose output is complete before the process exits. Once it returns an exit
// code the call resolves with it and the (idle) process is stopped, instead of waiting for it to exit.
function runLh(bin, args, { timeoutMs = 120000, env, onStdout, onStderr, signal, settleOn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const target = spawnTarget(bin); // on Windows: node-style launch of lh's JS entry, never through a shell
      child = spawn(target.command, [...target.prefix, ...args], { env: { ...(env || cleanEnv()), ...target.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(new LhError(`Cannot start ${bin}: ${e.message}`));
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onStdout) onStdout(String(d));
      const code = !settled && settleOn ? settleOn(stdout) : undefined;
      if (code === undefined) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      child.kill('SIGTERM');
      resolve({ code, stdout, stderr });
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (onStderr) onStderr(String(d));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      reject(new LhError(e.code === 'ENOENT' ? `\`${bin}\` not found. Install the LobeHub CLI first: npm install -g @lobehub/cli` : e.message, { code: e.code }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) return reject(new LhError('Canceled', { code: 'ECANCELED', stderr }));
      if (timedOut) return reject(new LhError(`lh ${args[0]} timed out after ${timeoutMs}ms`, { code: 'ETIMEDOUT', stderr }));
      resolve({ code, stdout, stderr });
    });
  });
}

class LhClient {
  constructor({ bin, env } = {}) {
    this.bin = bin || findLh() || 'lh';
    this.env = env;
    // null = the personal space; a string = that workspace; undefined = whatever `lh` defaults to
    // (pets created before the choice existed live wherever lh pointed at the time).
    this.workspaceId = null;
  }

  // Where the pet's agent lives. Every later call (run, edit, topic, file, delete) must use the same
  // scope, or LobeHub cannot find the agent. `lh` takes the scope from LOBEHUB_WORKSPACE_ID first.
  setWorkspace(workspaceId) {
    this.workspaceId = workspaceId === undefined ? undefined : workspaceId || null;
  }

  _env() {
    const env = { ...(this.env || withToolPath(cleanEnv(), this.bin)) };
    if (this.workspaceId === undefined) {
      if (process.env.LOBEHUB_WORKSPACE_ID && !env.LOBEHUB_WORKSPACE_ID) env.LOBEHUB_WORKSPACE_ID = process.env.LOBEHUB_WORKSPACE_ID;
      return env;
    }
    delete env.LOBEHUB_WORKSPACE_ID;
    if (this.workspaceId) env.LOBEHUB_WORKSPACE_ID = this.workspaceId;
    return env;
  }

  // Every lh call is cancellable: cancel() stops all that are in flight (agent run, device lookup, daemon start...).
  async _run(args, opts = {}) {
    const ac = new AbortController();
    this._active = this._active || new Set();
    this._active.add(ac);
    try {
      return await runLh(this.bin, args, { env: this._env(), signal: ac.signal, ...opts });
    } finally {
      this._active.delete(ac);
    }
  }

  // The user pressed Stop (or Esc): kill whatever lh is doing right now.
  cancel() {
    for (const ac of this._active || []) ac.abort();
  }

  // ---- workspaces -----------------------------------------------------------
  // Workspaces the user belongs to: [{ id, slug, name }]. An older lh without the command lists none.
  async listWorkspaces() {
    const r = await this._run(['workspace', 'list', '--json'], { timeoutMs: 30000 });
    if (r.code !== 0) return [];
    try {
      const list = JSON.parse(r.stdout);
      return Array.isArray(list) ? list.filter((w) => w && w.id).map((w) => ({ id: w.id, slug: w.slug || null, name: w.name || w.slug || w.id })) : [];
    } catch {
      return [];
    }
  }

  // A scope saved with `lh workspace use` applies to every call that does not name one, so with it set a
  // personal pet would land in that workspace. Returns its id, or null when calls default to personal.
  async pinnedWorkspace() {
    const saved = this.workspaceId;
    this.workspaceId = null;
    try {
      const r = await this._run(['workspace', 'current', '--json'], { timeoutMs: 30000 });
      if (r.code !== 0) return null;
      const cur = JSON.parse(r.stdout);
      return cur && cur.source === 'settings' && cur.workspaceId ? cur.workspaceId : null;
    } catch {
      return null;
    } finally {
      this.workspaceId = saved;
    }
  }

  // Only after the user agreed: clear the saved scope so calls without one go to the personal space.
  async usePersonal() {
    const r = await this._run(['workspace', 'use', '--personal'], { timeoutMs: 30000 });
    if (r.code !== 0) throw new LhError(`Could not switch lh back to the personal space: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
  }

  // ---- agent configuration -------------------------------------------------
  // Update the system role, the model (`model` + `provider`) and/or agencyConfig (deep-merged
  // server-side; `null` clears a key).
  async updateAgent({ agentId, systemRole, agencyConfig, model, provider }) {
    const args = ['agent', 'edit', agentId];
    if (systemRole) args.push('-s', systemRole);
    if (model) args.push('-m', model, '-p', provider);
    let tmp = null;
    if (agencyConfig) {
      tmp = path.join(os.tmpdir(), `pixelpet-agency-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(agencyConfig));
      args.push('--agency-config-file', tmp);
    }
    try {
      const r = await this._run(args, { timeoutMs: 60000 });
      if (r.code !== 0) throw new LhError(`Could not update agent: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, { code: r.code, stderr: r.stderr });
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  }

  // ---- models ----------------------------------------------------------------
  // Ids of the providers the user has enabled (LobeHub's hosted `lobehub` is on by default).
  async listEnabledProviders() {
    const r = await this._run(['provider', 'list', '--json'], { timeoutMs: 30000 });
    if (r.code !== 0) throw new LhError(`Could not list providers: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
    const list = JSON.parse(r.stdout);
    return (Array.isArray(list) ? list : list.data || []).filter((p) => p && p.enabled).map((p) => p.id);
  }

  // The enabled chat models of one provider: [{ id, displayName, providerId, enabled, type, abilities }].
  async listChatModels(providerId) {
    const r = await this._run(['model', 'list', providerId, '--type', 'chat', '--enabled', '-L', '200', '--json'], { timeoutMs: 30000 });
    if (r.code !== 0) throw new LhError(`Could not list models of ${providerId}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
    const list = JSON.parse(r.stdout);
    return (Array.isArray(list) ? list : list.data || []).map((m) => ({ id: m.id, displayName: m.displayName, providerId: m.providerId || providerId, enabled: m.enabled !== false, type: m.type, abilities: m.abilities || {} }));
  }

  async getAgent(agentId) {
    const r = await this._run(['agent', 'view', agentId, '--json'], { timeoutMs: 30000 });
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }

  // ---- devices (this machine as a tool host) --------------------------------
  async listDevices() {
    const r = await this._run(['device', 'list', '--json'], { timeoutMs: 30000 });
    if (r.code !== 0) throw new LhError(`Could not list devices: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
    try {
      const list = JSON.parse(r.stdout);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // Is the background `lh connect` daemon running? Parses `lh connect status`
  // ("No daemon is running." or a block with "PID : n" and "Connection : state").
  async daemonStatus() {
    const r = await this._run(['connect', 'status'], { timeoutMs: 15000 });
    const out = r.stdout + r.stderr;
    const pid = out.match(/PID\s*:\s*(\d+)/);
    const conn = out.match(/Connection\s*:\s*(\S+)/);
    return { running: !!pid, pid: pid ? Number(pid[1]) : null, connection: conn ? conn[1] : null };
  }

  // `lh connect --daemon` forks a background process and returns. It exits 1 with
  // "already running" when one exists, which for our purposes is success.
  async startConnectDaemon() {
    if (process.env.PIXELPET_NO_CONNECT === '1') throw new LhError('lh connect is disabled in this environment (PIXELPET_NO_CONNECT=1)', { code: 'ENOCONNECT' });
    const r = await this._run(['connect', '--daemon'], { timeoutMs: 45000 });
    const out = r.stdout + r.stderr;
    if (r.code !== 0 && !/already running/i.test(out)) throw new LhError(`lh connect failed: ${out.trim().slice(0, 300)}`, { code: r.code, stderr: r.stderr });
  }

  // ---- speech recognition (core/asr.js) ----------------------------------------
  // `lh generate asr <file> --provider lobehub --model <m> [--language <l>] --json` -> { code, stdout, stderr }.
  // Same environment as every other call (cleanEnv, tool PATH), but not stopped by cancel(): pressing Stop on
  // a chat turn must not drop what the owner just said. The caller's `signal` stops it instead.
  asr(file, { model, language, provider = 'lobehub', timeoutMs = 30000, signal } = {}) {
    const args = ['generate', 'asr', file, '--provider', provider, '--model', model, '--json'];
    if (language) args.push('--language', language);
    return runLh(this.bin, args, { env: this._env(), timeoutMs, signal });
  }

  // ---- images ---------------------------------------------------------------
  // upload -> user message with the picture(s) in the topic; the next agent run sees it as context.
  async uploadFile(filePath) {
    const r = await this._run(['file', 'upload', '-f', filePath, '--json'], { timeoutMs: 120000 });
    let id = null;
    try {
      id = JSON.parse(r.stdout).id;
    } catch { /* fall through */ }
    if (r.code !== 0 || !id) throw new LhError(`Could not upload ${path.basename(filePath)}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
    return id;
  }

  async createTopic(agentId, title = 'Pixel Pet') {
    const r = await this._run(['topic', 'create', '--agent-id', agentId, '-t', title], { timeoutMs: 30000 });
    const m = (r.stdout + r.stderr).match(/\btpc_[A-Za-z0-9]+\b/);
    if (r.code !== 0 || !m) throw new LhError(`Could not create topic: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
    return m[0];
  }

  async createUserMessage({ agentId, topicId, content }) {
    const r = await this._run(['message', 'create', '-r', 'user', '-c', content, '--agent-id', agentId, '--topic-id', topicId, '--json'], { timeoutMs: 30000 });
    let id = null;
    try {
      id = JSON.parse(r.stdout).id;
    } catch { /* fall through */ }
    if (r.code !== 0 || !id) throw new LhError(`Could not create message: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
    return id;
  }

  async addFilesToMessage(messageId, fileIds) {
    const r = await this._run(['message', 'add-files', messageId, '--file-ids', fileIds.join(',')], { timeoutMs: 30000 });
    if (r.code !== 0) throw new LhError(`Could not attach files: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, { code: r.code, stderr: r.stderr });
  }

  async deleteFiles(fileIds) {
    for (const id of fileIds) await this._run(['file', 'delete', id], { timeoutMs: 30000 }).catch(() => {});
  }

  // Returns the logged-in user, or null when not authenticated.
  async whoami() {
    const r = await this._run(['whoami', '--json'], { timeoutMs: 30000 });
    if (r.code !== 0) return null;
    try {
      const u = JSON.parse(r.stdout);
      return { name: u.fullName || u.username || u.email || 'unknown', username: u.username, email: u.email };
    } catch {
      return null;
    }
  }

  // Starts the browser device-code login. The CLI prints
  //   "Open this URL in your browser:\n  <url>\n\n  Enter code: <code>"
  // on separate lines and opens the browser itself. `onPrompt({url, code,
  // browserFailed})` fires once both are known (or shortly after the URL alone),
  // and again with browserFailed=true if the CLI could not open a browser.
  async login({ onPrompt = () => {}, timeoutMs = 10 * 60 * 1000 } = {}) {
    let buf = '';
    let announced = false;
    let browserFailed = false;
    let timer = null;
    let last = null;
    const emit = (url, code) => {
      announced = true;
      clearTimeout(timer);
      last = { url, code };
      onPrompt({ url, code, browserFailed });
    };
    const scan = (chunk) => {
      buf += chunk;
      const url = buf.match(/https?:\/\/[^\s)]+/);
      const code = buf.match(/Enter code:\s*([A-Za-z0-9-]+)/i) || buf.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      if (!announced && url && code) emit(url[0], code[1]);
      else if (!announced && url && !timer) timer = setTimeout(() => { if (!announced) emit(url[0], code ? code[1] : null); }, 1500);
      if (announced && !browserFailed && /could not open browser/i.test(buf)) {
        browserFailed = true;
        onPrompt({ ...last, browserFailed: true });
      }
    };
    let r;
    try {
      r = await this._run(['login'], { timeoutMs, onStdout: scan, onStderr: scan });
    } finally {
      clearTimeout(timer);
    }
    if (r.code !== 0) throw new LhError(`lh login failed (exit ${r.code})`, { code: r.code, stderr: r.stderr });
    return this.whoami();
  }

  // Creates the pet's agent. `lh agent create` has no --json, so the id is
  // parsed from its human-readable output.
  async createAgent({ title, description, systemRole }) {
    const args = ['agent', 'create', '-t', title, '-s', systemRole];
    if (description) args.push('-d', description);
    const r = await this._run(args, { timeoutMs: 60000 });
    const m = (r.stdout + r.stderr).match(/\bagt_[A-Za-z0-9]+\b/);
    if (r.code !== 0 || !m) throw new LhError(`Could not create agent: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, { code: r.code, stderr: r.stderr });
    return { agentId: m[0] };
  }

  async deleteAgent(agentId) {
    const r = await this._run(['agent', 'delete', agentId, '--yes'], { timeoutMs: 30000 });
    return r.code === 0;
  }

  // One conversational turn. Reusing `topicId` keeps the pet's long-term
  // history inside LobeHub. Returns { text, topicId, cost }.
  async run({ agentId, prompt, topicId, timeoutMs = 120000, tools = [], device = null }) {
    const base = ['agent', 'run', '-a', agentId, '-p', prompt, '--json'];
    if (topicId) base.push('-t', topicId);
    // Optional flags (a specific tool, a specific device). An lh that does not know one of them must not
    // cost the user the turn: drop the flag the CLI complained about and retry.
    const optional = [];
    for (const t of tools) optional.push({ flag: '--tool', args: ['--tool', t] });
    if (device) optional.push({ flag: '--device', args: ['--device', device] });
    for (;;) {
      try {
        return await this._runAgent([...base, ...optional.flatMap((o) => o.args)], timeoutMs);
      } catch (e) {
        const bad = e.code === 'ECLI' && optional.find((o) => e.message.includes(o.flag));
        if (!bad) throw e;
        for (let i = optional.length - 1; i >= 0; i--) if (optional[i].flag === bad.flag) optional.splice(i, 1);
      }
    }
  }

  async _runAgent(args, timeoutMs) {
    // No --timeout flag: newer lh releases reject it. We enforce the limit ourselves (see runLh).
    // lh prints the events as soon as the run ends but then idles on a keep-alive socket for ~15s before it
    // exits; the reply must not wait for that.
    const r = await this._run(args, { timeoutMs, settleOn: runEndCode });
    const parsed = parseRunEvents(r.stdout);
    if (parsed.text) return parsed;
    const detail = (r.stderr || r.stdout).trim().slice(0, 300);
    if (/unknown option|unknown command|too many arguments|missing required argument/i.test(detail)) {
      throw new LhError(`This lh version is not compatible with the app: ${detail}`, { code: 'ECLI', stderr: r.stderr });
    }
    if (/not logged in|unauthori[sz]ed|\b401\b|expired|credential|lh login/i.test(detail)) {
      throw new LhError(`LobeHub login is missing or expired: ${detail}`, { code: 'EAUTH', stderr: r.stderr });
    }
    if (r.code !== 0) throw new LhError(`Agent run failed (exit ${r.code}): ${detail}`, { code: r.code, stderr: r.stderr });
    throw new LhError('Agent produced no reply', { code: 'ENOREPLY', stderr: r.stderr });
  }
}

// The exit code `lh agent run --json` will end with, once its stdout holds the whole event array up to the
// terminal event (`agent_runtime_end`, or `error`); undefined while the run is still going.
function runEndCode(stdout) {
  const out = stdout.trim();
  if (!out.endsWith(']')) return undefined;
  let events;
  try {
    events = JSON.parse(out.slice(out.indexOf('[')));
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  const end = events.find((e) => e && (e.type === 'agent_runtime_end' || e.type === 'error'));
  if (!end) return undefined;
  return end.type === 'agent_runtime_end' && !(end.data && end.data.reason) ? 0 : 1;
}

// Extract the final reply from `lh agent run --json` output (a JSON array of events).
function parseRunEvents(stdout) {
  let events;
  try {
    events = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('[');
    try {
      events = JSON.parse(stdout.slice(start));
    } catch {
      return { text: '', topicId: null, cost: null };
    }
  }
  if (!Array.isArray(events)) return { text: '', topicId: null, cost: null };
  let text = '';
  let topicId = null;
  let cost = null;
  for (const e of events) {
    if (e.type === 'agent_runtime_init' && e.data && e.data.topicId) topicId = e.data.topicId;
    // Newer CLI versions no longer put the topic on the init event; it rides on the assistant message.
    if (!topicId && e.type === 'stream_start' && e.data && e.data.assistantMessage && e.data.assistantMessage.topicId) topicId = e.data.assistantMessage.topicId;
    if (e.type === 'stream_end' && e.data) {
      if (typeof e.data.finalContent === 'string' && e.data.finalContent.trim()) text = e.data.finalContent.trim();
      if (e.data.usage && typeof e.data.usage.cost === 'number') cost = (cost || 0) + e.data.usage.cost;
    }
  }
  return { text, topicId, cost };
}

module.exports = { LhClient, LhError, runLh, cleanEnv, parseRunEvents, runEndCode, RUN_CONTEXT_VARS };
