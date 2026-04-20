# Changelog

All notable changes to this project will be documented in this file.

## 2026-04-20

### Added

- Added `/raid-set` command to update raid progress per character.
- Added optional gate target in `/raid-set` (`G1`, `G2`, `G3`).
- Added Railway deployment files: `Dockerfile`, `railway.toml`, `.dockerignore`.

### Changed

- Refactored raid model to grouped structure (`armoche`, `kazeros`, `serca`) with mode metadata.
- Updated slash command names and options to consistent naming.
- Migrated character data shape to use:
  - `id`, `name`, `class`, `itemLevel`, `combatScore`
  - `assignedRaids` gate-based progress
  - `tasks` at character and user levels
- Updated `/raid-status` rendering:
  - `✅` when all gates are completed
  - partial gate progress (`G1`, `G1/G2`) when not fully done
  - `❓` when no completed gate
- Updated `/raid-check` to evaluate completion by raid difficulty and gate completion.
- Updated weekly reset to clear gate `completedDate` and task completion counters.

### Fixed

- Fixed option-name mismatches between slash command definitions and handlers.
- Fixed command routing and interaction handling for renamed commands.
- Fixed parsing and sorting behavior for combat score values containing symbols.
- Fixed `/raid-check` item-level filter: characters with missing or non-numeric `itemLevel` were slipping past the minimum requirement because `Number(undefined) < n` evaluates to `false`. Now coerced via `Number() || 0` before comparison.
- Clarified the `1740+` Serca branch in `/raid-status` with a comment explaining that it surfaces both Hard and Nightmare as dual options (Hard alone remains eligible from `1730` via the generic branch).

### Deployment

- Registered updated slash commands with Discord successfully after schema changes.
