import type { PanelCapacity } from './capacity-ports.js';

/** The four numbers, derived in ONE place so no caller computes `available` itself. */
export function capacityOf(
  maxServices: number | null,
  serviceCount: number,
  reservationCount: number,
): PanelCapacity {
  const used = serviceCount + reservationCount;
  return {
    services: serviceCount,
    reservations: reservationCount,
    used,
    maxServices,
    /*
     * Floored at zero, and the floor is load-bearing.
     *
     * Lowering a cap below current usage is explicitly allowed and terminates
     * nothing, so `maxServices - used` is legitimately NEGATIVE for as long as
     * it takes usage to fall. A surface rendering "-3 available" reads as a bug
     * in the counter rather than as the state an operator just created; the
     * honest number of slots left is none.
     */
    available: maxServices === null ? null : Math.max(0, maxServices - used),
  };
}
