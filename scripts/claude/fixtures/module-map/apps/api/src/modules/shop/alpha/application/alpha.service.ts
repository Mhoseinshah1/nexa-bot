import { Money, type WidgetId } from '@nexa/contracts';
import { ALPHA_CODES } from '@nexa/contracts/errors';
export class AlphaService {
  run(tx: any) {
    tx.insert(widgets).values({});
    return tx.update(gadgets).set({});
  }
}

// referenced so the repository lint passes; module-map reads only the imports
export const used = [Money, ALPHA_CODES];
export type Used = WidgetId;
