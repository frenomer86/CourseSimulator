/**
 * The platform's xAPI profile: the fixed vocabulary every learning event must use.
 * Published from this package so the browser SDK, the API and the research exports agree.
 * Verbs reuse the ADL and cmi5 vocabularies where one exists; the rest live under our own IRI.
 */

export const XAPI_PROFILE_ID = 'https://cs-virtual-lab.org/xapi/profile';
export const XAPI_PROFILE_VERSION = '1.0.0';

const ADL = 'http://adlnet.gov/expapi/verbs/';
const OWN = 'https://cs-virtual-lab.org/xapi/verbs/';
const ACT = 'https://cs-virtual-lab.org/xapi/activity-types/';

export const VERBS = {
  launched: `${ADL}launched`,
  terminated: `${ADL}terminated`,
  viewed: `${OWN}viewed`,
  progressed: `${ADL}progressed`,
  completed: `${ADL}completed`,
  interacted: `${ADL}interacted`,
  attempted: `${ADL}attempted`,
  answered: `${ADL}answered`,
  passed: `${ADL}passed`,
  failed: `${ADL}failed`,
  'asked-for-hint': `${OWN}asked-for-hint`,
  submitted: `${OWN}submitted`,
  abandoned: `${OWN}abandoned`,
  saved: `${OWN}saved`,
  experienced: `${ADL}experienced`,
  asked: `${ADL}asked`,
  joined: `${OWN}joined`,
  left: `${OWN}left`,
  posted: `${OWN}posted`,
  replied: `${OWN}replied`,
  voted: `${ADL}voted`,
  shared: `${ADL}shared`,
  registered: `${ADL}registered`,
  scored: `${ADL}scored`,
  awarded: `${OWN}awarded`,
  created: `${OWN}created`,
  assigned: `${OWN}assigned`,
  consented: `${OWN}consented`,
  withdrew: `${OWN}withdrew`,
} as const;

export type Verb = keyof typeof VERBS;
export const VERB_NAMES = Object.keys(VERBS) as Verb[];

export const OBJECT_TYPES = {
  app: `${ACT}app`,
  course: `${ACT}course`,
  unit: `${ACT}unit`,
  topic: `${ACT}topic`,
  tutorial: `${ACT}tutorial`,
  check: `${ACT}topic-check`,
  'check-item': `${ACT}topic-check-item`,
  lab: `${ACT}lab`,
  'lab-artefact': `${ACT}lab-artefact`,
  error: `${ACT}error`,
  'forum-thread': `${ACT}forum-thread`,
  group: `${ACT}group`,
  'group-message': `${ACT}group-message`,
  resource: `${ACT}resource`,
  competition: `${ACT}competition`,
  problem: `${ACT}competition-problem`,
  class: `${ACT}class`,
  assignment: `${ACT}assignment`,
  consent: `${ACT}research-consent`,
} as const;

export type ObjectType = keyof typeof OBJECT_TYPES;
export const OBJECT_TYPE_NAMES = Object.keys(OBJECT_TYPES) as ObjectType[];

export const DEVICE_CLASSES = ['phone', 'tablet', 'desktop', 'unknown'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const CONNECTION_CLASSES = ['2g', '3g', '4g', 'wifi', 'unknown'] as const;
export type ConnectionClass = (typeof CONNECTION_CLASSES)[number];

/** Context extension keys (IRIs) used in statements. */
export const EXTENSIONS = {
  sessionId: `${XAPI_PROFILE_ID}/extensions/session-id`,
  deviceClass: `${XAPI_PROFILE_ID}/extensions/device-class`,
  connectionClass: `${XAPI_PROFILE_ID}/extensions/connection-class`,
  appVersion: `${XAPI_PROFILE_ID}/extensions/app-version`,
  locale: `${XAPI_PROFILE_ID}/extensions/locale`,
  course: `${XAPI_PROFILE_ID}/extensions/course`,
  unit: `${XAPI_PROFILE_ID}/extensions/unit`,
  topic: `${XAPI_PROFILE_ID}/extensions/topic`,
  labLevel: `${XAPI_PROFILE_ID}/extensions/lab-level`,
} as const;

/** Which verbs make sense for which object types; validation uses this table. */
export const ALLOWED: Record<ObjectType, Verb[]> = {
  app: ['launched', 'terminated'],
  course: ['viewed'],
  unit: ['viewed'],
  topic: ['viewed'],
  tutorial: ['viewed', 'progressed', 'completed', 'interacted'],
  check: ['attempted', 'passed', 'failed', 'viewed'],
  'check-item': ['answered'],
  lab: ['viewed', 'launched', 'attempted', 'interacted', 'asked-for-hint', 'submitted', 'passed', 'failed', 'abandoned'],
  'lab-artefact': ['saved'],
  error: ['experienced'],
  'forum-thread': ['viewed', 'asked', 'replied', 'voted'],
  group: ['joined', 'left', 'created'],
  'group-message': ['posted'],
  resource: ['shared', 'viewed'],
  competition: ['registered', 'scored', 'awarded', 'viewed'],
  problem: ['submitted', 'passed', 'failed'],
  class: ['created', 'joined'],
  assignment: ['assigned', 'completed'],
  consent: ['consented', 'withdrew'],
};

/** The profile as a plain document, for publishing with releases. */
export function xapiProfileDocument() {
  return {
    id: XAPI_PROFILE_ID,
    version: XAPI_PROFILE_VERSION,
    verbs: VERBS,
    activityTypes: OBJECT_TYPES,
    extensions: EXTENSIONS,
    allowed: ALLOWED,
    deviceClasses: DEVICE_CLASSES,
    connectionClasses: CONNECTION_CLASSES,
  };
}
