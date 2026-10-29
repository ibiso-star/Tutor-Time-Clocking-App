# Product Requirements Document (PRD)

## Vibe Amplified Tutor Time Clock
**Status:** Draft for product/engineering review  
**Version:** 1.0  
**Source:** Refined Vibe Amplified Tutor Time Clock prompt

## 1. Product summary
A mobile-first web application for tutors to record work sessions and breaks, and for authorized supervisors to monitor attendance, review exceptions, resolve correction requests, and export auditable timesheets. Accurate, transparent time records and low-friction routine clocking are the primary product outcomes.

## 2. Problem and opportunity
Tutors and project administrators need a consistent source of truth for work time. Manual or fragmented records create missed punches, disputes, delayed payroll, and weak auditability. The product replaces informal capture with server-timestamped events, reviewable adjustments, clear status, and controlled exports.

## 3. Goals and non-goals
### Goals
- Tutors can clock in/out in under 10 seconds in normal online operation.
- Prevent invalid state transitions and duplicate event creation.
- Provide a clear personal status, current duration, daily total, recent history, and correction-request path.
- Give admins live status, exception alerts, full event/audit timelines, and filtered payroll exports.
- Preserve original records; adjustments are additive and attributable.
- Keep location, photo, and device controls optional, disclosed, and configurable.
- Support common mobile browsers and accessible interaction.

### Non-goals for initial release
- Native iOS/Android apps or background location tracking.
- Payroll calculation, tax withholding, or direct payroll-provider submission.
- Biometric identity verification performed by the server; device-native authentication can be considered later.
- Continuous GPS tracking or employee productivity monitoring.
- Complex multi-organization SaaS billing or public self-service tenant creation.

## 4. Users and roles
- **Tutor:** manages own clock events, breaks, assigned shifts, history, and correction requests; cannot edit official events.
- **Supervisor:** views assigned project/team data, resolves corrections, performs reasoned manual adjustments where permitted, and exports authorized data.
- **System administrator:** manages identities, roles, projects, policy settings, retention, and integrations. Elevated actions require audit records.

Access is scoped by project and, where applicable, team. Server-side authorization is mandatory.

## 5. MVP scope
1. Secure sign-in, password reset, optional MFA; role-based tutor/admin experiences.
2. Tutor dashboard with status, primary action, elapsed time, today total, recent entries, shifts, and correction-request list.
3. Server-authoritative online clock-in/out and configurable breaks.
4. Idempotent event submission, state validation, and immutable event history.
5. Admin live roster, search/filter, detailed event timeline, long-session/missed-punch flags.
6. Correction workflow with request details, reviewer decision, reason, and preserved original data.
7. Manual admin adjustment with mandatory reason and audit history.
8. CSV and PDF exports with explicit scope, timezone, rounding policy, record version, actor, and export time.
9. Project settings for timezone, breaks, rounding, max shift duration, notifications, location/geofence, photo/device controls, and retention (feature-flagged; sensitive controls off by default).
10. Responsive accessible UI, seed/demo data, automated acceptance tests, setup/deployment documentation.

## 6. Later / conditional scope
- Offline clock events: local queue with idempotency UUID, captured device time, server receipt time, explicit pending status, conflict review; never portray queued time as accepted official time. Enable only after threat-model and conflict-policy review.
- Geofence warn/block, optional at clock-in only; fallback and appeal/correction route required.
- Photo capture/device binding, only after legal/privacy assessment, explicit project opt-in, retention rules, and consent UX.
- Scheduled shift reminders and integrations.

## 7. Core requirements
### Tutor
- Show one of Clocked Out, Clocked In, On Break using both text and visual indication.
- Clock in from allowed state; capture work location/session only if required by project policy.
- Clock out only with active session; breaks end or are explicitly resolved per policy.
- Show confirmation, active duration, daily total, and clear offline/error feedback.
- Submit correction for a specific event/session with requested change and explanation; see status/history.

### Admin
- See currently active tutors and status, start time, elapsed time, location/session where available, and exceptions.
- Search/filter by tutor, date, location, project, session, status, approval, and sync state.
- Review full timeline, accept/reject corrections with reason, and make manual adjustments with reason.
- Configure settings within their authorization and export CSV/PDF. Exports are reproducible and logged.

## 8. Business rules
- Official event timestamps are generated by server and stored as UTC instants; timezone is a project/display/reporting attribute.
- A tutor may have at most one open work session per project (confirm whether cross-project concurrent work is ever allowed).
- Valid states: OUT → IN → BREAK → IN → OUT; break feature disabled means IN → OUT. Invalid transitions are rejected with actionable messages.
- Session duration = clock-out minus clock-in minus completed/accepted break intervals. Open or overlapping breaks are flagged, not silently inferred.
- Exact-minute calculation is default. Rounding is disabled unless explicitly configured; exports identify the rule.
- Original events and exported snapshots are not overwritten. Corrections and manual adjustments are linked, versioned records.
- A session exceeding project maximum duration is flagged; do not auto-close without an explicit policy.
- Offline device time is evidence, not official time, until accepted under a documented policy.

## 9. Success metrics
- ≥95% of routine online clock actions complete in under 10 seconds (instrumented, excluding auth delays).
- Duplicate official events: zero accepted duplicates in reliability tests and monitored production.
- ≥99.9% successful event write availability target, subject to chosen hosting/SLO.
- ≥90% of correction requests resolved within configured service target (baseline to be set by operations).
- Export reconciliation: totals match canonical calculations in automated test fixtures.
- Accessibility: WCAG 2.2 AA target for core flows; no critical automated or manual audit defects before launch.

## 10. Risks and open decisions
- **Offline time integrity:** define whether late-synced events are estimates pending supervisor acceptance or are automatically accepted under limits.
- **Employment/payroll rules:** obtain jurisdiction-specific review for rounding, breaks, retention, and audit requirements before production.
- **Location/photo/device policies:** determine lawful basis, necessity, retention, and accommodations; default off.
- **Scope:** confirm whether supervisors are project-scoped and whether tutors can work across multiple projects simultaneously.
- **Exports:** confirm exact payroll fields, PDF layout, rounding semantics, and whether corrections after export require a revised export/version.
- **Operational ownership:** identify support escalation, missed-punch review SLA, and account provisioning owner.

## 11. Acceptance criteria
- Valid clock-in/out records have server timestamps in UTC and correct state transitions.
- Repeated requests with the same idempotency key produce one event; conflicting keys cannot create invalid state.
- Tutor sees correct status/duration/today total and recent history after refresh/login.
- Admin can trace original event, correction, decision, manual adjustment, and export metadata.
- CSV/PDF apply selected dates/timezone/rounding consistently and log export metadata.
- Offline or permission-denied states are clearly explained and do not falsely claim acceptance.
- Core flows are keyboard operable, screen-reader labeled, and not color-only.

## 12. Assumptions
- Initial deployment serves one Vibe Amplified organization/project environment, with project-level settings and role scoping.
- A responsive web app is the primary client; backend APIs enforce all authoritative rules.
- Data retention, privacy notices, and payroll compliance will be reviewed by the organization before real employee data is used.
