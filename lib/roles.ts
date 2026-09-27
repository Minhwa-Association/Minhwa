/** Everyone is a member. Roles are extra hats — a member can hold any combination. */
export const ROLES = [
  { key: "teacher", label: "Teacher", hint: "can be set as a slot's teacher" },
  { key: "crew", label: "Crew", hint: "prepares and runs activities" },
  { key: "treasurer", label: "Treasurer", hint: "payments and the bank statement" },
  { key: "admin", label: "Admin", hint: "admin board and settings" },
] as const;

export type Role = (typeof ROLES)[number]["key"];

export function hasRole(m: { roles?: string[] | null } | null | undefined, role: Role): boolean {
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
export function canUseCalendar(m: { roles?: string[] | null } | null | undefined): boolean {
  return hasRole(m, "crew") || hasRole(m, "admin");
}

/** The Payments tab (bank statement, confirmations) is for the Treasurer and Admin. */
export function canUsePayments(m: { roles?: string[] | null } | null | undefined): boolean {
  return hasRole(m, "treasurer") || hasRole(m, "admin");
}
