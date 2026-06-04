#!/usr/bin/env node

import http from 'http';
import { randomUUID } from 'crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.CHROME_DEBUGGER_BRIDGE_PORT || '43827', 10);
const SERVER_BOOT_TIMEOUT_MS = 12000;
const COMMAND_TIMEOUT_MS = 35000;
const POLL_TIMEOUT_MS = 4000;
const EXTENSION_STALE_MS = 45000;
const EXTENSION_BOOT_TIMEOUT_MS = 12000;
const IS_WINDOWS = process.platform === 'win32';
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'chrome-debugger-bridge')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'chrome-debugger-bridge')
    : resolve(homedir(), '.cache', 'chrome-debugger-bridge');
const LOG_FILE = resolve(RUNTIME_DIR, 'bridge.log');
const STATE_FILE = resolve(RUNTIME_DIR, 'extension-state.json');

mkdirSync(RUNTIME_DIR, { recursive: true });

const USAGE = `chrome-debugger-bridge - real Chrome automation through an installed extension

Usage: bridge.mjs <command> [args]

  server                         Start the localhost bridge server
  list                           List controllable real Chrome tabs
  attach <tab>                   Attach debugger session to one tab
  close <tab>                    Close one real Chrome tab
  snap <tab>                     Accessibility tree snapshot
  eval <tab> <expr>              Evaluate page JavaScript
  html <tab> [selector]          Get HTML (page or CSS selector)
  click <tab> <selector>         Click an element by CSS selector
  type <tab> <text>              Insert text into the focused element
  nav <tab> <url>                Navigate tab and wait for load complete
  shot <tab> [file]              Save a screenshot PNG locally
  stop [tab]                     Detach one tab, or stop the bridge if no tab is given
  health                         Show bridge and extension status
`;

function errorPayload(code, message, details = undefined) {
  return { code, message, ...(details ? { details } : {}) };
}

function parseJsonRequest(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 10 * 1024 * 1024) {
        rejectPromise(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        rejectPromise(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function writeText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isExtensionConnected(state) {
  return Boolean(state.extension.lastSeenAt && Date.now() - state.extension.lastSeenAt < EXTENSION_STALE_MS);
}

function readPersistedExtensionState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persistExtensionState(extensionState) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(extensionState, null, 2));
  } catch {}
}

function formatList(tabs) {
  if (!tabs.length) return 'No controllable tabs found.';
  const rows = [...tabs].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.tabId - b.tabId;
  });
  return rows.map((tab) => {
    const id = String(tab.tabId).padEnd(6);
    const attached = (tab.attached ? 'attached' : 'detached').padEnd(10);
    const title = (tab.title || '').substring(0, 52).padEnd(52);
    return `${id}  ${attached}  ${title}  ${tab.url}`;
  }).join('\n');
}

function normalizeTabId(raw) {
  const tabId = Number(raw);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error(`Invalid tab id: ${raw}`);
  }
  return tabId;
}

function defaultShotPath(tabId) {
  return resolve(RUNTIME_DIR, `screenshot-${tabId}.png`);
}

function finalizeJobResult(job, payload) {
  switch (job.command) {
    case 'list':
      return formatList(payload.tabs || []);
    case 'attach':
      return `Attached tab ${job.payload.tabId}`;
    case 'close':
      return `Closed tab ${job.payload.tabId}`;
    case 'stop':
      if (job.payload?.tabId) return `Detached tab ${job.payload.tabId}`;
      return 'Bridge stopped.';
    case 'shot': {
      const out = job.payload.file || defaultShotPath(job.payload.tabId);
      if (!payload?.data) {
        throw Object.assign(new Error('Missing screenshot payload'), { code: 'EXECUTION_FAILED' });
      }
      writeFileSync(out, Buffer.from(payload.data, 'base64'));
      const dpr = payload.dpr || 1;
      const lines = [out];
      lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
      lines.push('Coordinate mapping:');
      lines.push(`  Screenshot pixels -> CSS pixels: divide by ${dpr}`);
      lines.push(`  Example: screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) -> CSS (100, 200)`);
      return lines.join('\n');
    }
    default:
      if (typeof payload === 'string') return payload;
      if (payload?.text && typeof payload.text === 'string') return payload.text;
      if (payload == null) return '';
      return JSON.stringify(payload, null, 2);
  }
}

function createState() {
  return {
    extension: {
      extensionId: null,
      version: null,
      instanceId: null,
      lastSeenAt: 0,
    },
    queue: [],
    waiters: [],
    pending: new Map(),
    server: null,
    shuttingDown: false,
  };
}

