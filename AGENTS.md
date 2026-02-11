# agent-crx - Chrome Extension CDP Inspector for AI Agents

A CLI that connects to a running Chrome instance via CDP and gives AI agents full visibility into Chrome extensions: console logs, network requests, errors, DOM snapshots with interactive element refs, screenshots, and interaction commands.

## Architecture

TypeScript, Node.js 22+, compiled with `tsc`. Uses `chrome-remote-interface` for CDP and `commander` for CLI.

Key files:
- `src/index.ts` -- CLI entry point, all command definitions
- `src/daemon.ts` -- Background daemon with HTTP API, ring buffer event collection, CDP connection management
- `src/connection.ts` -- CDP connection and tab discovery
- `src/config.ts` -- Config file loading (`agent-crx.json`)
- `src/snapshot.ts` -- DOM snapshot with interactive element refs (@1, @2, etc.)
- `src/inspect.ts` -- Full diagnostic: page state + errors + screenshot + DOM snapshot
- `src/click.ts` -- Click/fill by @ref or CSS selector
- `src/interact.ts` -- Navigate, reload, eval, extension management
- `src/verify.ts` -- Binary pass/fail assertions
- `src/check.ts` -- Navigate + wait + verify in one command
- `src/wait.ts` -- Block until condition met
- `src/record.ts` -- Screencast GIF recording (requires ffmpeg)
- `src/screenshot.ts` -- PNG screenshot capture
- `src/events.ts` -- Event types and timestamps
- `src/client.ts` -- HTTP client for daemon API
- `src/log.ts` -- File logging
- `src/assertions.ts` -- Assertion helpers for verify/check

Two modes:
1. **Daemon mode** (recommended): `agent-crx daemon start` runs a persistent background process that maintains the CDP connection and buffers events. All other commands query the daemon via HTTP.
2. **Direct mode**: Commands connect directly to Chrome CDP when daemon isn't running. Limited to one-shot operations.

## Commands

```bash
# Daemon
agent-crx daemon start|stop|status

# Visibility
agent-crx inspect            # screenshot + errors + DOM snapshot (recommended)
agent-crx snapshot           # DOM snapshot with @refs
agent-crx screenshot         # PNG screenshot
agent-crx console [pattern]  # query console output
agent-crx network            # query network events
agent-crx errors             # show errors/exceptions/failed requests

# Interaction
agent-crx click <target>     # click by @ref or CSS selector
agent-crx fill <target> <v>  # fill input by @ref or CSS selector
agent-crx navigate <url>     # navigate active tab
agent-crx reload-page        # reload active tab
agent-crx eval <expr>        # evaluate JS in page context

# Extension management
agent-crx extensions [-v]    # list installed extensions
agent-crx ext-errors <id>    # show extension errors
agent-crx reload <id>        # reload extension

# Assertions
agent-crx verify             # pass/fail health check with assertions
agent-crx check <url>        # navigate + wait + verify
agent-crx wait               # block until condition met
agent-crx health             # simple pass/fail

# Recording
agent-crx record             # screencast GIF (requires ffmpeg)
```

## Testing

```bash
pnpm build    # compile TypeScript
pnpm start    # run compiled CLI
pnpm dev      # run via tsx (no compile)
```

## Releasing

Tag and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

This automatically:
1. Runs CI
2. Creates a GitHub Release with auto-generated notes
3. Publishes to npm
4. Updates the Homebrew formula in `flimble/homebrew-tap`

Do NOT manually edit the version in `package.json` -- the release workflow handles it.

## Development Rules

- All commands should work in both daemon and direct CDP mode where possible
- Commands that need buffered events (console, network, errors, snapshot, inspect, click, fill) require the daemon
- Every command supports `--json` for machine-readable output
- Use @ref numbers from snapshot/inspect for click/fill targets
- Config file is `agent-crx.json` in the project root
- State directory is `~/.agent-crx/`
