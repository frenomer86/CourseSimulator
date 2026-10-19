/** The research notice shown in the app, from its versioned source in docs/governance. */

import noticeSource from '@docs/governance/privacy-notice.md?raw';

/** Must match the "Version N" line at the top of docs/governance/privacy-notice.md. */
export const NOTICE_VERSION = (/Version (\d+)/.exec(noticeSource)?.[1] ?? '1') as string;

export const NOTICE_MARKDOWN: string = noticeSource;
