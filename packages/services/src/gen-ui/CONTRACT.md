# gen-ui-service

Target Workspace Host owns bounded, nonsymlink fragment reads. Desktop Local Host owns persisted
widget state and issues sandbox registrations with explicit gen-ui provenance. Remote workspace
content uses the existing remote services route; desktop state uses base services. No new Agent,
MCP server, content publication journal or accepted command queue is introduced.

The execution Host owns an output root under its application data directory and passes that root
to the Agent at process startup. Host reads and Agent context use the same scope-to-directory
function, keyed by workspace identity (path fallback) and session ID. Only that session directory
is readable; project workspace files and other sessions are rejected.
Local conversation sessions instead write into `visualizations` under their CLI-owned execution
directory. The Host resolves that directory through an injected, trusted session query; callers
cannot supply an authorization root. Both output layouts use the shared directory resolver and
reject symbolic links. Existing global output files remain readable without moving user content.
Actors inheriting an explicit execution directory outside the conversation root retain the Host
global output layout; that external directory never becomes a fragment-read authorization root.
Creation failures surface before the runtime advertises a writable directory. HTML stays on the
execution machine; widget state stays on the desktop. Neither storage belongs in the Git workspace.

State storage is an injected adapter. Atomic file replacement and the existing cross-process file
lock serialize full snapshots; notifications project durable state. Only modelContent is exported
as untrusted next-turn context. Main owns native sandbox resources, not persisted state.

Notification reads are serial per file and may share a read that has not started yet. Signals
arriving during a read require a subsequent read, so later durable state cannot be missed. A state
write waits for its corresponding notification read, not for the file to become idle. Files,
workspace identities and sessions keep independent notification scheduling. These notifications
are latest full-state projections, not a journal of filesystem events.
