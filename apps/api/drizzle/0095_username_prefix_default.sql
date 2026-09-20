/*
 * The prefix needs a default, because the strategy has one.
 *
 * 0094 gave `username_strategy` a NOT NULL default of PREFIX_RANDOM and made
 * `panels_username_prefix_check` a biconditional. Those two together mean a panel
 * created WITHOUT a username policy — the commonest way an operator makes one —
 * had a strategy that requires a prefix and no prefix, so the CHECK refused the
 * insert. Found by the integration case that creates a panel and names no policy.
 *
 * `nx` is the same default the contract states, so an unconfigured panel produces
 * `nx` plus ten characters and nothing else changes.
 */
ALTER TABLE "panels" ALTER COLUMN "username_prefix" SET DEFAULT 'nx';