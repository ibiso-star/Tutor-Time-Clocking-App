import { useState, type FormEvent } from "react";
import { ApiError, get, patch, post, qs } from "../../api";
import { useSession } from "../../session";
import { dateTime, localInputToIso, time } from "../../format";
import { Dialog, ErrorNotice, Field, Loading, useAnnounce, useLoad, useTitle } from "../../components/ui";

interface Loc { id: string; name: string; address: string | null; latitude: string | null; longitude: string | null; geofence_radius_m: number | null; geofence_mode: "off" | "warn" | "block"; active: boolean }

export default function Schedule() {
  useTitle("Locations and shifts");
  const { projectId, tz } = useSession();
  const announce = useAnnounce();
  const locs = useLoad(() => get<{ locations: Loc[]; location_controls_enabled: boolean; can_edit: boolean }>(`/v1/admin/locations${qs({ project_id: projectId })}`), [projectId]);
  const shifts = useLoad(() => get<{ shifts: any[] }>(`/v1/admin/shifts${qs({ project_id: projectId })}`), [projectId]);
  const people = useLoad(() => get(`/v1/admin/people${qs({ project_id: projectId })}`), [projectId]);
  const [editLoc, setEditLoc] = useState<Loc | "new" | null>(null);
  const [addShift, setAddShift] = useState(false);
  const cancel = async (s: any) => {
    const reason = window.prompt("Reason for cancelling this shift?");
    if (!reason) return;
    try {
      await post(`/v1/admin/shifts/${s.id}/cancel`, { version: s.version, reason });
      announce("Shift cancelled.");
      void shifts.reload();
    } catch (e) {
      window.alert((e as ApiError).message);
    }
  };
  return (
    <div className="stack">
      <div className="page-head"><h1>Locations and shifts</h1></div>
      <section className="panel" aria-labelledby="locs">
        <div className="section-head">
          <h2 id="locs">Work locations</h2>
          {locs.data?.can_edit && <button className="btn" onClick={() => setEditLoc("new")}>Add location</button>}
        </div>
        {locs.data && !locs.data.location_controls_enabled && <p className="small muted">Location checks are off for this project, so no coordinates are stored or used.</p>}
        <ErrorNotice error={locs.error} onRetry={locs.reload} />
        {!locs.data ? <Loading /> : locs.data.locations.length === 0 ? <p className="empty">No locations yet.</p> : (
          <table className="data stack-sm">
            <thead><tr><th scope="col">Name</th><th scope="col">Address</th><th scope="col">Location check</th><th scope="col">Status</th>{locs.data.can_edit && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
            <tbody>
              {locs.data.locations.map((l) => (
                <tr key={l.id}>
                  <td data-label="Name">{l.name}</td>
                  <td data-label="Address">{l.address ?? "—"}</td>
                  <td data-label="Location check">{l.geofence_mode === "off" ? "Off" : `${l.geofence_mode === "warn" ? "Warn" : "Block"} outside ${l.geofence_radius_m} m`}</td>
                  <td data-label="Status">{l.active ? "Active" : "Inactive"}</td>
                  {locs.data!.can_edit && <td data-label=""><button className="btn" onClick={() => setEditLoc(l)}>Edit</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="shifts">
        <div className="section-head">
          <h2 id="shifts">Upcoming shifts</h2>
          <button className="btn" onClick={() => setAddShift(true)}>Add shift</button>
        </div>
        <ErrorNotice error={shifts.error} onRetry={shifts.reload} />
        {!shifts.data ? <Loading /> : shifts.data.shifts.length === 0 ? <p className="empty">No shifts scheduled.</p> : (
          <table className="data stack-sm">
            <thead><tr><th scope="col">When</th><th scope="col">Shift</th><th scope="col">Tutor</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {shifts.data.shifts.map((s) => (
                <tr key={s.id}>
                  <td data-label="When">{dateTime(s.scheduled_start, tz)} to {time(s.scheduled_end, tz)}</td>
                  <td data-label="Shift">{s.label}</td>
                  <td data-label="Tutor">{s.tutor_name ?? "Open"}</td>
                  <td data-label="Location">{s.location_name ?? "—"}</td>
                  <td data-label="Status">{s.status}</td>
                  <td data-label="">{s.status === "scheduled" && <button className="btn btn-quiet" onClick={() => void cancel(s)}>Cancel shift</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Dialog open={editLoc !== null} onClose={() => setEditLoc(null)} title={editLoc === "new" ? "Add location" : "Edit location"}>
        {editLoc !== null && locs.data && <LocationForm loc={editLoc === "new" ? null : editLoc} controls={locs.data.location_controls_enabled} onDone={() => { setEditLoc(null); void locs.reload(); }} onCancel={() => setEditLoc(null)} />}
      </Dialog>
      <Dialog open={addShift} onClose={() => setAddShift(false)} title="Add shift">
        {addShift && <ShiftForm tutors={(people.data?.people ?? []).filter((p: any) => p.role === "tutor" && !p.active_to)} locations={locs.data?.locations.filter((l) => l.active) ?? []} onDone={() => { setAddShift(false); void shifts.reload(); }} onCancel={() => setAddShift(false)} />}
      </Dialog>
    </div>
  );
}

function LocationForm({ loc, controls, onDone, onCancel }: { loc: Loc | null; controls: boolean; onDone: () => void; onCancel: () => void }) {
  const { projectId } = useSession();
  const [f, setF] = useState({
    name: loc?.name ?? "",
    address: loc?.address ?? "",
    latitude: loc?.latitude ?? "",
    longitude: loc?.longitude ?? "",
    geofence_radius_m: loc?.geofence_radius_m ? String(loc.geofence_radius_m) : "",
    geofence_mode: loc?.geofence_mode ?? "off",
    active: loc?.active ?? true,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const num = (v: string) => (v === "" ? null : Number(v));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = { name: f.name, address: f.address || null, latitude: num(String(f.latitude)), longitude: num(String(f.longitude)), geofence_radius_m: num(f.geofence_radius_m), geofence_mode: f.geofence_mode, active: f.active };
    try {
      if (loc) await patch(`/v1/admin/locations/${loc.id}`, body);
      else await post("/v1/admin/locations", { project_id: projectId, ...body });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={submit} noValidate>
      <Field label="Name" error={error?.field("name")}>{(p) => <input {...p} type="text" value={f.name} onChange={set("name")} />}</Field>
      <Field label="Address (optional)">{(p) => <input {...p} type="text" value={f.address} onChange={set("address")} />}</Field>
      {controls ? (
        <fieldset>
          <legend>Location check at clock-in</legend>
          <Field label="Mode">
            {(p) => (
              <select {...p} value={f.geofence_mode} onChange={set("geofence_mode")}>
                <option value="off">Off</option>
                <option value="warn">Warn and flag for review if outside</option>
                <option value="block">Block clock-in if outside</option>
              </select>
            )}
          </Field>
          {f.geofence_mode !== "off" && (
            <>
              <Field label="Latitude">{(p) => <input {...p} type="number" step="any" value={f.latitude} onChange={set("latitude")} />}</Field>
              <Field label="Longitude">{(p) => <input {...p} type="number" step="any" value={f.longitude} onChange={set("longitude")} />}</Field>
              <Field label="Radius in metres">{(p) => <input {...p} type="number" min={25} value={f.geofence_radius_m} onChange={set("geofence_radius_m")} />}</Field>
            </>
          )}
        </fieldset>
      ) : (
        <p className="small muted">To check position at clock-in, first enable location controls in Settings after a privacy review.</p>
      )}
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Available for clock-in</label>
      {error && !error.details?.fields && <ErrorNotice error={error} />}
      <div className="btn-row">
        <button className="btn btn-primary" type="submit">Save location</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ShiftForm({ tutors, locations, onDone, onCancel }: { tutors: any[]; locations: Loc[]; onDone: () => void; onCancel: () => void }) {
  const { projectId, tz } = useSession();
  const [f, setF] = useState({ label: "", tutor_id: "", location_id: "", start: "", end: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!f.start || !f.end) return setError(new ApiError(400, "VALIDATION_ERROR", "Enter a start and end time."));
    try {
      await post("/v1/admin/shifts", { project_id: projectId, label: f.label, tutor_id: f.tutor_id || null, location_id: f.location_id || null, scheduled_start: localInputToIso(f.start, tz), scheduled_end: localInputToIso(f.end, tz) });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={submit} noValidate>
      <Field label="Shift name" error={error?.field("label")}>{(p) => <input {...p} type="text" value={f.label} onChange={set("label")} placeholder="Afternoon study hall" />}</Field>
      <Field label="Tutor">{(p) => <select {...p} value={f.tutor_id} onChange={set("tutor_id")}><option value="">Unassigned</option>{tutors.map((t) => <option key={t.user_id} value={t.user_id}>{t.display_name}</option>)}</select>}</Field>
      <Field label="Location">{(p) => <select {...p} value={f.location_id} onChange={set("location_id")}><option value="">None</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}</Field>
      <Field label={`Starts (${tz})`}>{(p) => <input {...p} type="datetime-local" value={f.start} onChange={set("start")} />}</Field>
      <Field label={`Ends (${tz})`}>{(p) => <input {...p} type="datetime-local" value={f.end} onChange={set("end")} />}</Field>
      {error && !error.details?.fields && <ErrorNotice error={error} />}
      <div className="btn-row">
        <button className="btn btn-primary" type="submit">Add shift</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
