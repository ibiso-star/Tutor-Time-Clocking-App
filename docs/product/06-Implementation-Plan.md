# Implementation Plan

## 1. Delivery approach
Build a secure, narrow MVP around online authoritative clocking, then add operational workflows and optional controls only after the core data model and policies are validated. Treat offline queued punches and sensitive location/photo/device features as explicit gated scope rather than assumptions. Run product, engineering, design, operations, and privacy review before production rollout.

## 2. Workstreams and phases

### Phase 0 — Discovery and policy decisions (1–2 weeks)
**Activities:** Confirm roles/scopes, project timezone rules, one-active-session rule, break policy, missed-punch process, payroll export fields, rounding legality, retention, offline acceptance model, privacy/legal basis for optional controls, support owner, and expected load. Validate the product flow with tutors and supervisors.

**Exit criteria:** Signed policy decision log; approved MVP scope; sample payroll export specification; threat/privacy review; prioritized backlog; measurable launch targets.

### Phase 1 — UX and technical foundation (1–2 weeks)
Create responsive tutor/admin wireframes and prototype, accessibility annotations, design tokens, API contract, database migrations, authentication/RBAC, project scoping, CI pipeline, development/staging environments, error/telemetry conventions, and seeded demo data.

**Exit criteria:** Core flows reviewed on mobile and desktop; API/data model reviewed; authorization tests and CI passing; deployment and rollback approach documented.

### Phase 2 — Clocking MVP (2–3 weeks)
Implement tutor dashboard, clock-in/out, break transitions, server UTC timestamps, state machine, idempotency, live duration/today totals, recent history, and clear loading/error/offline-blocked states. Add append-only clock events and atomic audit writes.

**Exit criteria:** Concurrency/retry tests pass; clock accuracy and duration fixtures pass, including DST; routine actions tested under 10 seconds; no client clock is used as the official time source.

### Phase 3 — Admin oversight and correction (2–3 weeks)
Implement live roster, search/filter, session detail timeline, long-session/missed-punch flags, correction request and review, reason-required manual adjustments, user/location/shift administration, and audit view.

**Exit criteria:** Tutor cannot access other users’ records; all correction decisions and adjustments are attributable and append-only; role-scope tests pass; operational exception flow is accepted by supervisors.

### Phase 4 — Exports, alerts, and configuration (2–3 weeks)
Implement CSV/PDF exports, filter builder, timezone/rounding preview, export history/versioning, notification rule management and deduped delivery, and project settings. Ensure settings changes are audited and historical event instants are not altered.

**Exit criteria:** Export totals match canonical fixtures; CSV formula injection protections tested; export download authorization/expiry tested; alert deduplication/retry tests pass.

### Phase 5 — Hardening and pilot (1–2 weeks)
Conduct accessibility audit, mobile browser testing, security review, privacy review, backup/restore drill, performance/load check, operational runbook and support training. Pilot with a small tutor group using demo or approved limited real data. Gather usability feedback and resolve critical defects.

**Exit criteria:** No critical/high security issues; WCAG review has no blocking defects in core flows; restore and incident procedures exercised; pilot approval and rollback decision documented.

### Phase 6 — Production launch and optional capabilities
Roll out by project/team with monitoring and support coverage. Add offline synchronization only after receipt-vs-capture acceptance rules, conflict review queue, and operational ownership are agreed. Enable geofence/photo/device controls independently, only after legal/privacy approval and dedicated retention/access controls.

## 3. Work breakdown and dependencies
| Work package | Depends on | Output |
|---|---|---|
| Policy and payroll decisions | Stakeholder availability | Decision log, report specification |
| Identity and project scoping | Role model | Auth, membership, server guards |
| Event state engine | Timestamp/idempotency schema | Validated clock command service |
| Tutor experience | API and design | Responsive clock and history UX |
| Admin roster/review | Session/event model | Live overview, correction inbox, audit detail |
| Adjustments | Correction policy | Append-only adjustment model and calculation |
| Export pipeline | Calculation and report spec | Logged CSV/PDF exports |
| Notifications | Schedule and alert policy | Deduped asynchronous notifications |
| Offline outbox | Conflict policy and threat review | Pending sync, server acceptance review |

## 4. Recommended team and ownership
A product owner makes policy/scope decisions; a designer owns flows and accessibility; a frontend engineer builds tutor/admin surfaces; a backend engineer owns state, authorization, event integrity and exports; QA/automation covers unit/integration/E2E; operations/security/privacy stakeholders review deployment and sensitive data. Small teams can combine roles, but independent review of authorization and payroll calculations is recommended.

## 5. Definition of done
Each feature includes acceptance criteria, role/permission tests, accessible responsive states, telemetry without excess PII, error handling, audit coverage, documentation, code review, and deployment/rollback notes. Database migrations are reversible or have a documented forward-recovery plan. No feature is production-ready if its required policy is unresolved.

## 6. Test plan
- **Unit:** state transition matrix, duration/break calculations, rounding, timezone and DST, validation.
- **Integration:** concurrent requests, retries/idempotency, atomic event/audit writes, correction version conflicts, notification dedupe, export snapshot.
- **End-to-end:** tutor sign-in/clock/break/clock-out/history/correction; admin roster/review/adjustment/export; mobile and desktop viewports.
- **Accessibility:** keyboard-only, screen reader, contrast, focus, scalable text, reduced motion, error announcements.
- **Security:** project isolation, object authorization, session security, CSRF where applicable, rate limits, injection, export leakage, sensitive data access.
- **Reliability:** database failure, worker retry, backup restore, clock API availability, late/duplicate sync if offline phase is enabled.

## 7. Release gates and rollout
Before pilot, verify time calculation fixtures and permissions. Before production, approve payroll and privacy policies, close critical security defects, validate exports with a payroll owner, complete restore drill, configure alert ownership, and publish support guidance. Roll out to a small cohort first; monitor rejected transitions, duplicate/idempotent replay rates, session anomalies, corrections, export failures, and notification delivery. Maintain a feature flag/rollback path for optional modules.

## 8. Indicative timeline
A focused MVP through pilot is approximately 9–15 weeks depending on team size, provider choices, PDF/export complexity, and policy review turnaround. This is a planning range, not a commitment; Phase 0 decisions and implementation capacity should determine the committed schedule.

## 9. Immediate next actions
1. Name a product/policy owner and confirm role/project scope.
2. Approve online-only clocking for first MVP or settle offline acceptance policy.
3. Obtain payroll export sample and validate rounding/break requirements.
4. Decide whether location/photo/device controls are excluded from launch (recommended default).
5. Select identity, hosting, database, and notification providers.
6. Review this package with tutor and supervisor representatives and baseline acceptance tests.
