import * as payFlow from './runtime/pay-flow.js';
export class BotRuntime {
  async act(command: string) {
    if (command === 'PAY') return payFlow.walletPay(this, command);
    return null;
  }
}
