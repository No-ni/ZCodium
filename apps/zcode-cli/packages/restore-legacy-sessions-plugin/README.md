# Restore Legacy Sessions Plugin

Bundled historical plugin for restoring old ACP-era ZCode session snapshots into the task index and CLI session DB.

This plugin is bundled as `restore-legacy-sessions@zcode-plugins-official` and is disabled by default. Its snapshot scanning and restoration implementation is currently unavailable. Enabling the plugin does not restore this capability.

Both scripts support `--help`. Scan, restore and `--dry-run` return exit code 2 with `LEGACY_SCAN_UNAVAILABLE` or `LEGACY_RESTORE_UNAVAILABLE` before any file or database access. They do not create backups or mutate data. A future implementation must first be reviewed against the current store owners and migration contracts.

## Enable

```sh
zcode plugins enable restore-legacy-sessions
```

Or inside a ZCode session:

```text
/plugins enable restore-legacy-sessions
```

Changes apply to new sessions. After enabling, use:

```text
/restore-legacy-sessions
```

## Historical Data Boundaries

- Sources must be explicitly selected if restoration is implemented; no legacy directory migration is performed by this fork.
- Task index destination: `~/.zcodium/v2/tasks-index.sqlite`
- CLI session DB destination: `~/.zcodium/cli/db/db.sqlite`

Historical restoration rules require backups before writes and normal `glm` ZCode Agent history without `migration_source`. The current unavailable commands do not execute these operations.

## Development

This is a skill-only / command-only plugin. It has no MCP server and no build step.
