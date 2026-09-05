import { PROVIDER_FAILURE_KINDS } from '@nexa/contracts';

/**
 * The contract's own list, re-exported so a test can iterate it.
 *
 * Deliberately not a hand-written copy: the point of every check that uses it
 * is that a kind ADDED to the contract is covered without anybody remembering
 * to add it here.
 */
export const PANEL_FAILURE_KINDS_FOR_TEST = PROVIDER_FAILURE_KINDS;
