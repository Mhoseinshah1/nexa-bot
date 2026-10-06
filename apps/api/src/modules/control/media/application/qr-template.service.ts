import {
  QR_TEMPLATE_PREVIEW_TEXT,
  inspectQrBackgroundPng,
  isSystemContext,
  qrTemplatePlacementProblem,
  qrTemplateSettingSchema,
  type ActorContext,
  type DeliveryQrPreviewResponse,
  type QrTemplate,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingChangeGuard } from '../../settings/application/settings.service.js';
import type { QrTemplatePreviewer, TenantMediaRepository } from './ports.js';
import { MEDIA_VIEW } from './tenant-media.service.js';

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

  constructor(private readonly media: Pick<TenantMediaRepository, 'content'>) {}

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
    private readonly media: Pick<TenantMediaRepository, 'content'>,
  ) {}

  async preview(
    scope: TenantContext,
    actor: ActorContext,
    draft: QrTemplate | null,
  ): Promise<DeliveryQrPreviewResponse> {
    await this.guard.check(scope, actor, MEDIA_VIEW);
    const outcome = await this.previewer.renderText(scope, QR_TEMPLATE_PREVIEW_TEXT, draft);
    const stored = await this.media.content(scope, 'QR_BACKGROUND');
    const header = stored === null ? null : inspectQrBackgroundPng(stored.bytes);
    return {
      background:
        header === null || !header.ok ? null : { width: header.width, height: header.height },
      pngBase64: Buffer.from(outcome.bytes).toString('base64'),
      width: outcome.width,
      height: outcome.height,
      templated: outcome.templated,
      fallback: outcome.fallback,
      moduleScale: outcome.scale,
    };
  }
}
