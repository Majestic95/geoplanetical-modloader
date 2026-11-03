// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket, flat sessions (one socket, sessionId per
// target). Host-side tooling: never loaded into the game.

export async function connect(wsUrl, { timeoutMs = 120000 } = {}) {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cdp: cannot connect to ${wsUrl}`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const handlers = new Map();
  const closeHandlers = [];

  ws.addEventListener('message', ev => {
    const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of handlers.get(msg.method) || []) {
      Promise.resolve().then(() => fn(msg.params, msg.sessionId)).catch(e => console.error(`[cdp] ${msg.method} handler: ${e.message}`));
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${p.method}: connection closed`)); }
    pending.clear();
    for (const fn of closeHandlers) fn();
  });

  return {
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no reply in ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, method, timer });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    on(method, fn) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(fn);
    },
    onClose(fn) { closeHandlers.push(fn); },
    close() { ws.close(); },
  };
}
