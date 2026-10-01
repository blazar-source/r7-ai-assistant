# ADR 0001: Embedded runtime and blocking compatibility gate

Status: Accepted constraint from product specification; runtime feasibility unverified.

## Context

Bank endpoints expose plain chat completion content without streaming/function calling. End users must not need developer tooling or local network services. The exact Astra/R7 version is the source of API truth.

## Decision

Use an embedded visual R7 plugin, static browser assets and direct verified HTTPS. Implement function calling only through a bounded local JSON protocol and author-written allowlisted Plugin API commands. Keep AI Hub unchanged. Never add localhost/daemon/MCP as a fallback.

Before subsequent product implementation, require real target evidence for inside UI, selection read/replace and direct authenticated HTTPS. If infeasible, investigate supported zero-port alternatives and report a real architectural blocker. Missing access is not proof of infeasibility.

## Consequences

No production Node or OOXML backend. SDK/API paths, secret persistence, CORS/CA and panel placement must be established experimentally. Unsupported tools remain unavailable. Clean checkpoint preserved; test work uses separate state. Build/release artifacts are withheld until real gates pass.
