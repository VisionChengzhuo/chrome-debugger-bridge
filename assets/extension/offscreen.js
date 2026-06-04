const BRIDGE_BASE_URL = 'http://127.0.0.1:43827';
const POLL_BACKOFF_MS = 1500;
const instanceId = crypto.randomUUID();

async function postJson(path, body) {
  const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({
      ...body,
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      instanceId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json();
}

async function handleJob(job) {
  const response = await chrome.runtime.sendMessage({
    type: 'bridge-command',
    command: job.command,
    payload: job.payload,
  });

  if (!response?.ok) {
    return {
      ok: false,
      error: response?.error || { code: 'EXECUTION_FAILED', message: 'Unknown extension failure.' },
    };
  }

  return { ok: true, payload: response.payload };
}

async function pollOnce() {
  const { job } = await postJson('/v1/extension/poll', {});
  if (!job) return;

  const result = await handleJob(job);
  await postJson('/v1/extension/result', {
    jobId: job.jobId,
    ok: result.ok,
    payload: result.payload,
    error: result.error,
  });
}

async function pollLoop() {
  while (true) {
    try {
      await pollOnce();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, POLL_BACKOFF_MS));
    }
  }
}

pollLoop();
