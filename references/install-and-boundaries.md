# Install And Boundaries

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click `Load unpacked`.
4. Select `<skill-dir>/assets/extension`.
5. Accept the extension permission warning.
6. Keep the extension enabled.
7. Verify the local bridge and extension connection with:

```bash
node <skill-dir>/scripts/bridge.mjs health
```

You can also run any normal command first. The CLI auto-starts the bridge if it is not already running.

On macOS, `<skill-dir>` is the local skill directory that contains this `SKILL.md`. For example, if the skill is installed at `~/.codex/skills/chrome-debugger-bridge`, load `~/.codex/skills/chrome-debugger-bridge/assets/extension`.

## Install Into Codex App Skills

Install the skill directory under the Codex home skills folder:

```bash
mkdir -p ~/.codex/skills
rsync -a --delete --exclude .git <repo-dir>/ ~/.codex/skills/chrome-debugger-bridge/
```

Codex App discovers local skills from `~/.codex/skills/<skill-name>/SKILL.md`. If your Codex CLI has a skill listing command, use it to verify the install. Otherwise, verify the discovery file directly:

```bash
test -f ~/.codex/skills/chrome-debugger-bridge/SKILL.md
grep -n '^name: chrome-debugger-bridge' ~/.codex/skills/chrome-debugger-bridge/SKILL.md
```

Restart Codex App after installing or updating the skill so the app reloads the local skill list.

## macOS Runtime

- The bridge uses the current Node executable to auto-start `scripts/bridge.mjs server` in the background.
- The bridge listens on `127.0.0.1:43827`.
- Logs, saved extension state, and default screenshots are stored in `$XDG_RUNTIME_DIR/chrome-debugger-bridge` when `XDG_RUNTIME_DIR` is set, otherwise `~/.cache/chrome-debugger-bridge`.
- Chrome is discovered from `CHROME_PATH`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, then `~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- If Chrome is installed somewhere else, set `CHROME_PATH` to the executable path before running the CLI.
- After the extension has connected once, the CLI saves its extension ID. If Chrome is closed and reopened, `health` and normal commands try to wake the extension by opening `chrome-extension://<extension-id>/offscreen.html` in the discovered Chrome executable.
- If the first `health` after installation still says `Extension connected: no`, copy the extension ID shown on `chrome://extensions` and run:

```bash
CHROME_DEBUGGER_BRIDGE_EXTENSION_ID=<extension-id> node <skill-dir>/scripts/bridge.mjs health
```

Once that succeeds, the bridge saves the extension ID for later automatic wake-ups.

For a fuller diagnostic snapshot, run:

```bash
node <skill-dir>/scripts/bridge.mjs doctor
```

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
- If `health` says `Extension connected: no`, open the extension popup or reload the unpacked extension in `chrome://extensions`, then run `node <skill-dir>/scripts/bridge.mjs health` again.
- If `doctor` says `Chrome path: not found`, install Google Chrome in `/Applications`, install it in `~/Applications`, or set `CHROME_PATH`.
- If the extension popup shows the bridge as disconnected, restart the local bridge and click refresh in the popup.
- If a tab action fails after closing or reloading a tab, run `list` again and use the current tab ID.
- If `type` appears to do nothing, focus the input first with `click`.
- If `shot` succeeds but coordinates look off, divide screenshot pixels by the reported DPR before using them for click coordinates.

## Current Limits

- Chrome only for v1.
- No cross-browser support.
- No visual recognition or record/replay layer.
- No automation for `chrome://` or extension pages.