function registerExtensionSeen(state, info = {}) {
  state.extension.extensionId = info.extensionId || state.extension.extensionId;
  state.extension.version = info.version || state.extension.version;
  state.extension.instanceId = info.instanceId || state.extension.instanceId;
  state.extension.lastSeenAt = Date.now();
  persistExtensionState(state.extension);
}

function flushWaiters(state) {
  while (state.queue.length && state.waiters.length) {
    const waiter = state.waiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve(state.queue.shift());
  }
}

function nextJob(state, timeoutMs) {
  if (state.queue.length) {
    return Promise.resolve(state.queue.shift());
  }

  return new Promise((resolvePromise) => {
    const waiter = {
      resolve: (job) => resolvePromise(job),
      timer: setTimeout(() => {
        state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
        resolvePromise(null);
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

function enqueueJob(state, command, payload, timeoutMs) {
  if (!isExtensionConnected(state)) {
    const message = 'The Chrome extension is not connected to the localhost bridge. Load the unpacked extension and keep it enabled.';
    return Promise.reject(errorPayload('EXTENSION_UNAVAILABLE', message));
  }

  const jobId = randomUUID();
  const job = { jobId, command, payload };

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      state.pending.delete(jobId);
      rejectPromise(errorPayload('TIMEOUT', `Timed out waiting for "${command}" to finish.`));
    }, timeoutMs);

    state.pending.set(jobId, {
      job,
      resolve: (payloadFromExtension) => {
        clearTimeout(timer);
        state.pending.delete(jobId);
        try {
          resolvePromise(finalizeJobResult(job, payloadFromExtension));
        } catch (error) {
          rejectPromise(errorPayload(error.code || 'EXECUTION_FAILED', error.message));
        }
      },
      reject: (errorFromExtension) => {
        clearTimeout(timer);
        state.pending.delete(jobId);
        rejectPromise(errorFromExtension);
      },
    });

    state.queue.push(job);
    flushWaiters(state);
  });
}

async function detachAndStop(state) {
  if (isExtensionConnected(state)) {
    try {
      await enqueueJob(state, 'stop', {}, 5000);
    } catch {}
  }
  state.shuttingDown = true;
  setTimeout(() => {
    state.server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250);
  }, 20);
}

function logServerLine(text) {
  try {
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`, { flag: 'a' });
  } catch {}
}

async function runServer() {
  const state = createState();

  const server = http.createServer(async (req, res) => {
    logServerLine(`${req.method} ${req.url}`);
    if (req.method === 'OPTIONS') {
      writeText(res, 204, '');
      return;
    }

    try {
      if (req.url === '/health' && req.method === 'GET') {
        writeJson(res, 200, {
          ok: true,
          host: HOST,
          port: PORT,
          extensionConnected: isExtensionConnected(state),
          extension: {
            extensionId: state.extension.extensionId,
            version: state.extension.version,
            instanceId: state.extension.instanceId,
            lastSeenAt: state.extension.lastSeenAt || null,
          },
        });
        return;
      }

      if (req.url === '/v1/commands/execute' && req.method === 'POST') {
        const body = await parseJsonRequest(req);
        const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : COMMAND_TIMEOUT_MS;

        if (body.command === 'stop' && !body.payload?.tabId) {
          writeJson(res, 200, { ok: true, result: 'Bridge stopped.' });
          await detachAndStop(state);
          return;
        }

        try {
          const result = await enqueueJob(state, body.command, body.payload || {}, timeoutMs);
          writeJson(res, 200, { ok: true, result });
        } catch (error) {
          writeJson(res, 409, { ok: false, error });
        }
        return;
      }

      if (req.url === '/v1/extension/poll' && req.method === 'POST') {
        const body = await parseJsonRequest(req);
        registerExtensionSeen(state, body);
        const job = await nextJob(state, POLL_TIMEOUT_MS);
        registerExtensionSeen(state, body);
        writeJson(res, 200, { ok: true, job });
        return;
      }

      if (req.url === '/v1/extension/result' && req.method === 'POST') {
        const body = await parseJsonRequest(req);
        registerExtensionSeen(state, body);
        const pending = state.pending.get(body.jobId);
        if (!pending) {
          writeJson(res, 404, { ok: false, error: errorPayload('NOT_FOUND', 'Unknown job id') });
          return;
        }

        if (body.ok) {
          pending.resolve(body.payload);
        } else {
          pending.reject(body.error || errorPayload('EXECUTION_FAILED', 'Extension command failed.'));
        }
        writeJson(res, 200, { ok: true });
        return;
      }

      writeJson(res, 404, { ok: false, error: errorPayload('NOT_FOUND', 'Unknown route') });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: errorPayload('EXECUTION_FAILED', error.message) });
    }
  });

  server.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    logServerLine(`Bridge listening on http://${HOST}:${PORT}`);
  });

  state.server = server;

  const shutdown = () => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function httpJson(method, path, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString('utf8');
        });
        res.on('end', () => {
          if (!raw) {
            resolvePromise({});
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode && res.statusCode >= 400) {
              rejectPromise(parsed.error || errorPayload('EXECUTION_FAILED', `HTTP ${res.statusCode}`));
              return;
            }
            resolvePromise(parsed);
          } catch {
            rejectPromise(errorPayload('EXECUTION_FAILED', 'Invalid JSON response from bridge'));
          }
        });
      },
    );

    req.on('error', (error) => {
      rejectPromise(errorPayload('NOT_CONNECTED', error.message));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await httpJson('GET', '/health');
      return;
    } catch {}
    await sleep(250);
  }
  throw errorPayload('NOT_CONNECTED', 'Bridge server failed to start.');
}

