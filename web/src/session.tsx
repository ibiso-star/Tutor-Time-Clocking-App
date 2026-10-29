import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, get, post, setCsrf } from "./api";

export type Role = "tutor" | "supervisor" | "admin";
export interface Membership {
  project: { id: string; name: string; timezone: string; rounding_rule: string };
  role: Role;
  team: string | null;
}
export interface Me {
  user: { id: string; email: string; display_name: string; is_system_admin: boolean };
  memberships: Membership[];
  csrf_token: string;
  server_time: string;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  membership: Membership | null;
  projectId: string | null;
  tz: string;
  selectProject: (id: string) => void;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);
const STORE_KEY = "ttc.project";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}
function writeStored(v: string | null) {
  try {
    if (v) localStorage.setItem(STORE_KEY, v);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable: selection just won't persist */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(readStored());

  const refresh = useCallback(async () => {
    try {
      const data = await get<Me>("/v1/me");
      setCsrf(data.csrf_token);
      setMe(data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setCsrf(null);
        setMe(null);
      } else throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  const membership = useMemo(() => {
    if (!me || me.memberships.length === 0) return null;
    return me.memberships.find((m) => m.project.id === projectId) ?? me.memberships[0]!;
  }, [me, projectId]);

  const value: SessionValue = {
    me,
    loading,
    membership,
    projectId: membership?.project.id ?? null,
    tz: membership?.project.timezone ?? "UTC",
    selectProject: (id) => {
      setProjectId(id);
      writeStored(id);
    },
    refresh,
    signIn: async (email, password) => {
      const res = await post<{ csrf_token: string }>("/v1/auth/login", { email, password });
      setCsrf(res.csrf_token);
      await refresh();
    },
    signOut: async () => {
      try {
        await post("/v1/auth/logout");
      } finally {
        setCsrf(null);
        setMe(null);
        writeStored(null);
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

export const isReviewer = (role: Role | undefined) => role === "supervisor" || role === "admin";
