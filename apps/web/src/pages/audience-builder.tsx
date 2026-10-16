import { AudienceConditions } from '../ui/audience-builder';
import type { AudienceDraft } from '../ui/audience-builder/model';

/**
 * The SHARED audience builder (round N): the one editor of an audience definition, used by
 * «ارسال همگانی», «عملیات گروهی» and the campaigns built on them — one segmentation UI over
 * one segmentation engine. It edits the definition as the contract's input shape and never
 * decides membership: the count it shows is the server's (`POST /audience/preview`).
 *
 * W1.6: the editor is the condition-list builder in `ui/audience-builder/`; the definition,
 * its wire form and its sentences live in `ui/audience-builder/model.ts` and are re-exported
 * here unchanged, so the pages that import them need no change.
 */
export {
  EMPTY_AUDIENCE,
  SERVICE_STATE_LABELS,
  audienceMessage,
  describeAudience,
  draftOf,
  useCachedBotNames,
  wireAudience,
  withTagRole,
  type AudienceDraft,
} from '../ui/audience-builder/model';

export function AudienceBuilder({
  value,
  onChange,
  disabled = false,
}: {
  value: AudienceDraft;
  onChange: (next: AudienceDraft) => void;
  disabled?: boolean;
}) {
  return <AudienceConditions value={value} onChange={onChange} disabled={disabled} />;
}
