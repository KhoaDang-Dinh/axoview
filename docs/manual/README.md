# Axoview user manual

Task-oriented help for people using the hosted Axoview editor. These pages are
also the AI assistant's reference material: `npm run ai:manual` (backend) splits
every page below into sections and writes
`packages/axoview-backend/src/ai/corpus/manual.json`, which the assistant
searches before it answers. A backend test fails when that file is out of date.

| Page | Covers |
|---|---|
| [getting-started.md](getting-started.md) | Signing in, the Diagrams panel, creating and saving diagrams, pages |
| [canvas.md](canvas.md) | Zoom, pan, rotate, 2D and isometric, selecting, undo |
| [nodes.md](nodes.md) | Adding items, icons and icon packs, names and labels, details, links |
| [connectors.md](connectors.md) | Connecting items, rerouting, waypoints, connector names, labels and styles |
| [shapes-and-text.md](shapes-and-text.md) | Rectangles, text boxes, floating labels, formatting |
| [organising.md](organising.md) | Layers, stacking order, copy and paste, grid and collision |
| [sharing-and-export.md](sharing-and-export.md) | Share links, present mode, annotations, export and import |
| [settings-and-shortcuts.md](settings-and-shortcuts.md) | Settings and every keyboard and mouse shortcut |
| [ai-assistant.md](ai-assistant.md) | What the assistant can and cannot do, suggestions, limits, privacy |

## Writing rules

- One task per `##` section; the section is what the assistant retrieves, so it
  must make sense on its own (name the tool or panel, do not say "as above").
- Describe only what the product does today. Name buttons and menus exactly as
  the UI labels them (`packages/axoview-lib/src/i18n/en-US.ts`,
  `packages/axoview-app/src/i18n/en-US.json`).
- Front matter: `title` and `audience` (`public` for everything here).
- Under a heading, `<!-- keywords: a, b -->` lists words a user might type for
  that task that the section itself does not use. They help retrieval and are
  not shown to the model.
