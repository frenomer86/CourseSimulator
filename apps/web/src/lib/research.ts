/**
 * Research consent and the learner's own recorded data, against the app's API.
 * See docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md.
 */

import { api } from './api';

export interface Consent {
  noticeVersion: string;
  researchEvents: boolean;
  researchSnapshots: boolean;
  researchSocial: boolean;
  contactFollowup: boolean;
  guardianConsent: boolean;
  consentedAt: string;
  withdrawnAt: string | null;
}

export interface ConsentInput {
  noticeVersion: string;
  researchEvents: boolean;
  researchSnapshots: boolean;
  researchSocial: boolean;
  contactFollowup: boolean;
  guardianConsent?: boolean;
}

export const NO_CONSENT: Omit<ConsentInput, 'noticeVersion'> = {
  researchEvents: false,
  researchSnapshots: false,
  researchSocial: false,
  contactFollowup: false,
  guardianConsent: false,
};

export function getConsent(): Promise<{ noticeVersion: string; consent: Consent | null }> {
  return api('/me/consent');
}

export function setConsent(input: ConsentInput): Promise<{ noticeVersion: string; consent: Consent }> {
  return api('/me/consent', { method: 'PUT', body: input });
}

export interface MyDataEvent {
  id: string;
  occurredAt: string;
  verb: string;
  objectType: string;
  objectId: string;
  course: string | null;
  unit: number | null;
  topic: number | null;
  labId: string | null;
  labLevel: string | null;
  result: unknown;
  inResearchStream: boolean;
}

export interface MyData {
  researchId: string;
  noticeVersion: string;
  consent: Consent | null;
  events: { total: number; firstAt: string | null; lastAt: string | null; byVerb: Array<{ verb: string; count: number }>; inResearchStream: number };
  snapshots: { total: number; inResearchStream: number };
  recent: MyDataEvent[];
}

export function getMyData(): Promise<MyData> {
  return api('/me/data', { timeoutMs: 30_000 });
}

export function deleteMyData(): Promise<{ eventsDeleted: number; snapshotsDeleted: number }> {
  return api('/me/data', { method: 'DELETE', timeoutMs: 60_000 });
}
