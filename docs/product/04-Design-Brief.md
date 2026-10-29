# Design Brief

## Product
**Vibe Amplified Tutor Time Clock** — mobile-first web app for trusted work-time capture and straightforward administrative review.

## Design intent
The interface should feel dependable, calm, and fast—not like surveillance software. Prioritize one obvious next action, readable status, immediate feedback, and transparent handling of uncertain/offline data. Tutor workflows should be optimized for one-handed mobile use; admin workflows should favor scannable tables and investigation detail.

## Audiences and contexts
Tutors typically interact briefly at session start/end, often on a phone and potentially in a distracting environment. Supervisors review concurrent status and exceptions, often on desktop/tablet. System administrators configure policies less frequently and need explanatory guardrails.

## Information hierarchy
### Tutor home
1. Current state label and icon/text treatment.
2. Primary state-specific action: Clock In, Clock Out, Start Break, End Break.
3. Live elapsed timer or today’s total.
4. Assigned shift/location context and policy notices.
5. Recent entries and correction-request status.

### Admin dashboard
1. Roster totals and actionable alerts.
2. Search/filter controls.
3. Tutor rows with status, start time, duration, location/session if collected.
4. Detail timeline and audit context on selection.

## Interaction principles
- Make routine clock actions available immediately; target two taps after login when no selection is required.
- Use large touch targets (minimum 44×44 CSS px), avoid destructive or ambiguous action labels, and prevent double submission while pending.
- Confirm successful actions with the exact server-recorded time and resulting state.
- Distinguish **Accepted**, **Pending sync**, **Needs review**, and **Rejected** with text and iconography—not color alone.
- Keep correction and admin adjustment language neutral; show original and adjusted values side by side.
- Ask permission just in time, disclose why, and explain a useful fallback when denied.
- Avoid dark patterns: no hidden GPS/photo collection, no persistent location tracking, no misleading precision.

## Visual direction
Use a restrained, high-contrast palette with one strong primary action color and neutral surfaces. Status colors may supplement—not replace—labels and icons. Typography should be highly legible on small screens; use tabular numerals for elapsed time and financial/payroll totals. Use clear spacing, few competing cards, and stable placement for the main control. Avoid decorative animations that delay action; a subtle live timer is sufficient.

## Accessibility requirements
Target WCAG 2.2 AA. Provide semantic headings, labels and landmarks; visible keyboard focus; logical tab order; screen-reader announcements for state/action results; reduced-motion support; accessible error associations; sufficient contrast; scalable text; and status not communicated by color alone. Timer updates must not be announced every second; announce only meaningful state changes. Ensure dialogs and menus are keyboard operable and return focus appropriately.

## Responsive behavior
Tutor home should work at narrow mobile widths without horizontal scrolling and preserve the primary button in the first viewport where practical. Admin table may become stacked cards on narrow screens while preserving key fields and accessible filters. Forms should use mobile-friendly inputs and retain entered values after validation errors.

## Required states and content
Design normal, loading, success, validation error, server error, offline, pending sync, conflict, permission denied, empty history, no assigned shift, long-session alert, correction pending/approved/rejected, and export-processing states. Copy should state what happened, what is official, and what the user can do next. Avoid implying that a local timestamp is authoritative.

## Content examples
- Clocked Out — “Ready to start your shift?”
- Pending sync — “This punch is saved on this device and has not been accepted by the server.”
- Outside location — “You appear to be outside the approved area. Try again at the work location or request a review.”
- Correction submitted — “Your request is pending review. Your original time record has not changed.”

## Prototype deliverables
Clickable mobile tutor flow covering clock-in, break, clock-out, history and correction request; desktop admin flow covering live roster, record timeline, correction decision, manual adjustment and export; annotated permission/offline/error states; responsive variants; component/token guidance; accessibility review checklist.

## Design questions to resolve
Confirm brand assets and tone, preferred status palette, whether assigned shift selection is mandatory, whether location is shown to tutors/admins, which admin actions need second-person review, and required localization/language support.