async function ensureServerRunning() {
  try {
    await httpJson('GET', '/health');
    return;
  } catch {}

  const out = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [process.argv[1], 'server'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  await waitForServer();
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function waitForExtensionConnected(timeoutMs = EXTENSION_BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const payload = await httpJson('GET', '/health');
      if (payload.extensionConnected) return payload;
    } catch {}
    await sleep(300);
  }
  return null;
}

async function bootstrapExtensionIfPossible() {
  const state = readPersistedExtensionState();
  const extensionId = state.extensionId;
  if (!extensionId) return false;

  const chromePath = findChromeExecutable();
  if (!chromePath) return false;

  spawn(chromePath, [`chrome-extension://${extensionId}/offscreen.html`], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  const payload = await waitForExtensionConnected();
  return Boolean(payload?.extensionConnected);
}

function parseCommand(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }

  if (command === 'server' || command === 'health' || command === 'list') {
    return { command, payload: {} };
  }

  if (command === 'stop') {
    if (args[0]) return { command, payload: { tabId: normalizeTabId(args[0]) } };
    return { command, payload: {} };
  }

  if (!args[0]) {
    throw new Error(`Tab id required for "${command}"`);
  }

  const tabId = normalizeTabId(args[0]);
  const rest = args.slice(1);

  switch (command) {
    case 'attach':
    case 'close':
    case 'snap':
      return { command, payload: { tabId } };
    case 'eval':
      if (!rest.length) throw new Error('Expression required');
      return { command, payload: { tabId, expression: rest.join(' ') } };
    case 'html':
      return { command, payload: { tabId, selector: rest[0] || null } };
    case 'click':
      if (!rest.length) throw new Error('CSS selector required');
      return { command, payload: { tabId, selector: rest[0] } };
    case 'type':
      if (!rest.length) throw new Error('Text required');
      return { command, payload: { tabId, text: rest.join(' ') } };
    case 'nav':
      if (!rest.length) throw new Error('URL required');
      return { command, payload: { tabId, url: rest[0] } };
    case 'shot':
      return { command, payload: { tabId, file: rest[0] || null } };
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHealth(payload) {
  const lines = [
    `Bridge: http://${payload.host}:${payload.port}`,
    `Extension connected: ${payload.extensionConnected ? 'yes' : 'no'}`,
  ];
  if (payload.extension.extensionId) lines.push(`Extension ID: ${payload.extension.extensionId}`);
  if (payload.extension.version) lines.push(`Extension version: ${payload.extension.version}`);
  if (payload.extension.lastSeenAt) lines.push(`Last seen: ${new Date(payload.extension.lastSeenAt).toISOString()}`);
  return lines.join('\n');
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));

  if (parsed.command === 'help') {
    console.log(USAGE);
    return;
  }

  if (parsed.command === 'server') {
    await runServer();
    return;
  }

  if (parsed.command === 'health') {
    await ensureServerRunning();
    const payload = await httpJson('GET', '/health');
    console.log(printHealth(payload));
    return;
  }

  if (parsed.command === 'stop' && !parsed.payload.tabId) {
    try {
      await httpJson('POST', '/v1/commands/execute', parsed);
    } catch (error) {
      if (error.code === 'NOT_CONNECTED') return;
      throw error;
    }
    return;
  }

  await ensureServerRunning();
  const health = await httpJson('GET', '/health');
  if (!health.extensionConnected) {
    await bootstrapExtensionIfPossible();
  }
  const response = await httpJson('POST', '/v1/commands/execute', parsed);
  if (response.result) console.log(response.result);
}

main().catch((error) => {
  console.error(error.message || JSON.stringify(error));
  process.exit(1);
});
