# @marshal/excalidraw

Marshal Runtime extension that wraps the official [Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp) (hosted at `https://mcp.excalidraw.com/mcp`, no credentials) so agents can draw hand-drawn diagrams that render as an Excalidraw card in the chat.

## Capabilities

| Capability | MCP tool | What it does |
| --- | --- | --- |
| `excalidraw.guide` | `read_me` | Element format, palette, camera and checkpoint rules. Read once per conversation. |
| `excalidraw.draw` | `create_view` | Draws the diagram and shows the card (`placement`, `slot`, `afterMessageId`, or `instanceId` to redraw a card in place). Returns `checkpointId`. |
| `excalidraw.checkpoint.read` | `read_checkpoint` | Stored elements, including edits the user made in the card. |
| `excalidraw.export` | `export_to_excalidraw` | Encrypted upload to excalidraw.com; returns a shareable link. Asks for approval (medium risk). |
| `excalidraw.save` | — | Writes a `.excalidraw` file. Asks for approval (medium risk). |
| `excalidraw.mcp.list_tools` / `excalidraw.mcp.call` | any | Raw passthrough for MCP tools the named capabilities do not cover. `call` asks for approval. |
| `excalidraw.view.sync` | `save_checkpoint` | Card-only: records the rendered scene and saves the user's edits to the checkpoint. |

Editing an existing diagram: `excalidraw.draw` with elements starting `{"type":"restoreCheckpoint","id":"<checkpointId>"}`; remove elements with `{"type":"delete","ids":"a,b"}`. The server resolves both.

## The card

Marshal's packaged UI sandbox has no network (`connect-src 'none'`, inline scripts only), so the hosted MCP App HTML (which imports Excalidraw from esm.sh) cannot run there. The card is our own MCP-Apps document with Excalidraw 0.18, React 19 and the Excalifont/Assistant/Virgil fonts bundled inline (~1.9 MB). The card iframe also inherits Marshal's window CSP (`font-src 'self'`), which blocks `data:` font URLs, so `src/browser/shims.ts` registers the bundled fonts as `FontFace` byte sources (not fetched, so not CSP-checked) and the build strips Excalidraw's CSS `@font-face` rules for Assistant. Text is re-measured once Excalifont has loaded. It mirrors the official app's element conversion (labels centered, text in Excalifont, final `cameraUpdate` as the viewport, `delete` applied).

- Inline: view mode, fitted to the camera. **Edit** switches to fullscreen with the full editor; edits are saved to the checkpoint after a short pause, so the agent's next `restoreCheckpoint` includes them.
- **Open in Excalidraw** exports and opens the excalidraw.com link.
- Declares `marshal.ui.viewports: ["mobile", "desktop"]`.

Not included in the card: the Mermaid import dialog, non-English UI locales, and image/SVG export from the menu (stubbed at build time to keep the bundle small), and the hosted app's streaming draw-on animation.

## Configuration

`endpoint` (optional, https): a self-hosted Excalidraw MCP server. Defaults to `https://mcp.excalidraw.com/mcp`.

## Develop

```bash
npm install
npm run build      # view bundle → src/generated/viewAssets.ts, then dist/runtime.cjs
npm test
npm run typecheck
```

Install into Marshal with `runtimeInstallLocalExtension` using packageRoot `<this folder>/.stage` (the build stages only `dist`, the manifest and docs there, since the host copies the whole package root); after a rebuild use `runtimeUpdateExtension` with the same path.

## License

MIT. Bundled third-party code is listed in `THIRD_PARTY_NOTICES.md`.
