import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { CALLBACK_REF_LENGTH, type IdGenerator } from '@nexa/contracts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export class Uuidv7IdGenerator implements IdGenerator {
  uuid(): string {
    return uuidv7();
  }

  /**
   * A short opaque reference for Telegram callback data.
   *
   * The Bot API caps `callback_data` at 64 bytes. A 36-character UUID plus a
   * route prefix does not fit, so interactive keyboards carry one of these and
   * resolve it through a registry row.
   */
  callbackRef(): string {
    // Rejection sampling keeps the distribution uniform across the 62 symbols.
    const out: string[] = [];
    while (out.length < CALLBACK_REF_LENGTH) {
      for (const byte of randomBytes(CALLBACK_REF_LENGTH)) {
        if (byte < 248) {
          out.push(BASE62[byte % 62] as string);
          if (out.length === CALLBACK_REF_LENGTH) break;
        }
      }
    }
    return out.join('');
  }
}

export const ID_GENERATOR = Symbol('ID_GENERATOR');
