---
name: chrome-debugger-bridge
description: Control the user's existing logged-in Chrome session through an installed MV3 extension and a localhost bridge, avoiding Chrome remote-debugging Allow popups during runtime. Use when Codex should automate real Chrome tabs from the terminal with commands like list, attach, eval, click, type, nav, html, snap, and shot after the user has completed the one-time extension install and permission grant.
---

# Chrome Debugger Bridge

## Overview

This skill lets Codex drive your existing real Chrome tabs through a local extension bridge instead of Chrome's remote-debugging approval dialog. It is the right choice when you want terminal-driven browser automation on your current logged-in Chrome profile and you are willing to do a one-time unpacked-extension install.

## Quick Start

1. Load the unpacked extension from `assets/extension/` in Chrome.
2. Accept the extension permission warning once.
3. Start the localhost bridge with `scripts/bridge.mjs server`, or just run any command and let it auto-start.
4. Use the commands below against real Chrome tab IDs from `list`.

On macOS, choose `<skill-dir>/assets/extension` when loading the unpacked extension. If setup or permissions are unclear, read [references/install-and-boundaries.md](references/install-and-boundaries.md).

## Commands

All commands go through `scripts/bridge.mjs`.

```bash
scripts/bridge.mjs list
scripts/bridge.mjs attach <tab>
scripts/bridge.mjs close <tab>
scripts/bridge.mjs snap <tab>
scripts/bridge.mjs eval <tab> <expr>
scripts/bridge.mjs html <tab> [selector]
scripts/bridge.mjs click <tab> <selector>
scripts/bridge.mjs type <tab> <text>
scripts/bridge.mjs nav <tab> <url>
scripts/bridge.mjs shot <tab> [file]
scripts/bridge.mjs stop [tab]
scripts/bridge.mjs health
scripts/bridge.mjs doctor
```

## Workflow

1. Run `list` to find a tab ID in your existing Chrome session.
2. Run `attach` once for a tab if you want an explicit warm-up step. Other page commands also auto-attach if needed.
3. Use `close`, `eval`, `html`, `snap`, `click`, `type`, `nav`, and `shot` for automation work.
4. Run `stop <tab>` to detach one tab, or `stop` to stop the local bridge and request a detach-all when the extension is reachable.

## Behavior Notes

- This skill targets your real logged-in Chrome session, not a fresh tool-managed browser.
- The "zero Allow" promise means no runtime Chrome `Allow debugging?` prompt from remote debugging. It does not remove the one-time extension permission warning.
- `close` removes a real Chrome tab through the extension's existing `tabs` permission, so it does not add any extra runtime approval step.
- `type` writes into the currently focused element. Focus the field first with `click` or `eval`.
- `html` and `click` use CSS selectors inside the page context. Prefer stable selectors over index-based DOM lookups.
- `shot` saves PNG output locally and prints the device pixel ratio for coordinate conversions.
- `chrome://`, `chrome-extension://`, and `devtools://` pages are intentionally skipped from `list`.
- On macOS, the CLI looks for Chrome at `CHROME_PATH`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, and `~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- On macOS, logs, saved extension state, and default screenshots are stored in `$XDG_RUNTIME_DIR/chrome-debugger-bridge` when `XDG_RUNTIME_DIR` is set, otherwise `~/.cache/chrome-debugger-bridge`.

## Resources

- `scripts/bridge.mjs`: CLI plus localhost bridge server.
- `assets/extension/`: MV3 unpacked extension that owns `chrome.debugger` access.
- `references/install-and-boundaries.md`: install, trust boundary, and troubleshooting notes.

## Harness Integration

When this skill is passed into the local long-running harness, prefer adding it through `--skill-context-file` as an `evaluator` or `shared` local skill so the evaluator can mount this skill directory and reuse the exact bridge workflow:

```json
{
  "activeSkills": [
    {
      "name": "chrome-debugger-bridge",
      "summary": "Use the real Chrome bridge for skeptical end-to-end QA.",
      "path": "<skill-dir>/SKILL.md",
      "roles": ["evaluator"],
      "required": true,
      "whenToUse": "always"
    }
  ]
}
```
