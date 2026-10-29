import { useState, type FormEvent } from "react";
import { ApiError, post } from "../api";
import { useSession } from "../session";
import { tzShort } from "../format";
import { ErrorNotice, Field, useAnnounce, useTitle } from "../components/ui";

export default function Profile() {
  useTitle("Profile");
  const { me, membership, selectProject, signOut } = useSession();
  const announce = useAnnounce();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me || !membership) return null;
  const change = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/v1/auth/change-password", { current_password: current, new_password: next });
      setCurrent("");
      setNext("");
      announce("Password changed. Other devices have been signed out.");
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <h1>Profile</h1>
      <div className="panel">
        <p style={{ margin: 0, fontWeight: 700 }}>{me.user.display_name}</p>
        <p className="muted" style={{ margin: 0 }}>{me.user.email}</p>
        <p className="small muted" style={{ margin: "0.5rem 0 0" }}>
          {membership.project.name}, {membership.role}
          {membership.team ? `, ${membership.team}` : ""}. Times are shown in {membership.project.timezone} ({tzShort(membership.project.timezone)}).
        </p>
      </div>
      {me.memberships.length > 1 && (
        <Field label="Project">
          {(p) => (
            <select {...p} value={membership.project.id} onChange={(e) => selectProject(e.target.value)}>
              {me.memberships.map((m) => (
                <option key={m.project.id} value={m.project.id}>
                  {m.project.name} ({m.role})
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <section className="panel" aria-labelledby="privacy">
        <h2 id="privacy">What this app records</h2>
        <p className="small">
          The server records the time of each clock-in, break and clock-out. Your device's own clock is never used as the official time. Location is only
          checked at clock-in if your project requires it, and is never tracked continuously. No photos or device fingerprints are collected.
        </p>
      </section>
      <form className="panel" onSubmit={change} noValidate>
        <h2>Change password</h2>
        <Field label="Current password">{(p) => <input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="New password" hint="At least 10 characters.">
          {(p) => <input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <ErrorNotice error={error} />
        <button className="btn" type="submit" disabled={busy || !current || !next}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
      <button className="btn btn-danger" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
