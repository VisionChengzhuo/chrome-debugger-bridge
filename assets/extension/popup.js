async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error?.message || 'Unknown extension error');
  }
  return response;
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

async function refresh() {
  const { status } = await send({ type: 'get-status' });
  setText('bridge', status.bridgeBaseUrl);
  setText('extensionId', status.extensionId);
  setText('attachedCount', String(status.attachedCount));
  setText('controllableTabs', String(status.controllableTabs));
  setText('offscreenReady', status.offscreenReady ? 'ready' : 'not ready');
  setText('message', `Extension version ${status.version}`);
}

document.getElementById('refresh').addEventListener('click', () => {
  refresh().catch((error) => {
    setText('message', error.message);
  });
});

document.getElementById('wake').addEventListener('click', () => {
  send({ type: 'ensure-offscreen' })
    .then(() => refresh())
    .catch((error) => {
      setText('message', error.message);
    });
});

async function initialize() {
  try {
    await send({ type: 'ensure-offscreen' });
  } catch {}

  refresh().catch((error) => {
    setText('message', error.message);
  });
}

initialize();
