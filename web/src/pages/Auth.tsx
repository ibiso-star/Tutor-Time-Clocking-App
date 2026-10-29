import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, post } from "../api";
import { useSession } from "../session";
import { ErrorNotice, Field, useTitle } from "../components/ui";
import { IconClock } from "../components/icons";

function Mark() {
  return (
    <div className="auth-mark">
      <IconClock size={28} />
      Tutor Time Clock
    </div>
  );
}

export function Login() {
  useTitle("Sign in");
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  };
  return (
    <main className="auth">
      <div className="auth-card">
        <Mark />
        <h1>Sign in</h1>
        <form onSubmit={submit} noValidate className="panel">
          <Field label="Email" error={error?.field("email")}>
            {(p) => <input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
          </Field>
          <Field label="Password" error={error?.field("password")}>
            {(p) => <input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
          </Field>
          {error && !error.details?.fields && <ErrorNotice error={error} />}
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p style={{ marginTop: "1rem" }}>
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
      </div>
    </main>
  );
}

export function ForgotPassword() {
  useTitle("Reset password");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await post<{ message: string }>("/v1/auth/password-reset/request", { email });
      setSent(res.message);
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <main className="auth">
      <div className="auth-card">
        <Mark />
        <h1>Reset your password</h1>
        {sent ? (
          <div className="notice notice-ok" role="status">
            <p>{sent}</p>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="panel">
            <Field label="Email" hint="We'll email you a link that works for 30 minutes." error={error?.field("email")}>
              {(p) => <input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            {error && !error.details?.fields && <ErrorNotice error={error} />}
            <button className="btn btn-primary" type="submit">
              Send reset link
            </button>
          </form>
        )}
        <p style={{ marginTop: "1rem" }}>
          <Link to="/">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}

export function ResetPassword() {
  useTitle("Set a new password");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await post("/v1/auth/password-reset/confirm", { token: params.get("token") ?? "", password });
      setDone(true);
      window.setTimeout(() => navigate("/"), 2500);
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <main className="auth">
      <div className="auth-card">
        <Mark />
        <h1>Set a new password</h1>
        {done ? (
          <div className="notice notice-ok" role="status">
            <p>Password set. Taking you to sign in.</p>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="panel">
            <Field label="New password" hint="At least 10 characters.">
              {(p) => <input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
            </Field>
            <ErrorNotice error={error} />
            <button className="btn btn-primary" type="submit">
              Set password
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
