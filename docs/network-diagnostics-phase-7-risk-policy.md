# Network diagnostics: Phase 7 risk-policy preview

The Admin-only panel classifies the roadmap's future action categories as Low (router changes), Medium (customer or profile changes), and High (network or destructive changes). It is a local, simulation-only policy preview, not an action system.

Today, all categories fail closed: no router is connected, no approved adapter is available, and there are no live customers. The pure policy evaluator rejects unknown category IDs, requires future Admin enablement and an approved connected adapter for Low-risk actions, and requires an exact per-action Admin confirmation for Medium- and High-risk actions. High-risk work must never be initiated automatically.

The evaluator reports whether hypothetical policy prerequisites are met for human review; `executionPermitted` remains `false` for every result. A simulated confirmation does not authorize or apply a real change. This phase adds no controls, router calls, shell or command APIs, customer or database writes, migrations, live records, credentials, external AI, or network-device integration.

Any later live integration still requires separately scoped authorization, an approved adapter and identity/access model, defined allowlists and failure handling, and its own validation and review. No live integration is enabled by this preview.
