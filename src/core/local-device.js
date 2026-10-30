'use strict';

// Lets the pet's LobeHub agent use THIS computer (read/write files, search, run commands).
// LobeHub routes an agent's local tools to a "device" the account has online: either the
// LobeHub desktop app or `lh connect`. (When the Responses API is reachable the app runs the
// tools itself instead, see core/responses-client.js; a device is the fallback.)
// The agent is bound to a device through
// agencyConfig.boundDeviceId, so the app (a) finds this machine's online device, starting
// `lh connect --daemon` only if none is online, and (b) binds the pet's agent to it.

const os = require('node:os');

const norm = (h) => String(h || '').toLowerCase().replace(/\.local$/, '');
const LOCAL_TOOLS = ['lobe-local-system'];

// Choose this machine's device among the account's devices. Hostnames are not reliable
// (the desktop app reports "Mac"), so platform + online wins, hostname breaks ties.
function pickDevice(devices, { platform = process.platform, hostname = os.hostname() } = {}) {
  const online = (devices || []).filter((d) => d && d.online && d.platform === platform);
  if (online.length === 0) return null;
  if (online.length === 1) return online[0];
  const sameHost = online.find((d) => norm(d.hostname) === norm(hostname) || (d.channels || []).some((c) => norm(c.hostname) === norm(hostname)));
  if (sameHost) return sameHost;
  const newest = (d) => Math.max(0, ...(d.channels || []).map((c) => Date.parse(c.connectedAt) || 0));
  return [...online].sort((a, b) => newest(b) - newest(a))[0];
}

// Always makes sure the `lh connect` daemon is running (the user wants it up whenever the pet
// is), then waits for this computer's device. Returns { deviceId, via, daemon }.
//  - via 'daemon': the daemon is running (or was just started).
//  - via 'existing': the daemon could not be started, but a device (e.g. the LobeHub desktop app)
//    is online, so local tools still work; `daemon.error` says why.
async function ensureLocalDevice(lh, { waitMs = 20000, intervalMs = 1000, platform, hostname, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const daemon = { running: false, started: false, error: null };
  try {
    const st = await lh.daemonStatus();
    if (st.running) daemon.running = true;
    else {
      await lh.startConnectDaemon();
      daemon.started = true;
    }
  } catch (e) {
    daemon.error = e.message;
  }
  const find = async () => pickDevice(await lh.listDevices(), { platform, hostname });
  let d = await find();
  for (let waited = 0; !d && !daemon.error && waited < waitMs; waited += intervalMs) {
    await sleep(intervalMs);
    d = await find();
  }
  if (d) return { deviceId: d.deviceId, via: daemon.error ? 'existing' : 'daemon', daemon };
  if (daemon.error) throw new Error(`Could not start \`lh connect\` (${daemon.error}) and no device of this computer is online.`);
  throw new Error('Started `lh connect` but this computer did not show up as an online device. Check `lh connect status` / `lh connect logs`.');
}

const bindConfig = (deviceId) => ({ boundDeviceId: deviceId, executionTarget: 'local' });
const unbindConfig = () => ({ boundDeviceId: null });

module.exports = { pickDevice, ensureLocalDevice, bindConfig, unbindConfig, LOCAL_TOOLS };
