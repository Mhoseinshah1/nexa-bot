import { z } from 'zod';
import { GIFT_CARD_BATCH_MAX_CODES, type SecretCipher, type TenantContext } from '@nexa/contracts';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { GiftCardExportSealer, SealedGiftCardExport } from '../application/ports.js';

const sealedSchema = z.object({
  v: z.literal(1),
  codes: z
    .array(z.string().regex(/^[2-9A-HJKMNP-TV-Z]{20}$/u))
    .min(1)
    .max(GIFT_CARD_BATCH_MAX_CODES),
});

/**
 * Seals a batch's plaintext codes for its 24-hour export (R10 D4): one JSON document under
 * `SecretCipher`, purpose `gift_card.batch_export`, bound to the tenant and the batch row's id,
 * so an export copied onto another batch — or another tenant's — fails authentication rather
 * than decrypting. Nothing here logs; the plaintext exists for the length of one expression on
 * each side.
 */
export class SecretCipherGiftCardSealer implements GiftCardExportSealer {
  constructor(private readonly cipher: SecretCipher) {}

  seal(scope: TenantContext, batchId: string, codes: readonly string[]): SealedGiftCardExport {
    const sealed = this.cipher.encrypt(JSON.stringify({ v: 1, codes }), {
      purpose: 'gift_card.batch_export',
      tenantId: requireTenantId(scope),
      entityId: batchId,
    });
    return { ciphertext: sealed.ciphertext, keyId: sealed.keyId };
  }

  open(scope: TenantContext, batchId: string, sealed: SealedGiftCardExport): readonly string[] {
    const plain = this.cipher.decrypt(
      { keyId: sealed.keyId, ciphertext: sealed.ciphertext },
      {
        purpose: 'gift_card.batch_export',
        tenantId: requireTenantId(scope),
        entityId: batchId,
      },
    );
    return sealedSchema.parse(JSON.parse(plain)).codes;
  }
}
