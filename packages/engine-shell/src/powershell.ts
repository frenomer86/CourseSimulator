/**
 * The PowerShell subset for Windows Server labs. The implementation lives in ./win/: an
 * interpreter (core.ts), the estate and directory model (model.ts) and one module per area of
 * Windows Server administration. A machine whose system has os: 'windows' routes typed lines here.
 */

import { cmdletList, nativeList } from './win/index.js';
import type { SmbShareRec } from './win/model.js';

export { runPowerShell, promptPowerShell, psAwaitsMore, psQuery, toWin, toVfs, loadAd, loadEstate, saveAd, saveEstate, newDirectory, newMachine, domainDn, winSystemSpec, effectiveAccess, ntfsAccess, shareAccess, rsop, effectivePolicy, effectiveExtra, reach, resolve, findUser, findGroup, findComputer, groupsOf, resultantPolicy, makeEnv, evalSource, machineByName } from './win/index.js';
export type { AdState, AdUser, AdGroup, AdOu, AdComputer, Estate, Machine, WinLabSpec, Gpo } from './win/model.js';
export type SmbShare = SmbShareRec;

/** Cmdlet and tool names, for tab completion. */
export const CMDLETS: string[] = [...cmdletList(), ...nativeList()];
