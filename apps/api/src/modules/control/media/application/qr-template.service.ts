import {
  QR_TEMPLATE_PREVIEW_TEXT,
  inspectQrBackgroundPng,
  isSystemContext,
  qrTemplatePlacementProblem,
  qrTemplateSettingSchema,
  type ActorContext,
  type DeliveryQrPreviewResponse,
  type QrTemplate,
  type QrTemplateFallbackReason,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingChangeGuard } from '../../settings/application/settings.service.js';
import type { QrTemplatePreviewer, TenantMediaRepository } from './ports.js';
import { MEDIA_VIEW } from './tenant-media.service.js';

/** Why a probe would not use the template, as the operator is told at save. */
const PROBE_REFUSAL: Readonly<Record<QrTemplateFallbackReason, string>> = {
  NO_TEMPLATE: 'There is no template to save.',
  NO_BACKGROUND: 'Upload a QR background before placing the code on it.',
  BACKGROUND_UNREADABLE: 'The stored QR background cannot be decoded; replace it first.',
  OUTSIDE_BACKGROUND: 'The QR region does not lie inside the background.',
  MODULE_TOO_SMALL:
    'The QR region is too small: a link of typical length would be drawn with modules under ' +
    '4 px as Telegram shows the photo (backgrounds over 1280 px are shown scaled down). ' +
    'Make the region larger, or the background smaller.',
  OUTPUT_TOO_LARGE:
    'This background composes to an image too large to send in time; use a simpler or smaller ' +
    'background.',
  CONFIG_UNREADABLE: 'The QR template could not be read.',
};

/** The key this module's veto speaks for. */
export const QR_TEMPLATE_SETTING = 'delivery.qr_template';

/**
 * Phase 2 item 4: a template is placed ON a background, so a template is refused while there
 * is no background to place it on, and when its region does not lie wholly inside the one
 * stored now. Asked inside the settings write's own transaction, and only when the value is
 * really changing; clearing the template (null, the plain QR) is never refused.
 *
 * Not the only line: a background replaced AFTER the template was saved can be smaller, and
 * the renderer checks the placement again on every delivery and sends the plain QR when the
 * region no longer fits. Refusing the upload instead would make replacing a background a
 * two-step dance through an invalid state.
 */
export class QrTemplateGuard implements SettingChangeGuard {
  readonly key = QR_TEMPLATE_SETTING;

  constructor(
    private readonly media: Pick<TenantMediaRepository, 'content'>,
    /**
     * Whether the template would be USED for a link of typical length on these background
     * bytes, or why not (`probeQrTemplate`): a region whose modules Telegram would shrink
     * under the minimum, or a composite too large to send in time, is refused here, at save,
     * rather than discovered as a fallback in the log.
     */
    private readonly probe: (
      template: QrTemplate,
      bytes: Uint8Array,
    ) => QrTemplateFallbackReason | null,
  ) {}

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    const parsed = qrTemplateSettingSchema.safeParse(change.to);
    // The schema has already validated the value; anything else is not this guard's to judge.
    if (!parsed.success || parsed.data === null) return null;
    const template: QrTemplate = parsed.data;
    if (isSystemContext(scope)) return 'A QR template belongs to a tenant.';
    // The media slot is the TENANT's, whichever bot the write came through.
    const stored = await this.media.content(
      { tenantId: scope.tenantId, botInstanceId: null },
      'QR_BACKGROUND',
      tx,
    );
    if (stored === null) {
      return 'Upload a QR background before placing the code on it.';
    }
    const header = inspectQrBackgroundPng(stored.bytes);
    if (!header.ok) {
      return `The stored QR background cannot be used (${header.problem}); replace it first.`;
    }
    if (qrTemplatePlacementProblem(template, header) !== null) {
      return (
        `The QR region (${String(template.x)}, ${String(template.y)}, ${String(template.size)} px) ` +
        `does not lie inside the ${String(header.width)}×${String(header.height)} background.`
      );
    }
    const unusable = this.probe(template, stored.bytes);
    if (unusable !== null) return PROBE_REFUSAL[unusable];
    return null;
  }
}

/**
 * The Web Admin's preview of the QR a customer would receive: the DRAFT template (or the
 * plain QR for null) on the background stored now, encoding `QR_TEMPLATE_PREVIEW_TEXT`.
 * Read-only, `settings.view`. The same renderer the delivery lane uses, so the preview is
 * the image, not an imitation of it.
 */
export class QrTemplatePreviewService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly previewer: QrTemplatePreviewer,
  ) {}

  async preview(
    scope: TenantContext,
    actor: ActorContext,
    draft: QrTemplate | null,
  ): Promise<DeliveryQrPreviewResponse> {
    await this.guard.check(scope, actor, MEDIA_VIEW);
    // One read of the background, by the renderer, which also states its dimensions.
    const outcome = await this.previewer.renderText(scope, QR_TEMPLATE_PREVIEW_TEXT, draft, {
      describeBackground: true,
    });
    return {
      background: outcome.background,
      pngBase64: Buffer.from(outcome.bytes).toString('base64'),
      width: outcome.width,
      height: outcome.height,
      templated: outcome.templated,
      fallback: outcome.fallback,
      moduleScale: outcome.scale,
    };
  }
}
