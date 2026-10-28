# gen-ui-protocol

Pure wire contracts for generated conversation UI. A reference identifies an executor-side file;
it does not grant file access. The target Host authorizes and normalizes paths. Workspace identity
and session isolate state. A state update replaces a JSON snapshot of at most 16 KiB. Only
modelContent can enter bounded, untrusted model context. No MCP plugin identity or tool permission
is implied by a generated UI reference.

Model context uses stable path order and considers only the first 100 entries before validation.
The first valid model entry that exceeds the 64 KiB UTF-8 JSON-array budget stops selection.
The budget precedes delimiter escaping; complete state validation still includes privateContent.
Each selected output entry is serialized once within the call, without shared caches or input mutation.

Tweak messages follow the upstream registration/update/disposal and ACK lifecycle. Each registration identifies one DOM target and at most 12 typed controls; preview changes carry registrationId, targetId, callback and previousValue. The page owner accepts at most 64 live registrations. This private Gen UI method grants no generic tool access.
