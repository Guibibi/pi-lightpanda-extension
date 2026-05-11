# Pi Lightpanda Extension

Pi package that adds Lightpanda-powered web tooling to [pi](https://pi.dev), plus optional Playwright-backed visual screenshots.

## Install

```bash
pi install npm:pi-lightpanda-extension
# or try without installing
pi -e npm:pi-lightpanda-extension
```

For local development from this directory:

```bash
npm install
npm run check
pi --no-extensions -e . --list-models
```

## Requirements

- `lightpanda` must be on `PATH`, or set `LIGHTPANDA_BIN=/path/to/lightpanda`.
- `playwright_screenshot` requires Playwright Chromium. If it is not installed automatically in your environment, run `npx playwright install chromium`.
- Managed Lightpanda processes run with `LIGHTPANDA_DISABLE_TELEMETRY=true` unless you set that environment variable yourself.

## Tools

- `lightpanda_search` — web search via a public search result page fetched with Lightpanda.
- `lightpanda_fetch` — fetch a URL and dump `markdown`, `html`, `semantic_tree`, or `semantic_tree_text`.
- `lightpanda_cdp_server` — start/status/stop/restart Lightpanda `serve` CDP server.
- `lightpanda_cdp_navigate` — navigate a stateful CDP page and summarize page state.
- `lightpanda_cdp_eval` — evaluate JavaScript in the current Lightpanda CDP page.
- `lightpanda_cdp_command` — send a raw CDP command with JSON params.
- `lightpanda_cdp_events` — inspect recent CDP events and Lightpanda logs.
- `playwright_screenshot` — capture a real visual PNG screenshot with Playwright Chromium.
- `lightpanda_cdp_screenshot` — calls Lightpanda `Page.captureScreenshot` and saves the placeholder PNG.

## Command

- `/lightpanda status|start|stop|restart`

## Notes

- Lightpanda currently has no graphical rendering engine. Its CDP `Page.captureScreenshot` returns a placeholder image, not a real visual page screenshot.
- Use `playwright_screenshot` for real rendered screenshots.
- Run `/reload` in Pi after editing this extension locally.
