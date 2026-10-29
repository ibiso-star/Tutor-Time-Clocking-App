import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { isReviewer, useSession } from "./session";
import { ForgotPassword, Login, ResetPassword } from "./pages/Auth";
import { AdminShell, TutorShell } from "./Shells";
import { Loading } from "./components/ui";
import TutorHome from "./pages/tutor/Home";
import History from "./pages/tutor/History";
import SessionDetail from "./pages/tutor/SessionDetail";
import Requests from "./pages/tutor/Requests";
import Profile from "./pages/Profile";

// Admin screens are split out so tutors on phones never download them.
const Roster = lazy(() => import("./pages/admin/Roster"));
const Entries = lazy(() => import("./pages/admin/Entries"));
const AdminSession = lazy(() => import("./pages/admin/AdminSession"));
const Corrections = lazy(() => import("./pages/admin/Corrections"));
const Exports = lazy(() => import("./pages/admin/Exports"));
const People = lazy(() => import("./pages/admin/People"));
const Schedule = lazy(() => import("./pages/admin/Schedule"));
const Settings = lazy(() => import("./pages/admin/Settings"));
const Audit = lazy(() => import("./pages/admin/Audit"));

export default function App() {
  const { me, loading, membership } = useSession();
  if (loading) return <main className="auth"><Loading label="Starting" /></main>;
  if (!me) {
    return (
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  if (!membership) {
    return (
      <main className="auth">
        <div className="auth-card notice">
          <p>Your account isn't assigned to a project yet. Ask your supervisor to add you, then sign in again.</p>
        </div>
      </main>
    );
  }
  if (isReviewer(membership.role)) {
    return (
      <Suspense fallback={<main className="admin-main"><Loading /></main>}>
        <Routes>
          <Route path="/admin" element={<AdminShell />}>
            <Route index element={<Roster />} />
            <Route path="entries" element={<Entries />} />
            <Route path="sessions/:id" element={<AdminSession />} />
            <Route path="corrections" element={<Corrections />} />
            <Route path="exports" element={<Exports />} />
            <Route path="people" element={<People />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="settings" element={<Settings />} />
            <Route path="audit" element={<Audit />} />
            <Route path="profile" element={<Profile />} />
          </Route>
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Suspense>
    );
  }
  return (
    <Routes>
      <Route element={<TutorShell />}>
        <Route index element={<TutorHome />} />
        <Route path="history" element={<History />} />
        <Route path="history/:id" element={<SessionDetail />} />
        <Route path="requests" element={<Requests />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
