import { cookies } from "next/headers";

export interface SessionUser {
  userId: string;
  name: string;
  role: "admin" | "manager";
  department: "b2g" | "b2b";
  telegramUsername: string;
  line: string | null;
  kommoUserId: number | null;
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get("sm_session")?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SessionUser;
    if (!parsed.userId || !parsed.name || !parsed.role || !parsed.department) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
