# Phase 18 — live capability status overview

The Admin diagnostics panel now starts with a compact, static overview of which network capabilities are and are not available. It is rendered by the existing lazily loaded diagnostics module.

The live-state group reports **Device connection: Not connected** and marks live network health, active PPPoE sessions, issues, resolved-today status, Admin attention, alerts, and network actions **Unavailable**. It contains no operational counts, counters, timestamps, or customer/router identities. Unavailable means there is no live source from which to report those states; it is not a measured zero. The panel also states that no live monitoring or AI automation is running.

A separate, visibly labeled group reports **Simulator: Available · synthetic only**. The simulator remains a deterministic local demo and is not presented as live telemetry, customer state, a completed fix, or an action.

This is a presentation-only change. It adds no API, database, Supabase, customer, router, RouterOS, RADIUS, or OLT query; no writes, schema or Auth changes; no external AI; and no action controls. Tests verify the exact status contract, the live/synthetic separation, absence of fabricated operational metrics or identities, and localization/accessibility/responsive styling.
