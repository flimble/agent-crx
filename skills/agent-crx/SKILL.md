---
name: agent-crx
description: Chrome extension CDP inspector for AI agents. Streams console logs, network requests, DOM snapshots with @refs, screenshots, and interaction commands.
---

# agent-crx

Gives AI agents full visibility into Chrome extensions via CDP. Screenshots, DOM snapshots with interactive @refs, console/network streaming, click/fill automation, and extension management.

## Prerequisites

Chrome must be running with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

## Commands

```bash
# Start the daemon (maintains CDP connection, buffers events)
agent-crx daemon start

# See everything at once (recommended first command)
agent-crx inspect              # screenshot + errors + DOM snapshot with @refs

# DOM and interaction
agent-crx snapshot             # interactive element refs (@1, @2, etc.)
agent-crx click @3             # click element by ref
agent-crx fill @5 "hello"     # fill input by ref
agent-crx click "#login-btn"  # click by CSS selector
agent-crx navigate <url>      # go to URL
agent-crx reload-page         # reload tab
agent-crx eval <expression>   # run JS in page

# Debugging
agent-crx console [pattern]   # query console output
agent-crx network             # network requests
agent-crx network --failed    # only failed requests
agent-crx errors              # errors + exceptions + failed requests
agent-crx screenshot          # PNG screenshot

# Extension management
agent-crx extensions -v       # list extensions with details
agent-crx reload <ext-id>     # reload extension (shows error diff)
agent-crx ext-errors <ext-id> # extension errors

# Assertions
agent-crx verify              # pass/fail with configurable assertions
agent-crx check <url>         # navigate + wait + verify in one call
agent-crx wait --selector <s> # block until element exists
agent-crx health              # quick pass/fail

# Recording
agent-crx record              # screencast GIF (requires ffmpeg)
```

All commands support `--json` for machine-readable output.

## Config (agent-crx.json)

```json
{
  "name": "my-extension",
  "port": 9222,
  "tabFilter": "example.com",
  "console": {
    "filters": [{ "label": "app", "pattern": "[MyExt]" }],
    "showUnmatched": false
  },
  "network": {
    "filters": [{ "label": "api", "urlPattern": "api.example.com" }],
    "showUnmatched": false
  }
}
```

## Workflow

1. `agent-crx daemon start` -- start persistent CDP connection
2. `agent-crx inspect` -- see page state, errors, screenshot, interactive elements
3. Use @refs from inspect to interact: `agent-crx click @3`, `agent-crx fill @5 "text"`
4. `agent-crx reload <ext-id>` -- reload extension after code changes, check error diff
5. `agent-crx inspect` -- verify state after changes
6. `agent-crx verify` -- automated pass/fail assertions

## Tips

- `inspect` is the single best command -- it returns everything an agent needs in one call
- Use `--inspect` flag on `reload`, `reload-page`, and `navigate` to get inspect output inline
- Use `agent-crx errors --count` for quick error summary
- Use `agent-crx console --last 5` to see recent console output
- The daemon buffers events, so you can query past console/network activity
