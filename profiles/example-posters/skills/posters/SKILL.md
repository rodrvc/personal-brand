---
name: posters
description: How to render the sample poster of this fictional brand with its own tool.
---
# Posters

Render with the brand's tool from a workspace (`brand workspace example-posters --out <folder>`):

```bash
node <folder>/scripts/render-sample.mjs <output-folder>
```

- Always pass an output folder **outside** the brand folder and outside the repo.
- The tool needs no setup beyond the workspace: it imports `playwright` by name, and the workspace links the engine's libraries.
- `--check` only confirms the library loads (prints `ok`); it opens no browser.
