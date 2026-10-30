import { randomUUID } from "node:crypto";
import type { Db, Tx } from "./db.js";
import { withTransaction } from "./db.js";
import { ApiError } from "./errors.js";
import { transition, type Action, type State } from "./domain.js";
import { EVENT_SELECT, toEventDto, type EventDto, type EventRow } from "./events.js";

export interface PunchInput {
  employeeId: string;
  action: Action;
  endBreak?: boolean;
  idempotencyKey: string;
  clientTime?: string | null;
  source: "link" | "kiosk" | "api";
  kioskId?: string | null;
  ipHash?: string | null;
}

export interface PunchResult {
  event: EventDto;
  state: State;
  replayed: boolean;
  /** Every event this request recorded (two when a break end is implied). Internal; not part of the response. */
  eventIds: string[];
}

/**
 * Records a punch. One transaction: lock the employee row (serializes concurrent taps), replay if the
 * idempotency key was already used, validate the transition, append event(s) with the database clock
 * as official time, update the state projection, and enqueue webhook messages in the outbox.
 */
export async function punch(db: Db, input: PunchInput, webhooksEnabled: boolean): Promise<PunchResult> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ state: State; open_session_id: string | null; active: boolean }>(
      `SELECT state, open_session_id, active FROM shift.employees WHERE id = $1 FOR UPDATE`,
      [input.employeeId],
    );
    const emp = rows[0];
    if (!emp || !emp.active) throw new ApiError(403, "EMPLOYEE_INACTIVE", "This account is not active. Please speak to your manager.");

    const prior = await tx.query<EventRow & { action: string }>(
      `${EVENT_SELECT} WHERE e.employee_id = $1 AND e.idempotency_key = $2 ORDER BY e.seq DESC LIMIT 1`,
      [input.employeeId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      const { rows: a } = await tx.query<{ action: string }>(
        `SELECT action FROM shift.events WHERE employee_id = $1 AND idempotency_key = $2`,
        [input.employeeId, input.idempotencyKey],
      );
      if (a[0]!.action !== input.action) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different action.");
      }
      return { event: toEventDto(prior.rows[0]), state: emp.state, replayed: true, eventIds: [] };
    }

    const t = transition(emp.state, input.action, { endBreak: input.endBreak });
    if (t.ok === false) {
      const rejected = t as Extract<typeof t, { ok: false }>;
      throw new ApiError(409, rejected.code, rejected.message);
    }

    const { rows: clock } = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock[0]!.now;
    const sessionId = emp.open_session_id ?? randomUUID();
    const clientTime = input.clientTime && !Number.isNaN(Date.parse(input.clientTime)) ? new Date(input.clientTime) : null;

    const ids: string[] = [];
    for (const [i, ev] of t.events.entries()) {
      const isLast = i === t.events.length - 1;
      // An implied break end gets its own derived key so the main key still identifies the request.
      const key = isLast ? input.idempotencyKey : randomUUID();
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO shift.events (employee_id, session_id, event_type, occurred_at, state_after, source, kiosk_id,
                                   idempotency_key, action, client_time, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [input.employeeId, sessionId, ev.type, now, ev.stateAfter, input.source, input.kioskId ?? null, key,
         isLast ? input.action : `${input.action}:implied`, clientTime, input.ipHash ?? null],
      );
      ids.push(ins.rows[0]!.id);
      if (webhooksEnabled) await enqueueWebhook(tx, ins.rows[0]!.id);
    }

    const finalState = t.events[t.events.length - 1]!.stateAfter;
    await tx.query(
      `UPDATE shift.employees SET state = $2, state_since = $3, open_session_id = $4, updated_at = $3 WHERE id = $1`,
      [input.employeeId, finalState, now, finalState === "OUT" ? null : sessionId],
    );
    const { rows: out } = await tx.query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [ids[ids.length - 1]]);
    return { event: toEventDto(out[0]!), state: finalState, replayed: false, eventIds: ids };
  });
}

async function enqueueWebhook(tx: Tx, eventId: string): Promise<void> {
  const { rows } = await tx.query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [eventId]);
  const data = toEventDto(rows[0]!);
  const payload = { type: `shift.${data.type}`, schema_version: 1, timestamp: data.occurred_at, data };
  await tx.query(`INSERT INTO shift.webhook_outbox (event_id, payload) VALUES ($1, $2)`, [eventId, JSON.stringify(payload)]);
}
