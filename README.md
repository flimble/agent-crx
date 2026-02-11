<p align="center">
  <img src="assets/logo.svg" alt="agent-crx" width="480" />
</p>

<p align="center">
  <strong>Chrome extension inspector for AI agents.</strong><br>
  Like <a href="https://github.com/vercel-labs/agent-browser">agent-browser</a>, but for Chrome extensions.<br>
  Console logs, network requests, DOM snapshots with @refs, screenshots, and interaction commands.
</p>

<p align="center">
  <a href="https://github.com/flimble/agent-crx/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/flimble/agent-crx/ci.yml?style=for-the-badge&label=CI" alt="CI"></a>
  <a href="#"><img src="https://img.shields.io/badge/node-22+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 22+"></a>
  <a href="#"><img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License"></a>
</p>

---

## Why

[agent-browser](https://github.com/vercel-labs/agent-browser) gave AI agents eyes into the browser. agent-crx does the same for Chrome extensions -- your agent can see console output, network requests, DOM state with interactive element refs, take screenshots, click elements, fill inputs, and manage extension lifecycle, all from a single CLI.

Without it, agents debugging Chrome extensions are flying blind: they can't see what the extension logs, don't know what network requests it makes, can't tell if errors were introduced after a reload, and have no way to interact with the page programmatically.

```
agent-crx daemon start       # connect to Chrome via CDP
agent-crx inspect            # screenshot + errors + DOM snapshot in one call
agent-crx reload <ext-id>    # reload extension, see error diff
```

TypeScript. Two dependencies (`chrome-remote-interface`, `commander`). Daemon architecture for persistent event buffering.

## Installation

### Homebrew (macOS)

```bash
brew install flimble/tap/agent-crx
```

### npm

```bash
npx agent-crx --help

# Or install globally
npm install -g agent-crx
```

### From source

```bash
git clone https://github.com/flimble/agent-crx.git
cd agent-crx
pnpm install && pnpm build
./install.sh
```

### Verify

```bash
agent-crx --help
agent-crx health    # checks Chrome connection
```

## Prerequisites

Chrome must be running with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

## Quick Start

```bash
# 1. Start the daemon (persistent CDP connection + event buffering)
agent-crx daemon start

# 2. See everything at once
agent-crx inspect              # screenshot + errors + DOM snapshot with @refs

# 3. Interact using @refs from inspect
agent-crx click @3             # click a button
agent-crx fill @5 "hello"     # fill an input

# 4. Reload your extension and check for new errors
agent-crx reload <extension-id>

# 5. Verify page health
agent-crx health
```

## Commands

### Daemon

| Command | Description |
|---------|-------------|
| `agent-crx daemon start` | Start background daemon (maintains CDP connection, buffers events) |
| `agent-crx daemon stop` | Stop the daemon |
| `agent-crx daemon status` | Check daemon status |

### Visibility

| Command | Description |
|---------|-------------|
| `agent-crx inspect` | Screenshot + errors + DOM snapshot with @refs (recommended) |
| `agent-crx snapshot` | DOM snapshot with interactive element @refs |
| `agent-crx screenshot` | Capture PNG screenshot |
| `agent-crx console [pattern]` | Query buffered console output |
| `agent-crx network` | Query buffered network events |
| `agent-crx errors` | Show errors, exceptions, and failed requests |
| `agent-crx status` | Connection status and event counts |

### Interaction

| Command | Description |
|---------|-------------|
| `agent-crx click <target>` | Click by `@ref` number or CSS selector |
| `agent-crx fill <target> <value>` | Fill input by `@ref` or CSS selector |
| `agent-crx navigate <url>` | Navigate active tab to URL |
| `agent-crx reload-page` | Reload the active tab |
| `agent-crx eval <expression>` | Evaluate JavaScript in page context |
| `agent-crx tabs` | List open browser tabs |

### Extension Management

| Command | Description |
|---------|-------------|
| `agent-crx extensions` | List installed extensions |
| `agent-crx extensions -v` | Detailed info (version, permissions, errors) |
| `agent-crx reload <ext-id>` | Reload extension (shows version + error diff) |
| `agent-crx ext-errors <ext-id>` | Show manifest + runtime errors |

### Assertions

| Command | Description |
|---------|-------------|
| `agent-crx health` | Simple pass/fail connection check |
| `agent-crx verify` | Configurable pass/fail assertions |
| `agent-crx check <url>` | Navigate + wait + verify in one command |
| `agent-crx wait` | Block until condition met (selector, title, console, network) |

### Recording

| Command | Description |
|---------|-------------|
| `agent-crx record` | Capture screencast GIF (requires `ffmpeg`) |

All commands support `--json` for machine-readable output.

## Element Refs

agent-crx assigns `@ref` handles to every interactive element on the page:

```
@1  button "Sign In" [clickable]
@2  input[email] "Email" [clickable]
@3  input[password] "Password" [clickable]
@4  a "Forgot password?" href="/reset"
@5  checkbox "Remember me" [clickable]
```

Use these refs with `click` and `fill` commands. Refs reset on each `snapshot` or `inspect` call.

## Agent Workflow

The typical AI agent loop for developing Chrome extensions:

```
1. agent-crx daemon start           # connect to Chrome
2. agent-crx inspect                # see current state
3. Edit extension code              # make changes
4. agent-crx reload <ext-id>       # reload, check error diff
5. agent-crx inspect                # verify changes
6. If errors: agent-crx errors     # investigate
7. Repeat from 3
```

The `inspect` command returns everything an agent needs in one call: page URL, title, extension status, error counts, recent errors, screenshot path, DOM watchlist status, and interactive elements with @refs.

## Configuration

Create `agent-crx.json` in your project root:

```json
{
  "name": "my-extension",
  "port": 9222,
  "tabFilter": "example.com",
  "console": {
    "filters": [
      { "label": "app", "pattern": "[MyExt]" }
    ],
    "showUnmatched": false
  },
  "network": {
    "filters": [
      { "label": "api", "urlPattern": "api.example.com" }
    ],
    "showUnmatched": false
  }
}
```

- `filters` match substrings in console text or request URLs
- `label` controls the tag shown in output
- `showUnmatched: false` hides events that don't match any filter (reduces noise)
- `tabFilter` auto-selects the right browser tab

### Common Options

```
-p, --port <number>       Chrome debugging port (default: 9222)
-t, --tab <filter>        Filter tabs by URL substring
--daemon-port <number>    Daemon HTTP port (default: 9300)
--json                    Machine-readable JSON output
```

## How It Works

agent-crx runs a background daemon that maintains a persistent CDP (Chrome DevTools Protocol) connection to Chrome. The daemon:

1. Connects to a specific browser tab (auto-selected via `tabFilter` or manually)
2. Subscribes to Console, Network, and Runtime CDP domains
3. Buffers all events in a ring buffer (queryable via CLI commands)
4. Exposes an HTTP API that CLI commands query

This means you get historical context -- not just what's happening now, but what happened since the daemon started. Console logs, network requests, and errors are all buffered and queryable with filters, time ranges, and limits.

For one-shot operations (tabs, extensions, screenshot without daemon), agent-crx falls back to direct CDP connections.

## Usage with AI Agents

### Just ask

```
Use agent-crx to debug my Chrome extension. Run agent-crx --help to see available commands.
Start with agent-crx daemon start, then use agent-crx inspect to see the current state.
```

### AI Coding Assistants

agent-crx ships with an agent skill in `skills/agent-crx/`. Copy it into your skills directory:

```bash
cp -r skills/agent-crx ~/.factory/skills/agent-crx
```

### AGENTS.md

Add to your project or global instructions:

```
## Chrome Extension Development
Use `agent-crx` for Chrome extension debugging. Run `agent-crx --help` for all commands.

Workflow: agent-crx daemon start -> agent-crx inspect -> edit code -> agent-crx reload <id> -> agent-crx inspect
Use @refs from inspect/snapshot for click and fill commands.
```

## Development

```bash
git clone https://github.com/flimble/agent-crx.git
cd agent-crx
pnpm install
pnpm build    # compile TypeScript
pnpm dev      # run via tsx (no compile step)
```

## Acknowledgments

Inspired by [agent-browser](https://github.com/vercel-labs/agent-browser) and [tether](https://github.com/flimble/tether) -- the same philosophy (structured output, element refs, agent-friendly CLI) applied to Chrome extension development.

## License

MIT -- see [LICENSE](LICENSE).
