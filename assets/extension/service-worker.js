const BRIDGE_BASE_URL = 'http://127.0.0.1:43827';
const DEBUGGER_VERSION = '1.3';
const OFFSCREEN_PATH = 'offscreen.html';
const attachedTabs = new Set();

const CONTROLLABLE_PROTOCOLS = ['http:', 'https:', 'file:', 'about:'];

function tabKey(tabId) {
  return String(tabId);
}

function isControllableUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('devtools://')) return false;
  try {
    const parsed = new URL(url);
    return CONTROLLABLE_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return url === 'about:blank';
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: 'Keep a hidden extension client polling the localhost bridge for automation commands.',
  });
}

async function safeSendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function ensureTabExists(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw createError('TAB_NOT_FOUND', `Tab ${tabId} was not found.`);
  }
}

async function activateTab(tabId) {
  const tab = await ensureTabExists(tabId);
  try {
    if (Number.isInteger(tab.windowId)) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {}
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {}
  return tab;
}

async function ensureAttached(tabId) {
  await activateTab(tabId);
  const key = tabKey(tabId);
  if (attachedTabs.has(key)) return;

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('Another debugger is already attached')) {
      attachedTabs.add(key);
      return;
    }
    throw createError('ATTACH_FAILED', `Failed to attach tab ${tabId}: ${message}`);
  }

  attachedTabs.add(key);

  try {
    await safeSendCommand(tabId, 'Page.enable');
  } catch {}

  try {
    await safeSendCommand(tabId, 'Runtime.enable');
  } catch {}
}

async function detachTab(tabId) {
  const key = tabKey(tabId);
  if (!attachedTabs.has(key)) return false;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  attachedTabs.delete(key);
  return true;
}

async function detachAllTabs() {
  const targets = [...attachedTabs].map((value) => Number(value)).filter((value) => Number.isInteger(value));
  for (const tabId of targets) {
    await detachTab(tabId);
  }
  return targets.length;
}

function createError(code, message) {
  return { code, message };
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();

  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }

  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }

  return children;
}

function formatAxSnapshot(nodes, compact = true) {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenByParent = new Map();

  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();

  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evaluateInPage(tabId, expression) {
  await ensureAttached(tabId);
  const result = await safeSendCommand(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw createError('EXECUTION_FAILED', result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'Runtime evaluation failed.');
  }

  const value = result.result?.value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value ?? '');
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id && isControllableUrl(tab.url))
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      active: Boolean(tab.active),
      attached: attachedTabs.has(tabKey(tab.id)),
    }));
}

async function waitForNavigation(tabId, timeoutMs = 30000) {
  const tab = await ensureTabExists(tabId);
  if (tab.status === 'complete') return;

  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      rejectPromise(createError('TIMEOUT', `Timed out waiting for tab ${tabId} to finish loading.`));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolvePromise();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function executeCommand(command, payload = {}) {
  switch (command) {
    case 'list':
      return { tabs: await listTabs() };
    case 'attach':
      await ensureAttached(payload.tabId);
      return { text: `Attached tab ${payload.tabId}` };
    case 'close':
      await ensureTabExists(payload.tabId);
      await detachTab(payload.tabId);
      await chrome.tabs.remove(payload.tabId);
      return { text: `Closed tab ${payload.tabId}` };
    case 'snap': {
      await ensureAttached(payload.tabId);
      const response = await safeSendCommand(payload.tabId, 'Accessibility.getFullAXTree');
      return formatAxSnapshot(response.nodes || []);
    }
    case 'eval':
      return evaluateInPage(payload.tabId, payload.expression);
    case 'html': {
      const expression = payload.selector
        ? `document.querySelector(${JSON.stringify(payload.selector)})?.outerHTML || 'Element not found'`
        : 'document.documentElement.outerHTML';
      return evaluateInPage(payload.tabId, expression);
    }
    case 'click': {
      const pointMatch = String(payload.selector || '').match(/^@point:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (pointMatch) {
        await ensureAttached(payload.tabId);
        const x = Number(pointMatch[1]);
        const y = Number(pointMatch[2]);
        await safeSendCommand(payload.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await safeSendCommand(payload.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await safeSendCommand(payload.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return `Clicked point ${Math.round(x)},${Math.round(y)}`;
      }
      const expression = `
        (() => {
          const el = document.querySelector(${JSON.stringify(payload.selector)});
          if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(payload.selector)} };
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return {
            ok: true,
            tag: el.tagName,
            text: el.textContent.trim().substring(0, 80),
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        })()
      `;
      const raw = await evaluateInPage(payload.tabId, expression);
      const parsed = JSON.parse(raw);
      if (!parsed.ok) throw createError('EXECUTION_FAILED', parsed.error);
      await safeSendCommand(payload.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: parsed.x, y: parsed.y, button: 'none' });
      await safeSendCommand(payload.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: parsed.x, y: parsed.y, button: 'left', clickCount: 1 });
      await safeSendCommand(payload.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: parsed.x, y: parsed.y, button: 'left', clickCount: 1 });
      return `Clicked <${parsed.tag}> "${parsed.text}"`;
    }
    case 'type':
      await ensureAttached(payload.tabId);
      await safeSendCommand(payload.tabId, 'Input.insertText', { text: payload.text || '' });
      return `Typed ${(payload.text || '').length} characters`;
    case 'nav': {
      await ensureAttached(payload.tabId);
      await safeSendCommand(payload.tabId, 'Page.enable');
      const result = await safeSendCommand(payload.tabId, 'Page.navigate', { url: payload.url });
      if (result?.errorText) {
        throw createError('EXECUTION_FAILED', result.errorText);
      }
      await waitForNavigation(payload.tabId);
      return `Navigated to ${payload.url}`;
    }
    case 'shot': {
      await ensureAttached(payload.tabId);
      let dpr = 1;
      try {
        const rawDpr = await evaluateInPage(payload.tabId, 'window.devicePixelRatio');
        const parsed = parseFloat(rawDpr);
        if (parsed > 0) dpr = parsed;
      } catch {}
      const result = await safeSendCommand(payload.tabId, 'Page.captureScreenshot', { format: 'png' });
      return { data: result.data, dpr };
    }
    case 'stop':
      if (payload.tabId) {
        await detachTab(payload.tabId);
        return { text: `Detached tab ${payload.tabId}` };
      }
      await detachAllTabs();
      return { text: 'Detached all attached tabs.' };
    default:
      throw createError('EXECUTION_FAILED', `Unknown command: ${command}`);
  }
}

async function buildStatus() {
  const tabs = await listTabs();
  let offscreenReady = false;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    offscreenReady = contexts.length > 0;
  }

  return {
    bridgeBaseUrl: BRIDGE_BASE_URL,
    attachedCount: attachedTabs.size,
    offscreenReady,
    controllableTabs: tabs.length,
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch(() => {});
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(tabKey(source.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabKey(tabId));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge-command') {
    executeCommand(message.command, message.payload)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: createError(error.code || 'EXECUTION_FAILED', error.message || String(error)) }));
    return true;
  }

  if (message?.type === 'get-status') {
    buildStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: createError('EXECUTION_FAILED', error.message || String(error)) }));
    return true;
  }

  if (message?.type === 'ensure-offscreen') {
    ensureOffscreenDocument()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: createError('EXECUTION_FAILED', error.message || String(error)) }));
    return true;
  }

  return false;
});

ensureOffscreenDocument().catch(() => {});
