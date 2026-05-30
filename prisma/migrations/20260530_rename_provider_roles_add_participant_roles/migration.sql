-- Rename IP-facing coordinator roles (old name → new name)
UPDATE "User"
SET roles = array_replace(roles, 'SURROGACY_COORDINATOR', 'IP_SURROGACY_COORDINATOR')
WHERE 'SURROGACY_COORDINATOR' = ANY(roles);

UPDATE "User"
SET roles = array_replace(roles, 'EGG_DONOR_COORDINATOR', 'IP_EGG_DONOR_COORDINATOR')
WHERE 'EGG_DONOR_COORDINATOR' = ANY(roles);

UPDATE "User"
SET roles = array_replace(roles, 'SPERM_DONOR_COORDINATOR', 'IP_SPERM_DONOR_COORDINATOR')
WHERE 'SPERM_DONOR_COORDINATOR' = ANY(roles);

UPDATE "User"
SET roles = array_replace(roles, 'IVF_CLINIC_COORDINATOR', 'IP_IVF_COORDINATOR')
WHERE 'IVF_CLINIC_COORDINATOR' = ANY(roles);
