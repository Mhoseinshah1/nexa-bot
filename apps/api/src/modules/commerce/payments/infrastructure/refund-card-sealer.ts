import { z } from 'zod';
import type { SecretCipher, TenantContext } from '@nexa/contracts';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { GatewayRefundCard, RefundCardSealer } from '../application/gateway-invoice-ports.js';

const sealedSchema = z.object({ n: z.string().regex(/^\d{16}$/u), h: z.string().min(1).max(256) });

/**
 * Seals a customer's refund card for the gateway worker (Round 6): the card number and holder as
 * one JSON string under `SecretCipher`, purpose `payment_gateway.refund_card`, bound to the
 * request row's id and the tenant — so a sealed card moved onto another request, or another
 * tenant's, fails authentication rather than decrypting.
 *
 * The plaintext exists in this file for the length of one expression on each side, and nothing
 * here logs. `open` is called once, by the worker, before the send stamp wipes the ciphertext.
 */
export class SecretCipherRefundCardSealer implements RefundCardSealer {
  constructor(private readonly cipher: SecretCipher) {}

  seal(
    scope: TenantContext,
    requestId: string,
    card: GatewayRefundCard,
  ): { readonly ciphertext: string; readonly keyId: string } {
    const sealed = this.cipher.encrypt(JSON.stringify({ n: card.cardNumber, h: card.cardHolder }), {
      purpose: 'payment_gateway.refund_card',
      tenantId: requireTenantId(scope),
      entityId: requestId,
    });
    return { ciphertext: sealed.ciphertext, keyId: sealed.keyId };
  }

  open(
    scope: TenantContext,
    requestId: string,
    sealed: { readonly ciphertext: string; readonly keyId: string },
  ): GatewayRefundCard {
    const plain = this.cipher.decrypt(
      { keyId: sealed.keyId, ciphertext: sealed.ciphertext },
      {
        purpose: 'payment_gateway.refund_card',
        tenantId: requireTenantId(scope),
        entityId: requestId,
      },
    );
    const parsed = sealedSchema.parse(JSON.parse(plain));
    return { cardNumber: parsed.n, cardHolder: parsed.h };
  }
}
