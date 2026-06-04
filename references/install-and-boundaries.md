# Install And Boundaries

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click `Load unpacked`.
4. Select `C:\Users\Lenovo\.codex\skills\chrome-debugger-bridge\assets\extension`.
5. Accept the extension permission warning.
6. Keep the extension enabled.
7. Start the bridge with:

```bash
node C:\Users\Lenovo\.codex\skills\chrome-debugger-bridge\scripts\bridge.mjs server
```

You can also skip step 7 and run any normal command first. The CLI auto-starts the bridge if it is not already running.

## What Zero-Allow Means

- No Chrome `Allow debugging?` popup during runtime automation.
- One-time extension installation and permission approval is still required.
- This skill does not bypass Chrome extension warnings or local-machine trust boundaries.

## Trust Boundary

- The bridge listens on `127.0.0.1` only.
- The extension talks only to the local bridge URL.
- The extension requests broad permissions because `chrome.debugger` and real-tab control require them.
- Any local process that can reach the bridge port can ask it to queue commands, so treat the machine as the trust boundary for v1.

## Troubleshooting

- If `list` says `EXTENSION_UNAVAILABLE`, confirm the unpacked extension is still enabled and Chrome has not disabled it after reload.
- If the extension popup shows the bridge as disconnected, restart the local bridge and click refresh in the popup.
- If a tab action fails after closing or reloading a tab, run `list` again and use the current tab ID.
- If `type` appears to do nothing, focus the input first with `click`.
- If `shot` succeeds but coordinates look off, divide screenshot pixels by the reported DPR before using them for click coordinates.

## Current Limits

- Windows and Chrome only for v1.
- No cross-browser support.
- No visual recognition or record/replay layer.
- No automation for `chrome://` or extension pages.
