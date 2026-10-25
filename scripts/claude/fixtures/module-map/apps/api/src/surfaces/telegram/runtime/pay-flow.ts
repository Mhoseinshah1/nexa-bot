import { cardScreen } from './card-flow.js';
export async function walletPay(rt: unknown, command: string) {
  return cardScreen(rt, command);
}
function _helper() {
  return 1;
}
