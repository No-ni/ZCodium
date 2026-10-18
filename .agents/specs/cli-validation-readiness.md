# CLI Validation Readiness

## Typecheck prerequisite

The CLI workspace exposes `@zcode/tui` declarations from `packages/tui/dist/index.d.ts`. A fresh checkout does not contain that generated output, while the CLI workspace-level typecheck directly invokes package `typecheck` scripts and does not apply the Turbo `typecheck -> ^build` dependency graph.

The `apps/zcode-cli` `typecheck` script must therefore build `@zcode/tui` through the CLI workspace before running its existing recursive typecheck command. The build is a prerequisite only: if it fails, typecheck must stop and surface that failure. Keep the package exports and source API unchanged.

## Acceptance

- Running `pnpm --dir apps/zcode-cli typecheck` with the TUI `dist` output absent builds `@zcode/tui` first and then completes the existing workspace package typechecks.
- The TUI build is selected from the CLI workspace, and the existing recursive filters for `packages/*` and `tools/*` remain in place.
- A TUI build failure prevents the recursive typecheck from running.

## Scope

This change only corrects the CLI validation command order. It does not alter CLI lint rules, root CI commands, formatter versions or scopes, or package exports.
