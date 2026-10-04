# Network diagnostics roadmap: Phases 4–6

The Admin-only network diagnostics panel remains a local simulator. It uses three fictional profiles, exact synthetic identifier matching, deterministic English/Roman Urdu/Urdu symptom phrases, and canned scenario evidence. Unsupported or ambiguous complaints stop before a diagnostic result is produced.

## Controlled steps and diagnosis

The diagnostic engine accepts only three local steps: synthetic profile fixture evidence, deterministic symptom classification, and fictional scenario evidence. Unknown step identifiers and live-tool identifiers are rejected. Nothing searches portal records or invokes a network, shell, AI, storage, or write capability.

A supported complaint automatically maps to one of three fixed examples: disconnected/no internet, slow speed/profile mismatch, or intermittent disconnection. Every finding is explicitly synthetic; its separate state says whether it is mock evidence or unavailable. The result states that it is not live network data, no change was applied, and service restoration was not verified.

## Live-only checks

Every simulated result marks these checks individually as `unavailable`: router status and management IP, subscriber IP address, WAN link, DNS resolution, routing table, live traffic, packet loss, measured throughput, and live PPPoE session history. There is no router connected and there are no live customers in this setup; these statuses are not failed tests or inferred root causes.

## Dependencies for a later live-device phase

Live checks require a separately scoped and authorized router connection, an approved read-only access path and identity model, explicit device/source allowlists, and defined timeout and failure behavior. IP, WAN, DNS, routing, traffic, packet-loss, throughput, and session results also need agreed measurement semantics and a safe validation target. None of those connections, credentials, customer lookups, database or Auth changes, migrations, persistence, or network actions are part of Phases 4–6 here.
