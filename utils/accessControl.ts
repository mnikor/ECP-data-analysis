import { User, UserRole } from '../types';

export const POC_DEFAULT_ROLE = UserRole.ADMIN;

export interface AccessProfile {
  label: string;
  summary: string;
  canAccessDataOps: boolean;
  canAccessClinicalIntelligence: boolean;
  canAccessGovernance: boolean;
}

// Central place to restore role/claim-based authorization once enterprise SSO is integrated.
export const getAccessProfile = (_user?: User | null): AccessProfile => ({
  label: 'POC Access',
  summary: 'All modules are enabled during pilot testing. Enterprise SSO and authorization can be layered here later.',
  canAccessDataOps: true,
  canAccessClinicalIntelligence: true,
  canAccessGovernance: true,
});
