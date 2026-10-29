import { useEffect, useState, type FormEvent } from "react";
import { ApiError, get, patch } from "../../api";
import { useSession } from "../../session";
import { ErrorNotice, Field, Loading, useAnnounce, useLoad, useTitle } from "../../components/ui";

interface S {
  breaks: { enabled: boolean; clock_out_while_on_break: "require_end" | "allow_combined"; max_break_minutes: number | null };
  rounding: { mode: "none" | "nearest" | "up" | "down"; increment_minutes: number };
  max_shift_minutes: number;
  confirm_clock_out: boolean;
  require_location: boolean;
  location_controls: { enabled: boolean };
  photo_capture: { enabled: false };
  device_binding: { enabled: false };
  offline_sync: { enabled: false };
  alerts: { long_session: boolean; missed_clock_out: boolean };
  correction_service_target_hours: number;
}
interface Data { name: string; timezone: string; retention_days: number | null; settings: S; version: number; can_edit: boolean; rounding_rule: string }

export default function Settings() {
  useTitle("Settings");
  const { projectId, refresh } = useSession();
  const announce = useAnnounce();
  const { data, error, loading, reload } = useLoad(() => get<Data>(`/v1/admin/projects/${projectId}/settings`), [projectId]);
  const [form, setForm] = useState<Data | null>(null);
  const [reason, setReason] = useState("");
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(data), [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!form) return null;
  const s = form.settings;
  const ro = !form.can_edit;
  const up = (patchS: Partial<S>) => setForm({ ...form, settings: { ...s, ...patchS } });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    try {
      const res = await patch<{ effective: string }>(`/v1/admin/projects/${projectId}/settings`, {
        version: form.version,
        name: form.name,
        timezone: form.timezone,
        retention_days: form.retention_days,
        settings: s,
        reason: reason || undefined,
      });
      announce(`Settings saved. ${res.effective}`);
      setReason("");
      await reload();
      await refresh();
    } catch (err) {
      setSaveError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate style={{ maxWidth: "46rem" }}>
      <div className="page-head">
        <div>
          <h1>Project settings</h1>
          <p className="muted small">Changes apply from now on. Recorded clock times are never rewritten.</p>
        </div>
      </div>
      {ro && <div className="notice"><p>Only project admins can change settings. You can view them here.</p></div>}
      <fieldset disabled={ro}>
        <legend>Project</legend>
        <Field label="Name">{(p) => <input {...p} type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Timezone" hint="An IANA name such as America/Los_Angeles. Used for days, totals and exports." error={saveError?.field("timezone")}>
          {(p) => <input {...p} type="text" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />}
        </Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Breaks</legend>
        <label className="check"><input type="checkbox" checked={s.breaks.enabled} onChange={(e) => up({ breaks: { ...s.breaks, enabled: e.target.checked } })} /> Tutors record breaks</label>
        {s.breaks.enabled && (
          <>
            <Field label="Clocking out while on a break">
              {(p) => (
                <select {...p} value={s.breaks.clock_out_while_on_break} onChange={(e) => up({ breaks: { ...s.breaks, clock_out_while_on_break: e.target.value as S["breaks"]["clock_out_while_on_break"] } })}>
                  <option value="require_end">Tutor must end the break first</option>
                  <option value="allow_combined">Offer "End break and clock out" (records both)</option>
                </select>
              )}
            </Field>
            <Field label="Flag breaks longer than (minutes)" hint="Leave empty to never flag.">
              {(p) => <input {...p} type="number" min={1} value={s.breaks.max_break_minutes ?? ""} onChange={(e) => up({ breaks: { ...s.breaks, max_break_minutes: e.target.value ? Number(e.target.value) : null } })} />}
            </Field>
          </>
        )}
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Sessions and payroll</legend>
        <Field label="Flag sessions longer than (minutes)" hint="Long sessions are flagged for review; they are never closed automatically." error={saveError?.field("settings.max_shift_minutes")}>
          {(p) => <input {...p} type="number" min={15} value={s.max_shift_minutes} onChange={(e) => up({ max_shift_minutes: Number(e.target.value) })} />}
        </Field>
        <Field label="Rounding for exports" hint="Exact time is the default. Check rounding rules with payroll and legal before turning this on.">
          {(p) => (
            <select {...p} value={s.rounding.mode} onChange={(e) => up({ rounding: { ...s.rounding, mode: e.target.value as S["rounding"]["mode"] } })}>
              <option value="none">Exact, no rounding</option>
              <option value="nearest">Nearest increment</option>
              <option value="up">Always up</option>
              <option value="down">Always down</option>
            </select>
          )}
        </Field>
        {s.rounding.mode !== "none" && (
          <Field label="Increment">
            {(p) => (
              <select {...p} value={s.rounding.increment_minutes} onChange={(e) => up({ rounding: { ...s.rounding, increment_minutes: Number(e.target.value) } })}>
                {[1, 5, 6, 10, 15].map((n) => <option key={n} value={n}>{n} minutes</option>)}
              </select>
            )}
          </Field>
        )}
        <label className="check"><input type="checkbox" checked={s.confirm_clock_out} onChange={(e) => up({ confirm_clock_out: e.target.checked })} /> Ask tutors to confirm before clocking out</label>
        <Field label="Correction review target (hours)">
          {(p) => <input {...p} type="number" min={1} value={s.correction_service_target_hours} onChange={(e) => up({ correction_service_target_hours: Number(e.target.value) })} />}
        </Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Alerts for supervisors</legend>
        <label className="check"><input type="checkbox" checked={s.alerts.long_session} onChange={(e) => up({ alerts: { ...s.alerts, long_session: e.target.checked } })} /> Session runs past the limit</label>
        <label className="check"><input type="checkbox" checked={s.alerts.missed_clock_out} onChange={(e) => up({ alerts: { ...s.alerts, missed_clock_out: e.target.checked } })} /> Session left open from a previous day</label>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Location and privacy</legend>
        <p className="small">Sensitive collection is off by default. Turn on location checks only after a privacy review and after telling tutors why it's needed.</p>
        <label className="check"><input type="checkbox" checked={s.require_location} onChange={(e) => up({ require_location: e.target.checked })} /> Tutors choose a work location at clock-in</label>
        <label className="check"><input type="checkbox" checked={s.location_controls.enabled} onChange={(e) => up({ location_controls: { enabled: e.target.checked } })} /> Allow position checks at clock-in for locations with a geofence</label>
        <p className="small muted">Photo capture, device binding and offline clocking are not available in this release.</p>
        <Field label="Keep records for (days)" hint="Leave empty until your retention policy is agreed. Nothing is deleted automatically in this release.">
          {(p) => <input {...p} type="number" min={30} value={form.retention_days ?? ""} onChange={(e) => setForm({ ...form, retention_days: e.target.value ? Number(e.target.value) : null })} />}
        </Field>
      </fieldset>
      {!ro && (
        <>
          <Field label="Reason for change (optional)" hint="Saved in the audit log with the before and after values.">
            {(p) => <input {...p} type="text" value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <ErrorNotice error={saveError} />
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
        </>
      )}
    </form>
  );
}
