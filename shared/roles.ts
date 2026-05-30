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
