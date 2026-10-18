# Desktop Main Contract Repair

## Scope

Repair the extra `packages/desktop/tsconfig.main.json` diagnostics in the assigned main-process files. Preserve the existing runtime behavior and platform scope; this change must not restore removed server-remote or Linux desktop functionality and must not edit the excluded `browserView`, `taskRealtimeBus.ts`, or main tsconfig files.

## Contracts and ownership

- Main remains the owner of Electron process wiring and translates validated IPC payloads to existing main callbacks.
- Cross-package types are imported from their existing public entrypoints. Platform IPC request types are derived from `PlatformChannelMap`; storage data belongs to `@zcode/shared`, and `IStorageService` belongs to the `@zcode/services` root entrypoint.
- The window lifecycle builds the host-init fields it owns. `index.ts` remains responsible for injecting the built-in provider config path immediately before spawning the Host.
- External updater YAML remains untrusted input. It must be validated before it is returned as `electron-updater`'s `UpdateInfo`, including the supported legacy `path`/`sha512` form where applicable.
- Spawned Chrome helper stdin remains ignored while stdout/stderr remain readable; PDF IPC returns a standalone `ArrayBuffer` suitable for structured cloning.

## Failure semantics

- Missing indexed application paths stop only that worker iteration; they do not turn an absent array item into a process path.
- Invalid update metadata fails at the manifest boundary with the existing invalid-manifest error.
- Unsupported remote target kinds are not compared or routed.
- Nullable results from lookup/deep-link parsing remain absent rather than being passed as concrete owner contexts or URLs.

## Acceptance

- The assigned-file diagnostics in `packages/desktop/tsconfig.main.json` are resolved with strict types and no `any`, suppression comments, or unsafe casts added to bypass the compiler.
- Existing desktop behavior and public module boundaries remain intact.
- Run focused tests for changed runtime validation/serialization behavior, the extra main-process TypeScript check, and the architecture check. Report unrelated or explicitly excluded diagnostics separately.
