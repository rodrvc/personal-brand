## ADDED Requirements

### Requirement: Output in the brand's bucket, versioned
Export SHALL write to `<outputs.base_dir>/<sub>/<carousel-id>/v<N>/`, where `base_dir` comes from `resolveOutputBaseDir(profileDir)` and `<sub>` from `resolveOutputSubfolder(profileDir, "editor")`. Each export creates `v<N+1>`; the system MUST NOT overwrite or delete an existing version. The number is reserved with an atomic `mkdir`, and on `EEXIST` it retries with the next one.

#### Scenario: Two exports in a row
- **WHEN** the user exports, changes nothing, and exports again
- **THEN** `v1/` and `v2/` both exist with the same image content and manifests differing only by date

### Requirement: Files of a version
Each version SHALL contain `01.png … NN.png` (1080×1350, numbered in slide order) and a `manifest.json` with `carouselId`, `version`, `exportedAt`, `engine` (repo git sha, resolved template id and hash), `brand` (full `brand.json` snapshot), `document` (a copy of the document), `assets[]` (`id`, `path`, hash) and `fonts[]` (hashes). With that manifest the version MUST be reproducible without the live profile.

#### Scenario: Brand changed after export
- **WHEN** `brand.json`'s accent color changes after exporting `v1`
- **THEN** `v1/manifest.json` keeps the accent it was exported with, and the PNG doesn't change

### Requirement: Serial queue with a warm browser
Exports SHALL run one at a time on a single Chromium instance kept open while the server is alive. The UI MUST show per-slide progress, and the export button states the slide count ("Exportar 6 PNG").

#### Scenario: Export during another export
- **WHEN** a second carousel export is requested while the first is in progress
- **THEN** the second is queued and the UI indicates this; neither fails from browser contention

### Requirement: Status and library after export
On completing an export the document SHALL move to `status: exported` (if it was `draft`), the generated pieces it uses SHALL move to `approved` in the library, and the version SHALL appear in the "Bucket" panel's `outputs/` list with name, date, PNG count and folder access.

#### Scenario: Open the folder
- **WHEN** the user presses a version's download icon
- **THEN** locally the `v<N>/` folder opens in Finder; the path is also shown as copyable text

### Requirement: Confined export
The destination SHALL be validated by `ProfileStore`: only the resolved `outputs.base_dir` (which can sit outside the repo via `config.local.yaml`) or `profiles/<slug>/outputs/` by default. Any other path is rejected.

#### Scenario: base_dir outside the repo
- **WHEN** `config.local.yaml` points `outputs.base_dir` to a user folder outside the repo
- **THEN** the export writes there, and every other root remains forbidden
