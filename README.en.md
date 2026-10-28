# ZCodium

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCodium" width="128" height="128" />
</div>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

<p align="center">
  <em>"Why are we so committed to open source? Because this vision itself demands it. Without this vision, you cannot bring people together. Take Zhipu, for example — they also open source, but their open source is not the same as ours. Theirs has a sense of being forced; they feel it is not their original intent. But for us, this is our intent."</em><br />
  <em>— Liang Wenfeng, CEO of DeepSeek</em>
</p>

ZCodium is an independent audit fork of ZCode. Upstream ZCode is an AI coding workspace with desktop, browser, and terminal interfaces; this repository contains the clients, backend services, shared UI, and Agent CLI and runtime source code. Code updates are absorbed only from the official open-source repository [zai-org/ZCode](https://github.com/zai-org/ZCode), while keeping the "no telemetry, no dependency on official cloud services" audit boundary. See [docs/specs/maintenance-model.md](docs/specs/maintenance-model.md) for the maintenance rules.

## What this repository is

Upstream was forced to open-source ZCode client in September 2026, but the released source is not equivalent to the installers they actually ship: the published packages contain a set of features that the open-source tree does not. ZCodium tracks only the official source and **evaluates installer-only local capabilities under its product, privacy and licensing boundaries**. It does not restore official telemetry, accounts, purchases or cloud services, and does not promise complete feature parity.

Backfilling methods include supplying the missing built-in plugins and skills, locating feature gaps by diffing i18n keys, and aligning interaction flows with the protocol and settings schemas. Every backfill is recorded as a spec under [.agents/specs/](.agents/specs/) covering scope, state ownership, interface contracts, and acceptance scenarios.

[Another ZCodium (audit reference, not a merge source)](https://github.com/ZCodium-project/ZCodium)

[Shh... don't let the user know what we are doing](apps/zcode-cli/tools/repo-snapshot-parody/README.md)

### Capability delta versus the official package

Verified against the **official 3.14.3 installer** (`ZCode-3.14.3-win-x64.exe`, `appVersion: 3.14.3`, built 2026-09-22). Method: pull the locale table from `out/renderer/assets/IntlProvider-*.js` inside the installer's `resources/app.asar`, then diff its keys against [packages/ui/src/i18n/locales/](packages/ui/src/i18n/locales/). This is a historical audit baseline, with some notes updated for later work; it is not a complete acceptance review of the current 3.15.1 tree. Locale key counts are not feature counts.

**Backfilled**:

- Ten built-in plugins and skills: documents, pdf, presentations, spreadsheets, skill-creator, plugin-creator, image-search, restore-legacy-sessions, zcode-guide, zcode-cua. Open-source commit `44b25ed46c` removed their sources while the official package still ships them. Scope: [.agents/specs/builtin-plugin-parity.md](.agents/specs/builtin-plugin-parity.md), [.agents/specs/pdf-plugin-backfill.md](.agents/specs/pdf-plugin-backfill.md), and [.agents/specs/spreadsheets-plugin-backfill.md](.agents/specs/spreadsheets-plugin-backfill.md).
- The Computer Use model-visible surface: `apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs`, skill, and docs. The native runtime (koffi/sharp, roughly 20 MiB) is not published with the package, matching upstream's `runtimeTopLevelPaths: []`.

**Historical locale categories** (258 keys at the time; later implementations and intentionally excluded cloud features are retained below, not a current gap total):

| Area               | Gap     | Notes                                                                                           |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `webRemoteControl` | Closed  | Phone remote control uses the existing desktop Host; LAN pairing and optional self-hosted relay |
| `manualClaimPlan`  | 53 keys | Official benefits/captcha; intentionally excluded                                               |
| `mode`             | 38 keys | Session mode extensions                                                                         |
| `settings`         | 26 keys | Includes Claude model slot mapping and multi-protocol endpoint templates                        |
| `server`           | 12 keys | Server entry                                                                                    |
| `appHeader`        | 8 keys  | Provider configuration entry                                                                    |
| `marketingTouch`   | 7 keys  | Official benefit touchpoints; intentionally excluded                                            |
| `taskList`         | 6 keys  | Codex / Claude new-task flows                                                                   |
| `chat`             | 5 keys  | agent switching                                                                                 |
| `rewards`          | 5 keys  | Official benefits menu; intentionally excluded                                                  |
| `onboarding`       | 4 keys  | agent settings step                                                                             |
| Other              | 5 keys  | `remote`, `zcode`, `titleBar`                                                                   |

The historical `bots` gap closed after the 3.14.3 merge. Phone remote control was implemented later: LAN pairing connects to the existing desktop Host, with an optional user-hosted relay (see [.agents/specs/web-remote-control.md](.agents/specs/web-remote-control.md)). Official benefit claiming is intentionally excluded, not backfill debt. The historical reverse difference contained 33 in-house keys; current totals are not recomputed here.

**Deliberately not backfilled**:

- Repository snapshot upload. Official builds before 3.14.0 packaged the entire workspace (including `.git`) before every prompt and uploaded it encrypted to object storage, with the server holding the private key. Upstream removed this behavior and this repository does not implement it either; only a localhost-only reproduction is kept at [apps/zcode-cli/tools/repo-snapshot-parody/](apps/zcode-cli/tools/repo-snapshot-parody/) for audit comparison — keys are generated locally and non-loopback targets are rejected by default.
- Official telemetry collection and reporting. ZCodium retains privacy-filtered local diagnostics, with external export disabled by default. Users can explicitly configure their own OTLP collector. See [diagnostics](DIAGNOSTICS.md).
- Official accounts, login/OAuth, purchases, plans, benefit claiming, marketing, sharing/upload services, client config/rollout, official relay and update sources. Historical identifiers and database migrations remain readable without restoring account execution.

### Backfill routes

**Landed**:

- **`bots`: official implementation plus the AstrBot bridge, side by side.** Upstream 3.14.3 open-sourced the official `bots` stack (four platform adapters and the platform-selection GUI), which is now merged in this repository. The in-house [AstrBot](https://github.com/AstrBotDevs/AstrBot) bridge is no longer a service parallel to the official `BotsService`; it has been folded into the official `BotsService` as a single transport provider (`BotProviderAdapter`, with the channel fixed to `astrbot`) and wired into both the official Bots GUI and the phone remote-control entry. AstrBot owns the platform adapters while this repository maintains only the bridge contract (wire protocol v2). Connector setup and its independent third-party source are documented in [AstrBot bridge](docs/astrbot-bridge.md); see [.agents/specs/bots-astrbot-bridge.md](.agents/specs/bots-astrbot-bridge.md).
- **Computer Use runtime**: the native execution layer is not built in-house. It reuses `@trycua/cua-driver` from the open-source [`trycua/cua`](https://github.com/trycua/cua) project (MIT, Rust, macOS / Windows / Linux), with the adapter in [packages/zcode-cua/](packages/zcode-cua/). The client is injected by the upper layer, and the runtime stays fail-closed without one. Older GNOME / Wayland gets a separate physical-input compatibility layer. Capability mapping and gaps, the adapter contract, and per-platform mechanisms are covered in [.agents/specs/computer-use-capabilities.md](.agents/specs/computer-use-capabilities.md), [.agents/specs/computer-use-runtime.md](.agents/specs/computer-use-runtime.md), and [.agents/specs/computer-use-platform-architecture.md](.agents/specs/computer-use-platform-architecture.md) respectively.

**User-configured capability**:

- **image-search has no default server**: configure the full `imageSearchMcpUrl` (local or user-hosted remote MCP) and optional authorization header. The plugin is disabled by default and stays silent until configured. No backend or official credential injection ships here. See [.agents/specs/image-search-local-backend.md](.agents/specs/image-search-local-backend.md).

### Relationship to upstream

This repository tracks **only the official** [zai-org/ZCode](https://github.com/zai-org/ZCode); it does not track any third-party fork. [ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium) is a read-only reference for audit principles and implementation approaches, never a merge source.

Every sync follows the same order: fetch the official tag, create a sync branch, merge (never rebase), resolve conflicts under the audit boundary, run the checklist, and record the official baseline, absorbed items, stripped items, unsynced items, and validation scope. The full process and the debt list are in [docs/specs/maintenance-model.md](docs/specs/maintenance-model.md).

**Audit boundary**: no official telemetry, monitoring, crash collection, resource/network sampling uploads, or UI analytics; no dependency on official accounts, purchases, plans, sharing, uploads, automatic official marketplace fetches, official client config/rollout, official relay, or the official update source. Users bring their own API keys or custom providers; safe local logs remain available; background sampling and external export are separately disabled by default. Export requires an explicit enable flag and a user-owned collector. When upstream reintroduces a removed telemetry/cloud module, keep this fork's removal and add a minimal adaptation instead of restoring the module to make tests green.

**Backfill rule**: assess only local capabilities compatible with this fork's product and audit boundaries. Installer, source and runtime evidence identify differences; installer presence alone does not authorize restoring telemetry, accounts, benefits or cloud services. Define the spec, license and acceptance first; do not promise full-product parity. That work lands as per-feature commits, with the scope, the reasoning behind each decision, and anything left unverified recorded under [.agents/specs/](.agents/specs/). Licensing and third-party attribution are covered in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

| Interface                    | Purpose                                                                                   | Development command            |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Desktop                      | Electron desktop application                                                              | `pnpm dev:desktop`             |
| Web / ZCode CLI distribution | Terminal and browser workspace; packages the TUI, Web client, backend, and Agent together | `pnpm dev:web`                 |
| Agent CLI                    | The `zcode` terminal interface, which also provides the Agent runtime for Desktop and Web | `pnpm --filter @zcode/cli dev` |

## Updates

- 2026-09-24: Folded the AstrBot bridge into the official `BotsService` as a transport provider, and wired it into the official Bots GUI and the phone remote-control entry (#11–#14).
- 2026-09-24: Re-verified the i18n key gap against the official 3.14.3 installer — `bots` is down to 0 keys and 258 keys remain; the method is documented under "Capability delta versus the official package".
- 2026-09-24: Switched the Computer Use runtime to `@trycua/cua-driver` as the single native engine and removed the in-house desk-pilot; the client is injected by the upper layer, the runtime stays fail-closed without one, and older GNOME / Wayland goes through a separate physical-input compatibility layer.
- 2026-09-24: Merged upstream 3.14.3 (`328c1a0`); adopted the official bots and the newly open-sourced remote-control surfaces, keeping the `.zcodium` data namespace.

## Versioning

The release version comes from the root [package.json](package.json). Release tags must be exactly `v<version>`; `node scripts/ci/desktop-release.mjs check-version` validates this match. Installer names use the separate ZCodium product identity: `ZCodium-<version>-<platform>-<arch>.<ext>`. The fork does not require a `-modified` suffix.

Desktop CI runs only through explicitly requested manual `workflow_dispatch`, producing Windows x64/arm64 exe and macOS arm64/x64 DMG artifacts. Branch pushes, tag pushes and pull requests do not trigger it. This fork does not distribute Linux installers or Linux remote runtime assets; phone remote control remains available.

## Setup

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all development and packaging commands below from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and runs `build:bootstrap`.

The Agent CLI and runtime source code lives in [apps/zcode-cli/](apps/zcode-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Additional setup and build commands:

| Command                        | Purpose                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `pnpm install`                 | Install dependencies                                                                         |
| `pnpm prepare:desktop-runtime` | Prepare local runtime assets for the target Windows/macOS platform                           |
| `pnpm build`                   | Recursively run each workspace package's build script, including its asset preparation steps |

This fork builds Windows/macOS desktop packages only and does not prepare or embed Linux remote runtime assets. SSH, WSL, and Linux container workspace deployment is unavailable in these desktop builds. Mobile remote control connects to the local desktop Host and remains available.

## Development and Usage

### Desktop

```bash
pnpm dev:desktop

# Use the test environment
pnpm dev:desktop:test
```

`pnpm dev:desktop` defaults to `pnpm dev:desktop:prod` and uses production service configuration. The startup script prepares local runtime assets, builds the desktop Agent, then starts Electron and source watchers.

Set `ZCODE_DATA_BASE_DIR` to use a separate development data directory. For example, on macOS:

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcodium-dev-home" pnpm dev:desktop:test
```

### Web Development

Use development mode when editing Web or backend source code:

```bash
pnpm dev:web

# Set the backend workspace (macOS / Linux)
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

This starts both the Web development server (default: `http://localhost:5173`) and the backend (default: `http://localhost:3030`). Open the Web development server in your browser. `/ws` and `/api` requests are proxied to the local backend; there is no official account token proxy.

After changing Agent source code, run `pnpm --filter @zcode/cli... build` and restart the service. To validate the complete distribution, extract and run it as described under Packaging → ZCode CLI distribution below.

### ZCode CLI distribution

The command-line distribution includes the TUI, Web client, and Agent behind one `zcode` command. With no arguments it starts the TUI; a leading `--web` starts Web mode; all other arguments go to the existing Agent CLI. Both modes run locally without Electron.

```bash
# Start the terminal UI by default
zcode

# Start the Web interface
zcode --web

# Set the project and port without opening a browser automatically
zcode --web --workspace /path/to/project --port 3030 --no-open

# Show CLI or Web options
zcode --help
zcode --web --help
```

In Web mode, it uses the current directory as the workspace, listens on `127.0.0.1` without token authentication by default, selects an available port, and opens a browser. Use the URL printed in the terminal and press `Ctrl+C` to stop the service. For LAN access, use `--host 0.0.0.0`; listening on a non-local address generates an access token by default. Use the token-bearing URL printed in the terminal. Set a token with `--token`, or disable token authentication with `--no-token`.

When starting the general Web service's HTTP entry directly, configure API/WebSocket authentication with `ZCODE_SERVER_AUTH_TOKEN`. When creating the service programmatically, use the `authToken` option.

See Packaging below for build instructions. `pnpm build:zcode` only creates the distribution; it does not replace an existing `zcode` on `PATH`. If the command still points to an older installation or another checkout, check it with `command -v zcode` on macOS / Linux or `where.exe zcode` on Windows.

### CLI Source Development

Use the source entry when developing the TUI or Agent:

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# Build the CLI and its workspace dependencies
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

This entry runs the Agent CLI directly and does not handle the distribution's `--web` switch. Use `pnpm dev:web` for Web development, or the extracted `bin/zcode.mjs` shown below to test the unified command.

### UI Plugin development

See the [UI Plugin guide](UI_PLUGIN.en.md) for the Excalidraw workflow, supported APIs, plugin installation and updates, and host debugging.

**Plugin PRs in `zcode-plugins` must declare whether they affect a UI Plugin and list the plugin names in the PR template.** See the [required plugin-type declaration](UI_PLUGIN.en.md#declare-the-plugin-type-in-pull-requests).

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration. Copy it to `.env` as needed and place local overrides in `.env.local`. Select the Desktop development environment with `dev:desktop:test` or `dev:desktop:prod`.

| Setting                              | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `ZCODE_DATA_BASE_DIR`                | Base directory for application data, stored under its `.zcodium/` subdirectory          |
| `ZCODE_SERVER_WORKSPACE`             | Workspace path for the Web backend                                                      |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset |
| `ZCODE_DIST_BASE_URL`                | Download base URL used by the CLI distribution installer                                |

Runtime variables can be set explicitly in the environment of the startup command. See [config/README.md](config/README.md) for the default configuration shipped with the client.

## Packaging

### Manual GitHub builds

[Desktop CI](.github/workflows/desktop.yml) is the only workflow and responds only to manual `workflow_dispatch`. Branch pushes, tag pushes and pull requests do not trigger it. Checks and Windows x64/arm64 plus macOS arm64/x64 builds run in parallel from the same ref. Artifacts are `desktop-win-x64`, `desktop-win-arm64`, `desktop-mac-arm64` and `desktop-mac-x64`, retained for 14 days. Windows produces exe and macOS only DMG; no Linux installer or remote runtime is built.

The workflow only uploads Actions artifacts; it does not create or update GitHub Releases. Build only when explicitly requested and verify the target branch is already pushed; do not use a build to bypass a no-push instruction. A manual tag run must still match `v<package.json.version>`. release-it defaults to no push; version changes, commits, tags, pushes and publication each need authorization, and explicit pushes target only `origin`.

The workflow uses the built-in `GITHUB_TOKEN` and needs no additional service credentials or signing certificates. Installers are unsigned. In-app updates and standalone remote runtime assets are outside this workflow. See the [CI/CD spec](.agents/specs/desktop-ci-release.md).

Third-party notices are generated by `node scripts/licenses.mjs notices` from the production dependency graph and source/native-component license records under [third-party/](third-party/); the output is [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), shipped with each distribution. CLI distribution assembly and verification live in [scripts/zcode-distribution/](scripts/zcode-distribution/).

### Desktop

Prefer GitHub builds. Run these local packaging commands only when explicitly requested, with `ZCODE_ENV=production` set from asset preparation onward.

```bash
pnpm bundle:desktop

# Set the target platform and CPU architecture
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

The default target is macOS arm64, and the default output directory is `packages/desktop/dist/`. `--os` accepts only `mac` or `win`; `--arch` accepts `x64` or `arm64`. Packaging and signing require the tools and configuration for the target platform.

### ZCode CLI distribution

Run `pnpm build:zcode` to build the CLI/TUI, backend, and Web client, collect the TUI native libraries, workers, and runtime dependencies, then assemble the distribution. Running the distribution still requires Node.js; use the version specified in `mise.toml`.

Before packaging, set the download base URL with `ZCODE_DIST_BASE_URL` in `.env`, `.env.local`, or the process environment, or pass it through `--base-url`. The URL below is a placeholder; replace it with your hosting URL when publishing:

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# When ZCODE_DIST_BASE_URL is already configured
pnpm build:zcode

# Repackage existing Agent, backend, and Web build outputs
pnpm build:zcode --skip-build

# Show options for the version, output directory, and more
pnpm build:zcode --help
```

The version defaults to the root `package.json` version. Output is written to `dist/zcode/`:

- `releases/<version>/zcode-<version>.tar.gz`: runtime package.
- `releases/<version>/sha256.txt`: checksum file.
- `latest.json` and `install.sh`: version index and installer.

Upload the entire directory to the configured download base URL. The installer downloads the runtime package from that URL, installs it to `~/.zcodium/runtime` by default, and creates the `zcode` command in `~/.local/bin`. Override these directories with `ZCODE_DIST_HOME` and `ZCODE_DIST_BIN_DIR`, respectively.

Existing Lite users should switch to the new build command, environment variables, and installer. Installation does not remove old Lite directories or migrate/delete session data.

To test a packaged build locally, extract and run it directly without uploading or installing it:

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# Start the TUI by default
node dist/zcode/debug/zcode/bin/zcode.mjs

# Start Web mode
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

Open `http://127.0.0.1:3030` to validate the complete flow, with one backend serving the Web pages and running the Agent. The port must be available; if `pnpm dev:web` is already running, choose another `--port`.

## Repository Structure

| Directory                                            | Responsibility                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging                                    |
| `packages/web`                                       | Web client                                                                              |
| `packages/server`                                    | HTTP / WebSocket services and remote connections                                        |
| `packages/zcode-server-cli`                          | Standalone server startup and process management                                        |
| `packages/ui`                                        | Shared React components, hooks, and Zustand state                                       |
| `packages/services`                                  | Business services and persistence                                                       |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols and types, RPC framework, and Agent client SDK                         |
| `packages/provider`, `packages/provider-node`        | Common provider capabilities and Node implementations                                   |
| `packages/model-option-map`                          | Model option map compilation                                                            |
| `packages/formal-proof`                              | Product behavior state-space enumerator                                                 |
| `packages/zcode-cua`                                 | Computer Use runtime adapter                                                            |
| `apps/zcode-cli`                                     | Agent CLI, TUI, runtime, and tools                                                      |
| `scripts`, `config`, `third-party`                   | Build and maintenance scripts, built-in configuration, and third-party notice materials |
| `harness/remote`                                     | SSH Docker image for remote-workspace integration work                                  |

Added by ZCodium:

| Path                                         | Responsibility                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `.agents/specs/`                             | Backfill specs: scope, state ownership, interface contracts, acceptance |
| `apps/zcode-cli/packages/*-plugin`           | Built-in plugin and skill sources                                       |
| `apps/zcode-cli/tools/repo-snapshot-parody/` | Localhost reproduction of the repo snapshot upload, for audit only      |
| `.agents/skills/`                            | Coding-agent skills: architecture governance, Electron, React, etc.     |
| `docs/`                                      | GitHub Pages landing site                                               |

Coding conventions, the pre-work baseline check, and per-domain rules live in [AGENTS.md](AGENTS.md); plugin-store domain vocabulary is in [CONTEXT.md](CONTEXT.md) and UI design rules in [DESIGN.md](DESIGN.md).

The `astrbot-zcodium-plugin/` directory on disk is a separate working copy of the companion AstrBot plugin; it is not under this repository's version control and is not produced by cloning this repository.

## Project Notice

See [NOTICE.md](NOTICE.md) for feature and promotion scope, maintenance policy, execution and data risks, licensing, and third-party copyright information.
