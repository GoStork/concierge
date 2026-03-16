export const PROVIDER_ROLES = [
  "PROVIDER_ADMIN",
  "SURROGACY_COORDINATOR",
  "EGG_DONOR_COORDINATOR",
  "SPERM_DONOR_COORDINATOR",
  "IVF_CLINIC_COORDINATOR",
  "DOCTOR",
  "BILLING_MANAGER",
] as const;

export const GOSTORK_ROLES = [
  "GOSTORK_ADMIN",
  "GOSTORK_CONCIERGE",
  "GOSTORK_DEVELOPER",
] as const;

export const ALL_ROLES = [
  ...GOSTORK_ROLES,
  "PARENT",
  ...PROVIDER_ROLES,
] as const;

export type ProviderRole = typeof PROVIDER_ROLES[number];
export type GostorkRole = typeof GOSTORK_ROLES[number];
export type AppRole = typeof ALL_ROLES[number];

export function isProviderRole(role: string): boolean {
  return (PROVIDER_ROLES as readonly string[]).includes(role);
}

export function hasProviderRole(roles: string[]): boolean {
  return roles.some(r => isProviderRole(r));
}

export function hasRole(roles: string[], role: string): boolean {
  return roles.includes(role);
}

export function hasAnyRole(roles: string[], check: string[]): boolean {
  return check.some(r => roles.includes(r));
}

export const PARENT_ACCOUNT_ROLES = [
  "INTENDED_PARENT_1",
  "INTENDED_PARENT_2",
  "VIEWER",
] as const;

export type ParentAccountRole = typeof PARENT_ACCOUNT_ROLES[number];

export function isParentAccountAdmin(role: string | null | undefined): boolean {
  return role === "INTENDED_PARENT_1";
}
