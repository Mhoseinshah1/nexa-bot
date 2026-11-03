import {
  agentProfileIdOf,
  agentStateOf,
  type MirzaAgentState,
  type MirzaUserRow,
} from '../application/cutover-reconciliation.js';
import type { MirzaServiceInvoice } from '../application/cutover-service-reconciliation.js';
import {
  readLegacySnapshot,
  serviceCandidateInvoices,
} from '../../legacy-importer/application/source-snapshot.js';
import type { NxpkgLegacySourceConnector } from '../../legacy-importer/infrastructure/nxpkg-legacy-source.js';

/** The Mirza half of the cutover reconciliation, as one opened package gives it. */
export interface MirzaCutoverSide {
  readonly users: MirzaUserRow[];
  readonly agentStates: MirzaAgentState[];
  readonly agentProfileIds: ReadonlySet<string>;
  readonly serviceInvoices: MirzaServiceInvoice[];
}

const STATE_PATH = 'records/agents/state.jsonl';
const PROFILE_PATH = 'records/agents/profiles.jsonl';

/**
 * The package's own `user` snapshot and its agent states and profiles, and the service
 * candidates the importer decides from — read from an ALREADY OPENED connector, which the
 * caller closes. One reader for the `cutover-reconcile` CLI and (v0.9.7) the apply's own
 * balance reconciliation, so the two can never read the package differently.
 */
export async function readMirzaCutoverSide(
  connector: NxpkgLegacySourceConnector,
): Promise<MirzaCutoverSide> {
  const snapshot = await readLegacySnapshot(connector);
  const users = snapshot.users.map((u) => ({ id: u.id, balance: u.balance, agent: u.agent }));
  const serviceInvoices = serviceCandidateInvoices(snapshot).map((invoice) => ({
    invoiceKey: invoice.idInvoice,
    ownerTelegramId: invoice.idUser,
  }));
  const agentStates: MirzaAgentState[] = [];
  const agentProfileIds = new Set<string>();
  const pkg = connector.pkg;
  if (pkg !== null && pkg.has(STATE_PATH)) {
    for await (const record of pkg.iterJsonl(STATE_PATH)) {
      const state = agentStateOf(record);
      if (state !== null) agentStates.push(state);
    }
  }
  if (pkg !== null && pkg.has(PROFILE_PATH)) {
    for await (const record of pkg.iterJsonl(PROFILE_PATH)) {
      const id = agentProfileIdOf(record);
      if (id !== null) agentProfileIds.add(id);
    }
  }
  return { users, agentStates, agentProfileIds, serviceInvoices };
}
