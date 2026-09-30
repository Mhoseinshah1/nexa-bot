/**
 * A minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
 *
 * Enough to drive one headless Chromium: send a command (optionally to an
 * attached session), await its result, and listen for events. No Playwright:
 * the repository does not depend on it, and the screenshots need nothing it
 * adds over the protocol.
 */
export class Cdp {
  #socket;
  #next = 1;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        if (waiter === undefined) return;
        this.#pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#next++;
    const payload = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#socket.send(JSON.stringify(payload));
    });
  }

  /** Calls `listener(message)` for every event; returns the unsubscribe. */
  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#socket.close();
  }
}
