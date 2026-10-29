# Vibe Amplified Tutor Time Clock — Product Development Pack

This folder translates the supplied product prompt into six development artifacts. The documents are intended to be reviewed together before implementation.

1. [Product Requirements Document](01-PRD.md) — goals, roles, MVP scope, business rules, metrics, acceptance criteria, and open decisions.
2. [Technical Requirements Document](02-TRD.md) — architecture, API outline, integrity/security controls, operations, and test requirements.
3. [Application Flow](03-Application-Flow.md) — tutor/admin navigation and primary/exception workflows.
4. [Design Brief](04-Design-Brief.md) — interaction, visual, responsive, accessibility, and state guidance.
5. [Database Schema](05-Database-Schema.md) — PostgreSQL-oriented entities, constraints, relationships, and retention notes.
6. [Implementation Plan](06-Implementation-Plan.md) — phased roadmap, dependencies, quality gates, and rollout.

## Material assumptions
The recommended first release uses online server-authoritative clock events, append-only source events, auditable adjustments, project-scoped roles, and sensitive location/photo/device controls disabled by default. Offline synchronization is phase-gated because capture time is not equivalent to accepted official time. Payroll rounding, retention, breaks, and optional monitoring controls require organization/legal review before production.

These are planning documents, not a compliance certification or final architecture decision. Resolve the open decisions in the PRD/TRD before committing implementation scope.
