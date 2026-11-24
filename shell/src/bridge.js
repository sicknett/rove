// Runs before the page's own scripts. The page talks to the app only through window.rove.
(() => {
  if (window.rove) return;
  const queue = [];
  let handler = null;
  Object.defineProperty(window, '__roveReceive', {
    value: (message) => {
      if (handler) handler(message);
      else if (queue.length < 500) queue.push(message);
    },
  });
  window.rove = Object.freeze({
    platform: 'windows',
    send(message) {
      window.ipc.postMessage(JSON.stringify(message));
    },
    subscribe(fn) {
      handler = fn;
      while (queue.length) fn(queue.shift());
      return () => {
        if (handler === fn) handler = null;
      };
    },
  });
})();
