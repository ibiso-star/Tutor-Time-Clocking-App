import type { State, EventType } from "./domain.js";

export interface EventRow {
  seq: string;
  id: string;
  employee_id: string;
  external_ref: string | null;
  display_name: string;
  session_id: string;
  event_type: EventType;
  occurred_at: Date;
  state_after: State;
  source: "link" | "kiosk" | "api";
  kiosk_id: string | null;
  client_time: Date | null;
}

export const EVENT_SELECT = `
  SELECT e.seq, e.id, e.employee_id, emp.external_ref, emp.display_name, e.session_id, e.event_type,
         e.occurred_at, e.state_after, e.source, e.kiosk_id, e.client_time
    FROM shift.events e JOIN shift.employees emp ON emp.id = e.employee_id`;

/** Public event contract (REST feed and webhook `data`). Keep backwards compatible; bump schema_version on breaks. */
export function toEventDto(r: EventRow) {
  return {
    id: r.id,
    seq: Number(r.seq),
    type: r.event_type,
    occurred_at: r.occurred_at.toISOString(),
    employee: { id: r.employee_id, external_ref: r.external_ref, display_name: r.display_name },
    session_id: r.session_id,
    source: r.source,
    kiosk_id: r.kiosk_id,
    state_after: r.state_after,
    client_time: r.client_time?.toISOString() ?? null,
  };
}
export type EventDto = ReturnType<typeof toEventDto>;
