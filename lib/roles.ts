/** Everyone is a member. Roles are extra hats — a member can hold any combination. */
export const ROLES = [
  { key: "teacher", label: "Teacher", hint: "can be set as a slot's teacher" },
  { key: "crew", label: "Crew", hint: "prepares and runs activities" },
  { key: "treasurer", label: "Treasurer", hint: "payments and the bank statement" },
  { key: "manager", label: "Manager", hint: "runs the inbox — messages, mail, tasks" },
  { key: "admin", label: "Admin", hint: "admin board and settings" },
] as const;

export type Role = (typeof ROLES)[number]["key"];

type Roled = { roles?: string[] | null; inbox_access?: boolean | null } | null | undefined;

export function hasRole(m: Roled, role: Role): boolean {
  return !!m?.roles?.includes(role);
}

/** Keep only known roles, in the fixed order above. */
export function cleanRoles(values: unknown[]): Role[] {
  const picked = new Set(values.map(String));
  return ROLES.map((r) => r.key).filter((k) => picked.has(k));
}

export function roleLabels(roles?: string[] | null): string {
  const names = ROLES.filter((r) => roles?.includes(r.key)).map((r) => r.label);
  return names.length ? names.join(" · ") : "Member";
}

/** The calendar (tab, pages, phone feed) is for Crew and Admin only. */
export function canUseCalendar(m: Roled): boolean {
  return hasRole(m, "crew") || hasRole(m, "admin");
}

/** The Payments tab (bank statement, confirmations) is for the Treasurer and Admin. */
export function canUsePayments(m: Roled): boolean {
  return hasRole(m, "treasurer") || hasRole(m, "admin");
}

/** The Inbox tab (Instagram DMs, association mail, tasks) is for Admin, Manager, and Crew with inbox access. (v19) */
export function canUseInbox(m: Roled): boolean {
  return hasRole(m, "admin") || hasRole(m, "manager") || (hasRole(m, "crew") && !!m?.inbox_access);
}
