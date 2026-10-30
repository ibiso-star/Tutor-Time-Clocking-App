import { useState, type FormEvent } from "react";
import { ApiError, get, patch, post, qs } from "../../api";
import { useSession } from "../../session";
import { Dialog, ErrorNotice, Field, Loading, useAnnounce, useLoad, useTitle } from "../../components/ui";

interface Person {
  membership_id: string;
  user_id: string;
  display_name: string;
  email: string;
  role: string;
  team_id: string | null;
  team_name: string | null;
  status: string;
  employee_code: string | null;
  active_to: string | null;
  has_open_session: boolean;
}

export default function People() {
  useTitle("People");
  const { projectId } = useSession();
  const { data, error, loading, reload } = useLoad(() => get<{ people: Person[]; teams: { id: string; name: string }[]; can_edit: boolean }>(`/v1/admin/people${qs({ project_id: projectId })}`), [projectId]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div>
      <div className="page-head">
        <h1>People</h1>
        {data.can_edit && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add person</button>}
      </div>
      <div className="table-wrap">
        <table className="data stack-sm">
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Team</th><th scope="col">Employee code</th><th scope="col">Account</th>{data.can_edit && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.membership_id} style={p.active_to ? { opacity: 0.6 } : undefined}>
                <td data-label="Name">{p.display_name}<div className="small muted">{p.email}</div></td>
                <td data-label="Role">{p.role}</td>
                <td data-label="Team">{p.team_name ?? "—"}</td>
                <td data-label="Employee code">{p.employee_code ?? "—"}</td>
                <td data-label="Account">
                  {p.active_to ? "Removed from project" : p.status === "invited" ? "Invite sent" : p.status}
                  {p.has_open_session && <div className="small">Has an open session</div>}
                </td>
                {data.can_edit && <td data-label="">{!p.active_to && <button className="btn" onClick={() => setEditing(p)}>Edit</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a person">
        {adding && <AddPerson teams={data.teams} onDone={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} />}
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.display_name}` : ""}>
        {editing && <EditPerson person={editing} teams={data.teams} onDone={() => { setEditing(null); void reload(); }} onCancel={() => setEditing(null)} />}
      </Dialog>
    </div>
  );
}

function AddPerson({ teams, onDone, onCancel }: { teams: { id: string; name: string }[]; onDone: () => void; onCancel: () => void }) {
  const { projectId } = useSession();
  const announce = useAnnounce();
  const [f, setF] = useState({ display_name: "", email: "", role: "tutor", team_id: "", employee_code: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await post("/v1/admin/people", { project_id: projectId, ...f, team_id: f.team_id || null, employee_code: f.employee_code || null });
      announce(
        !res.invited ? `${f.display_name} added.`
        : res.email_sent === false ? `${f.display_name} added, but the invite email couldn't be sent. They can use "Forgot password" on the sign-in page to set a password.`
        : `Invite sent to ${f.email}.`,
      );
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={submit} noValidate>
      <Field label="Full name" error={error?.field("display_name")}>{(p) => <input {...p} type="text" value={f.display_name} onChange={set("display_name")} />}</Field>
      <Field label="Email" hint="They'll get a link to set their password." error={error?.field("email")}>{(p) => <input {...p} type="email" value={f.email} onChange={set("email")} />}</Field>
      <Field label="Role">
        {(p) => (
          <select {...p} value={f.role} onChange={set("role")}>
            <option value="tutor">Tutor: records their own time</option>
            <option value="supervisor">Supervisor: reviews their team</option>
            <option value="admin">Admin: manages the project</option>
          </select>
        )}
      </Field>
      <Field label="Team" hint="Supervisors with a team only see tutors in that team.">
        {(p) => (
          <select {...p} value={f.team_id} onChange={set("team_id")}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </Field>
      <Field label="Employee code (optional)">{(p) => <input {...p} type="text" value={f.employee_code} onChange={set("employee_code")} />}</Field>
      {error && !error.details?.fields && <ErrorNotice error={error} />}
      <div className="btn-row">
        <button className="btn btn-primary" type="submit">Add person</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function EditPerson({ person, teams, onDone, onCancel }: { person: Person; teams: { id: string; name: string }[]; onDone: () => void; onCancel: () => void }) {
  const announce = useAnnounce();
  const [role, setRole] = useState(person.role);
  const [team, setTeam] = useState(person.team_id ?? "");
  const [code, setCode] = useState(person.employee_code ?? "");
  const [remove, setRemove] = useState<"" | "membership" | "account">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await patch(`/v1/admin/memberships/${person.membership_id}`, {
        role,
        team_id: team || null,
        employee_code: code || null,
        end_membership: remove === "membership" || remove === "account",
        deactivate_account: remove === "account",
        reason,
      });
      announce("Changes saved.");
      onDone();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <form onSubmit={submit} noValidate>
      <Field label="Role">
        {(p) => (
          <select {...p} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="tutor">Tutor</option>
            <option value="supervisor">Supervisor</option>
            <option value="admin">Admin</option>
          </select>
        )}
      </Field>
      <Field label="Team">
        {(p) => (
          <select {...p} value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </Field>
      <Field label="Employee code">{(p) => <input {...p} type="text" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
      <fieldset>
        <legend>Access</legend>
        <label className="check"><input type="radio" name="rm" checked={remove === ""} onChange={() => setRemove("")} /> Keep access</label>
        <label className="check"><input type="radio" name="rm" checked={remove === "membership"} onChange={() => setRemove("membership")} /> Remove from this project</label>
        <label className="check"><input type="radio" name="rm" checked={remove === "account"} onChange={() => setRemove("account")} /> Deactivate account and sign out everywhere</label>
        {remove && <p className="small muted">Time records are kept. {person.has_open_session ? "Their open session stays visible so you can record a clock-out time." : ""}</p>}
      </fieldset>
      <Field label="Reason" hint="Required. Recorded in the audit log." error={error?.field("reason")}>{(p) => <textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      {error && !error.details?.fields && <ErrorNotice error={error} />}
      <div className="btn-row">
        <button className={`btn ${remove ? "btn-danger" : "btn-primary"}`} type="submit">{remove ? "Save and remove access" : "Save changes"}</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
