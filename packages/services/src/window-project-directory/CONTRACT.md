# Window project directory

The optional `windowProjectDirectory` is one complete, read-only capability group. It projects this fork's already-open workspace directory rather than importing upstream's separate virtual-project storage model. Window tab state remains the membership owner. The existing platform synchronization forwards validated projections, ordered by a Main-assigned generation, to the same Window Host. The Host never reads Source settings for window entries.

All three channels are exposed on the existing attachment. File, model, task, and runtime services remain scoped to that attachment; no broadcast write, claim, secret, or configuration API is added. Missing capability keeps the legacy directory route. An advertised capability whose version check fails must reject readiness rather than silently selecting Source directory services. Mobile installs the optional proxies on its pre-open ChannelClient without replacing its reader or replay sequence.
