import { Money, type WidgetId } from '@nexa/contracts';
import { ALPHA_CODES } from '@nexa/contracts/errors';
export class AlphaService {
  run(tx: any) {
    tx.insert(widgets).values({});
    return tx.update(gadgets).set({});
  }
}
