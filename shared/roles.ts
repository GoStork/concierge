export const IP_COORDINATOR_ROLES = [
  "IP_SURROGACY_COORDINATOR",
  "IP_EGG_DONOR_COORDINATOR",
  "IP_SPERM_DONOR_COORDINATOR",
  "IP_IVF_COORDINATOR",
] as const;

export const DONOR_COORDINATOR_ROLES = [
  "SURROGATE_COORDINATOR",
  "EGG_DONOR_COORDINATOR",
  "SPERM_DONOR_COORDINATOR",
] as const;

export const PROVIDER_ROLES = [
  "PROVIDER_ADMIN",
  ...IP_COORDINATOR_ROLES,
  ...DONOR_COORDINATOR_ROLES,
  "SCHEDULER",
  "DOCTOR",
  "BILLING_MANAGER",
] as const;

export const GOSTORK_ROLES = [
  "GOSTORK_ADMIN",
  "GOSTORK_CONCIERGE",
  "GOSTORK_DEVELOPER",
] as const;

export const PARTICIPANT_ROLES = [
  "SURROGATE",
  "EGG_DONOR",
  "SPERM_DONOR",
] as const;

export const ALL_ROLES = [
  ...GOSTORK_ROLES,
  "PARENT",
  ...PROVIDER_ROLES,
  ...PARTICIPANT_ROLES,
] as const;

export type IpCoordinatorRole = typeof IP_COORDINATOR_ROLES[number];
export type DonorCoordinatorRole = typeof DONOR_COORDINATOR_ROLES[number];
export type ProviderRole = typeof PROVIDER_ROLES[number];
export type GostorkRole = typeof GOSTORK_ROLES[number];
export type ParticipantRole = typeof PARTICIPANT_ROLES[number];
export type AppRole = typeof ALL_ROLES[number];

export function isProviderRole(role: string): boolean {
  return (PROVIDER_ROLES as readonly string[]).includes(role);
}

export function hasProviderRole(roles: string[]): boolean {
  return roles.some(r => isProviderRole(r));
}

export function isParticipantRole(role: string): boolean {
  return (PARTICIPANT_ROLES as readonly string[]).includes(role);
}

export function hasParticipantRole(roles: string[]): boolean {
  return roles.some(r => isParticipantRole(r));
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

export function isGostorkDeveloper(roles: string[]): boolean {
  return roles.includes("GOSTORK_DEVELOPER");
}

export function isGostorkAdminOrDeveloper(roles: string[]): boolean {
  return roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_DEVELOPER");
}

// Maps coordinator roles to the session subjectTypes they can access.
// Roles not listed here (PROVIDER_ADMIN, DOCTOR, SCHEDULER) have no subjectType restriction.
export const COORDINATOR_SUBJECT_TYPES: Record<string, string[]> = {
  IP_SURROGACY_COORDINATOR: ["Surrogate", "SurrogacyAgency"],
  IP_EGG_DONOR_COORDINATOR: ["Egg Donor"],
  IP_SPERM_DONOR_COORDINATOR: ["Sperm Donor"],
  IP_IVF_COORDINATOR: ["Clinic"],
  SURROGATE_COORDINATOR: ["Surrogate"],
  EGG_DONOR_COORDINATOR: ["Egg Donor"],
  SPERM_DONOR_COORDINATOR: ["Sperm Donor"],
};

// Roles that can access ALL session types from their provider without subjectType restriction.
export const ALL_SESSION_PROVIDER_ROLES = ["PROVIDER_ADMIN", "DOCTOR", "SCHEDULER", "BILLING_MANAGER"] as const;

// Returns true if a provider staff member's roles allow them to access a session with the given subjectType.
// If subjectType is null/undefined (untagged session), all provider staff can access it.
export function canProviderAccessSession(roles: string[], sessionSubjectType: string | null | undefined): boolean {
  if (roles.some(r => (ALL_SESSION_PROVIDER_ROLES as readonly string[]).includes(r))) return true;
  if (!sessionSubjectType) return true;
  for (const role of roles) {
    const allowed = COORDINATOR_SUBJECT_TYPES[role];
    if (allowed && allowed.includes(sessionSubjectType)) return true;
  }
  return false;
}

// BILLING_MANAGER and SCHEDULER cannot perform write/action operations in sessions.
export function isSessionReadOnlyRole(roles: string[]): boolean {
  return roles.includes("BILLING_MANAGER");
}

// BILLING_MANAGER and SCHEDULER cannot do these provider write operations.
export const PROVIDER_WRITE_RESTRICTED_ROLES = ["BILLING_MANAGER", "SCHEDULER"] as const;

export function isProviderWriteRestricted(roles: string[]): boolean {
  return roles.some(r => (PROVIDER_WRITE_RESTRICTED_ROLES as readonly string[]).includes(r));
}
