# Application Flow

## 1. Navigation model
**Tutor:** Sign in → Home/Clock → Time history → Correction requests → Profile/settings.  
**Supervisor/Admin:** Sign in → Live dashboard → Time entries/detail timeline → Corrections inbox → Exports → People/locations/schedules → Project settings.  
Role and project scope determine which navigation items and records are visible.

## 2. Tutor flow: clock in
1. Tutor opens the app and authenticates. Session restoration returns to the correct project and current state.
2. Home prominently shows **Clocked Out**, today’s total, next assigned shift (if any), and a large **Clock In** action.
3. If a location or shift is mandatory, select/confirm it. If location permission is enabled, explain purpose and request permission at this point; if denied, apply configured fallback (warn, alternate location, or block with support/correction route).
4. Client disables repeat activation while request is in flight and sends an idempotency key. Server checks authorization, policy, state, and writes the event and audit row atomically using server UTC time.
5. Success view shows **Clocked In**, start time, running duration, selected session/location, and **Clock Out** plus optional **Start Break**. If network fails, show either a clear failure (online-only MVP) or **Pending sync** (offline-enabled product), never a false success.

## 3. Tutor flow: break and clock out
- **Break start:** From Clocked In, tap **Start Break** → confirm state change → server records event → display On Break and break duration. If breaks are disabled, hide the control.
- **Break end:** From On Break, tap **End Break** → server records event → resume active work duration.
- **Clock out:** From Clocked In, tap **Clock Out** → optionally show concise confirmation if configured → server validates state and records event → show session worked duration excluding breaks and updated daily total. If on break, policy either requires ending break first or offers an explicit combined “End break and clock out” event sequence; do not infer silently.

## 4. Tutor flow: history and corrections
1. Open recent entries/history and select a session.
2. Review start/end, breaks, location/session context, calculated hours, and sync/review status.
3. Select **Request correction**; indicate what is wrong, requested values, and explanation.
4. Submit once; show request ID, submitted time, and status **Pending review**.
5. On decision, show approved/rejected result, reviewer reason, and resulting adjusted interpretation. Preserve original events in the timeline.

## 5. Admin flow: live oversight
1. Admin signs in and lands on a live roster scoped to authorized project/team.
2. Roster rows show tutor, state, clock-in time, elapsed duration, location/session when collected, and alert badges. Provide search, filters, sort, and refresh/live update indicator.
3. Selecting a row opens details: canonical session calculation, raw event timeline, sync metadata, corrections, adjustments, and relevant audit history.
4. Admin addresses alerts: missed clock-out, max duration, geofence, late sync/conflict, and pending correction. Alerts link to records and can be acknowledged/resolved with traceable action.

## 6. Admin flow: correction review
1. Corrections inbox shows pending items with tutor, affected period, request time, and age.
2. Reviewer opens request and compares original record, requested change, explanation, schedule/context, and prior decisions.
3. Reviewer chooses approve or reject and must enter a reason. API rechecks authorization and current record version to catch concurrent changes.
4. Approval appends a correction/adjustment and new effective calculation; rejection leaves original unchanged. Both decisions are audited and notify the tutor.

## 7. Admin flow: manual adjustment
1. Search/select tutor and date/session; review underlying events.
2. Start adjustment and enter corrected interpretation, reason, and optional supporting note.
3. Preview before/after totals and whether an existing export is affected.
4. Confirm; server appends adjustment and audit record. The original remains visible. If the data was exported previously, mark the prior export as potentially superseded and offer a new export.

## 8. Admin flow: export
1. Select CSV or PDF, project/team scope, tutors, date range, timezone, and output grouping.
2. Review displayed rounding policy and calculated preview totals.
3. Generate export; server creates a consistent snapshot, escapes CSV formulas, logs actor/time/filters/timezone/rounding/version, and stores a protected file.
4. Admin downloads via authorized expiring link. Export history supports retrieval and audit; any later adjustment requires a new export/version.

## 9. Settings flow
Authorized admin selects project settings and edits timezone, breaks, rounding, max duration, alert rules, locations/geofence, retention, photo/device controls, and session policies. UI displays impact and privacy notice requirements; sensitive collection is off by default. Save validates combinations, records a before/after audit event, and clearly indicates when a change takes effect. Historical timestamps are not rewritten when timezone changes.

## 10. Exception and recovery flows
| Condition | User-facing behavior | System behavior |
|---|---|---|
| Duplicate tap/retry | One success result; no duplicate confirmation noise | Idempotency returns existing event. |
| Already clocked in / no open session on clock-out | Explain current state and next valid action | Reject invalid transition without event. |
| Offline | Show clear unavailable or Pending sync label | MVP blocks authoritative action; later outbox sync validates and flags conflicts. |
| Missed clock-out | Tutor can request correction; admin sees alert | Do not auto-close unless explicit policy exists. |
| Outside geofence | Explain warn/block policy and fallback | Store minimal location evidence only if enabled; flag review if configured. |
| Permission denied | Explain consequence and alternative | Continue with allowed fallback; do not repeatedly prompt. |
| Correction conflicts with later event | Explain review pending | Version conflict routes to manual review, never silent overwrite. |
| Account deactivated mid-session | Show support/correction route on next access | Preserve session and allow authorized admin resolution. |
| Timezone changes/travel | Show project timezone context | UTC event instants unchanged; render according to explicit report timezone. |
| Schedule changed after punch | Preserve punch and show schedule context/version | Recalculate alerts only under documented policy; audit schedule change. |

## 11. Key screen inventory
1. Tutor sign-in/reset; 2. Tutor clock dashboard; 3. clock confirmation and offline/error states; 4. time history/detail; 5. correction form/status; 6. admin live roster; 7. record timeline; 8. correction decision; 9. adjustment editor; 10. export builder/history; 11. people/location/schedule settings; 12. project policy and audit view.
