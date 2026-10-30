'use strict';

// A turn that may use THIS computer, sent straight to LobeHub's Responses API (`/api/v1/responses`).
// The local tools are function tools the app runs itself: the server parks the run on a call, the app
// executes it here and posts the result back. No `lh connect` device sits in between, so a tool step costs
// one HTTP round trip instead of a cloud → device dispatch. A response id is the LobeHub topic id, so these
// turns continue the same chat history that `lh agent run` writes.
//
// Auth comes from the LobeHub CLI: LOBEHUB_CLI_API_KEY when set, otherwise the token `lh login` stored. That
// file is the CLI's private format (see readCliCredentials); when it cannot be read, available() is false and
// the app keeps using `lh connect`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const OFFICIAL_SERVER = 'https://app.lobehub.com';
const MAX_STEPS = 12; // tool round trips in one turn
const OUTPUT_LIMIT = 50000; // characters of a tool result sent back to the model
const COMMAND_TIMEOUT_MS = 60000;
const EXPIRY_MARGIN_S = 60;

const cliHome = (env = process.env) => path.join(os.homedir(), env.LOBEHUB_CLI_HOME || '.lobehub');

// The CLI keeps its login as base64(iv(12) + authTag(16) + AES-256-GCM ciphertext), keyed by this machine's
// hostname and user (apps/cli/src/auth/credentials.ts). Older versions wrote plain JSON. Null when unreadable.
function readCliCredentials({ env = process.env, hostname = os.hostname(), username = os.userInfo().username } = {}) {
  let data;
  try {
    data = fs.readFileSync(path.join(cliHome(env), 'credentials.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const packed = Buffer.from(data, 'base64');
    const key = crypto.pbkdf2Sync(`lobehub-cli:${hostname}:${username}`, 'lobehub-cli-salt', 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const creds = JSON.parse(decipher.update(packed.subarray(28)) + decipher.final('utf8'));
    return creds && creds.accessToken ? creds : null;
  } catch {
    try {
      const creds = JSON.parse(data);
      return creds && creds.accessToken ? creds : null;
    } catch {
      return null;
    }
  }
}

function serverUrl(env = process.env) {
  let url = env.LOBEHUB_SERVER;
  if (!url) {
    try {
      url = JSON.parse(fs.readFileSync(path.join(cliHome(env), 'settings.json'), 'utf8')).serverUrl;
    } catch { /* official cloud */ }
  }
  return (url || OFFICIAL_SERVER).replace(/\/$/, '');
}

class ResponsesError extends Error {
  constructor(message, { code, status, toolsRan = false } = {}) {
    super(message);
    this.name = 'ResponsesError';
    this.code = code;
    this.status = status;
    // A local tool already ran this turn: re-running the turn another way could repeat what it did.
    this.toolsRan = toolsRan;
  }
}

// ---- local tools -------------------------------------------------------------------------------------
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const LOCAL_FUNCTION_TOOLS = [
  { type: 'function', name: 'read_file', description: 'Read a UTF-8 text file on the owner\'s computer (up to 1 MB). Use an absolute path.', parameters: obj({ path: { type: 'string' } }, ['path']) },
  { type: 'function', name: 'list_directory', description: 'List a folder on the owner\'s computer (names, "/" marks a folder). Use an absolute path.', parameters: obj({ path: { type: 'string' } }, ['path']) },
  { type: 'function', name: 'write_file', description: 'Create or overwrite a UTF-8 text file on the owner\'s computer. Ask the owner first before overwriting anything important.', parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  { type: 'function', name: 'run_command', description: `Run a shell command on the owner's computer (${process.platform}) and get its exit code and output. Stops after ${COMMAND_TIMEOUT_MS / 1000}s.`, parameters: obj({ command: { type: 'string' }, cwd: { type: 'string' } }, ['command']) },
];

const expand = (p) => {
  const s = String(p || '');
  if (!s) throw new Error('path is required');
  return s === '~' || s.startsWith('~/') ? path.join(os.homedir(), s.slice(1)) : s;
};

function runCommand({ command, cwd }, signal) {
  return new Promise((resolve, reject) => {
    // the command must not act inside the pet's own LobeHub session
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LOBEHUB_')));
    const child = spawn(String(command), { cwd: cwd ? expand(cwd) : os.homedir(), shell: true, windowsHide: true, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let killed = null;
    const stop = (why) => {
      killed = killed || why;
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => stop('timeout'), COMMAND_TIMEOUT_MS);
    const onAbort = () => stop('canceled');
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { output = (output + d).slice(-OUTPUT_LIMIT); });
    child.on('error', (e) => { done(); reject(e); });
    child.on('close', (code) => {
      done();
      resolve(killed === 'timeout' ? `stopped after ${COMMAND_TIMEOUT_MS / 1000}s\n${output}` : `exit ${code}\n${output}`);
    });
  });
}

async function runLocalTool(name, args, signal) {
  if (name === 'read_file') {
    const p = expand(args.path);
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > 1024 * 1024) throw new Error(`file is ${st.size} bytes; only files up to 1 MB can be read`);
    return (await fs.promises.readFile(p, 'utf8')).slice(0, OUTPUT_LIMIT);
  }
  if (name === 'list_directory') {
    const entries = await fs.promises.readdir(expand(args.path), { withFileTypes: true });
    const shown = entries.slice(0, 500).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
    return entries.length > shown.length ? `${shown.join('\n')}\n… ${entries.length - shown.length} more` : shown.join('\n') || '(empty)';
  }
  if (name === 'write_file') {
    const p = expand(args.path);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, String(args.content ?? ''), 'utf8');
    return `wrote ${Buffer.byteLength(String(args.content ?? ''))} bytes to ${p}`;
  }
  if (name === 'run_command') return runCommand(args, signal);
  throw new Error(`unknown tool ${name}`);
}

// ---- the client ----------------------------------------------------------------------------------------
class ResponsesClient {
  // `lh`: the LhClient, for the pet's workspace scope and to let the CLI refresh an expired login.
  constructor({ lh, fetchImpl = (...a) => fetch(...a), env = process.env, readCredentials = () => readCliCredentials({ env }), runTool = runLocalTool, now = () => Date.now() } = {}) {
    this.lh = lh;
    this.fetch = fetchImpl;
    this.env = env;
    this.readCredentials = readCredentials;
    this.runTool = runTool;
    this.now = now;
    this._active = new Set();
    this._pinned = undefined; // lh's saved workspace, looked up once for pets from before spaces were chosen
  }

  // Can a turn go this way at all? Only looks at local files, never the network.
  available() {
    return !!(this.env.LOBEHUB_CLI_API_KEY || this.readCredentials());
  }

  async _token() {
    if (this.env.LOBEHUB_CLI_API_KEY) return this.env.LOBEHUB_CLI_API_KEY;
    let creds = this.readCredentials();
    const expired = (c) => c && c.expiresAt && c.expiresAt - EXPIRY_MARGIN_S < this.now() / 1000;
    // Any authenticated lh call refreshes and re-saves the login; then read it again.
    if (!creds || expired(creds)) {
      await this.lh.whoami().catch(() => null);
      creds = this.readCredentials();
    }
    if (!creds || expired(creds)) throw new ResponsesError('LobeHub login is missing or expired', { code: 'EAUTH' });
    return creds.accessToken;
  }

  async _workspaceId() {
    const ws = this.lh.workspaceId;
    if (ws !== undefined) return ws;
    if (this.env.LOBEHUB_WORKSPACE_ID) return this.env.LOBEHUB_WORKSPACE_ID;
    if (this._pinned === undefined) this._pinned = await this.lh.pinnedWorkspace().catch(() => null);
    return this._pinned;
  }

  cancel() {
    for (const ac of this._active) ac.abort();
  }

  // Same contract as LhClient#run: { text, topicId, cost }. With `tools` empty the model gets no tools.
  async run({ agentId, prompt, topicId, timeoutMs = 120000, tools = [] }) {
    const ac = new AbortController();
    this._active.add(ac);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    let toolsRan = false;
    try {
      const headers = { Authorization: `Bearer ${await this._token()}`, 'Content-Type': 'application/json' };
      const ws = await this._workspaceId();
      if (ws) headers['X-Workspace-Id'] = ws;
      const url = `${serverUrl(this.env)}/api/v1/responses`;
      const functionTools = tools.length ? LOCAL_FUNCTION_TOOLS : [];
      let body = { model: agentId, input: prompt, previous_response_id: topicId || undefined };
      let cost = null;
      for (let step = 0; step < MAX_STEPS; step++) {
        if (ac.signal.aborted) break;
        const res = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false, tools: functionTools, tools_mode: 'exclusive' }), signal: ac.signal });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new ResponsesError(`Responses API HTTP ${res.status}: ${detail.slice(0, 200)}`, { code: res.status === 401 || res.status === 403 ? 'EAUTH' : 'EAPI', status: res.status, toolsRan });
        }
        const r = await res.json();
        if (r.status === 'failed') throw new ResponsesError(`Responses API: ${(r.error && r.error.message) || 'failed'}`, { code: 'EAPI', toolsRan });
        if (r.usage && typeof r.usage.cost === 'number') cost = (cost || 0) + r.usage.cost;
        const calls = (r.output || []).filter((o) => o && o.type === 'function_call');
        if (!calls.length) {
          const text = (r.output_text || (r.output || []).flatMap((o) => (o && o.type === 'message' && o.content) || []).filter((p) => p.type === 'output_text').map((p) => p.text).join('')).trim();
          if (!text) throw new ResponsesError('Agent produced no reply', { code: 'ENOREPLY', toolsRan });
          return { text, topicId: r.id || topicId || null, cost };
        }
        if (!functionTools.length) throw new ResponsesError('The agent asked for a local tool, but local abilities are off', { code: 'EAPI', toolsRan });
        const input = [];
        for (const call of calls) {
          let output;
          try {
            toolsRan = true;
            output = await this.runTool(call.name, JSON.parse(call.arguments || '{}'), ac.signal);
          } catch (e) {
            if (ac.signal.aborted) break;
            output = `Error: ${e.message}`;
          }
          input.push({ type: 'function_call_output', call_id: call.call_id, output: String(output) });
        }
        // the parked run waits on this topic; strict: a stale result must not become a new user turn
        body = { model: agentId, input, previous_response_id: r.id, strict_tool_resume: true };
      }
      if (!ac.signal.aborted) throw new ResponsesError(`More than ${MAX_STEPS} local tool steps in one turn`, { code: 'EAPI', toolsRan });
    } catch (e) {
      if (!ac.signal.aborted) {
        if (e instanceof ResponsesError) throw e;
        throw new ResponsesError(`Responses API unreachable: ${e.message}`, { code: 'ENET', toolsRan });
      }
    } finally {
      clearTimeout(timer);
      this._active.delete(ac);
    }
    throw new ResponsesError(timedOut ? `Responses API timed out after ${timeoutMs}ms` : 'Canceled', { code: timedOut ? 'ETIMEDOUT' : 'ECANCELED', toolsRan });
  }
}

module.exports = { ResponsesClient, ResponsesError, LOCAL_FUNCTION_TOOLS, runLocalTool, readCliCredentials, serverUrl };
