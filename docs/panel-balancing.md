# Automatic panel balancing (Phase C3)

Automatic balancing picks which panel a **new** service account is created on,
choosing among panels an operator has declared interchangeable. It never moves
an existing service and never adds a second way of allocating capacity. A panel
that is not in a group behaves exactly as it did before.

## The model

- **Home panel.** Every product is bound to one panel, its _home_. That binding
  is the explicit route, and it is the default.
- **Balancing group.** `panels.balancing_group` is an operator's label, such as
  `eu-west`, for panels that are interchangeable for a new account. It is set
  through the ordinary audited panel write (`panels.edit`). Labels are stored in
  lower case, so `EU` and `eu` are the same group. Clearing the label (`null`)
  takes the panel out of its group.
- **On/off and strategy.** The feature flag `panel_auto_balancing` turns
  balancing on; it is off by default and applies tenant-wide. The setting
  `panels.balancing.strategy` (`LEAST_USED` or `LOWEST_UTILISATION`) chooses how
  candidates are ranked by load.

With the flag off, or when the home panel is in no group, a new draft goes to
the home panel and no placement record is written. This is the
"manual routing takes precedence" rule.

## When the panel is chosen: at the draft, not at confirmation

The panel is chosen in `OrderService.createDraft`, in the same transaction that
writes the draft. It cannot wait until confirmation, because the steps between
draft and confirmation depend on the panel:

- The username step reserves a name in the chosen panel's own namespace
  (`service_username_reservations.panel_id`; provider plus host).
- The customer is shown that name in the summary they confirm.

Moving the order to a different panel at confirmation would either:

- put the customer on a machine whose namespace their name was never checked
  against, or
- give them a name they were never shown.

Neither is acceptable. So the placement is decided before the username step.
Confirmation then does what it already does: `PanelSalesGate.acquire`
re-decides eligibility under the panel's lock and takes the one slot, or refuses.

Consequences of that choice:

- **No second capacity claim, no new lock, and no change to the lock order**
  (order → panel → reservation; see `tests/integration/lock-order.test.ts`).
  The placement is a read that decides which panel the single existing claim is
  for.
- **No over-allocation.** Two drafts can be placed on the same panel, which has
  one slot left. The first confirmation takes the slot; the second is refused
  `AT_CAPACITY` without taking anything. That is the fallback: the customer
  starts again, and the new draft is placed on the panel that still has room.
  `panel-balancing.test.ts` races four customers for one slot on each of two
  panels and checks this.

## The decision (`decidePlacement`, a pure function)

**Candidates.** The home panel's group within this tenant, archived panels
excluded, assessed by `PanelSalesGate.assessMany`. That method runs the same
reads and the same `decideEligibility` as the catalogue, so there is no second
eligibility rule. A panel is excluded, with the reason recorded, if it is:

- `INELIGIBLE`: the evaluator refused it. Its reason is kept, e.g. `DRAINING`,
  `DISABLED`, `UNHEALTHY` (confirmed), `AT_CAPACITY`, `UNVALIDATED`. An
  unhealthy or drained panel is therefore never chosen silently.
- `PROVIDER_MISMATCH`: a different provider type from the home panel. A
  product's specification was written for its home panel's provider.
- `NOT_ENTITLED`: the ordering reseller's tier does not grant this panel. This
  is the one reseller entitlement evaluator, asked once per candidate.

**Ranking of eligible panels**, in this order:

1. **Health.** Panels that are `HEALTHY` and fresh come first. A panel can be
   eligible with one failed probe (hysteresis), or `DEGRADED`, or stale; those
   rank after the healthy ones.
2. **Load**, per the strategy:
   - `LEAST_USED`: fewest occupied slots, meaning services plus live holds
     (`PanelCapacity.used`).
   - `LOWEST_UTILISATION`: smallest `used / cap`, compared exactly by
     cross-multiplication, with no floating point. An uncapped panel ranks after
     every capped one, ordered by `used` among the uncapped.
3. **Home preference.** When candidates tie on health and load, the home panel
   wins, so placements stay stable.
4. **Panel id.** The lowest id wins, so the same inputs always give the same
   answer in any order.

**Explanation (`decidedBy`).** This records the first rule above that separated
the winner from the runner-up: `HEALTH`, `LOAD`, `HOME_PREFERENCE` or
`PANEL_ID`. Two other values:

- `SOLE_CANDIDATE`: only one panel was eligible.
- `NO_ELIGIBLE_CANDIDATE`: nothing in the group was eligible. The draft keeps
  its home panel, and confirmation refuses it for the home panel's own reason.

## What the operator sees

- **`order_panel_placements` table.** One row per balanced order: home panel,
  chosen panel, group, strategy, `decidedBy`, and the ranked candidates with the
  exact figures the decision used. The row is written once, in the draft's
  transaction. A trigger refuses any UPDATE, so the explanation is never
  rewritten. The draft's `order.draft_create` audit row also records home,
  chosen and `decidedBy`.
- **API.** `GET /orders/:id/placement` (`orders.view`) returns the row, or
  `placement: null` for an order that used the explicit route.
- **Web Admin, order detail.** A "انتخاب پنل" card shows the rule that chose
  the panel, the group, the strategy, and every candidate with its rank,
  status, health and load.
- **Web Admin, `/panel-health`.** Each card shows the panel's group, and an
  edit control is drawn for `panels.edit`.

## The catalogue

`ProductService` lists products whose home panel is in the sales gate's
eligible list. With balancing on, the list is widened by
`PanelPlacementService.reachableHomes`: a product is also offered when its home
panel is full, drained or down, as long as another panel of the same group and
provider can take the account, because the draft will be placed there.
Reseller catalogues still filter by the panels their tier grants, using the
home panel's id. As before, the catalogue is a courtesy: the draft places the
order, and confirmation decides.

## Not in scope, deliberately

- **Rebalancing or moving existing services.** §15 asks for a policy for _new_
  provisioning only. Moving an account between machines is a separate, explicit
  act and would go through the location-change and operation lane.
- **Trials and custom services.** Trials are per panel (R1), and a custom
  service's panel is chosen by its location. Neither goes through
  `createDraft`'s product path.
- **Automatic group membership.** A group is always an operator's decision.
  Nothing infers that two panels are interchangeable.
