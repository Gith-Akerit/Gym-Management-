import { Agent } from 'node:http';
import supertest from 'supertest';

/**
 * One listening server per fixture, with the connection to it held open.
 *
 * Calling supertest as `request(app)` starts a throwaway HTTP server, connects
 * to it once and drops both. A full `npm test` makes about 1200 requests across
 * five files running at once, so that is ~1200 loopback connections, and
 * Windows parks both ends of each in TIME_WAIT for two minutes against a
 * default ephemeral range of 16384 ports (`netsh int ipv4 show dynamicport
 * tcp`). Run the suite a few times in a row and the range is exhausted: one
 * unlucky request fails with `connect EADDRINUSE 127.0.0.1:<port>`, always a
 * different test, which is what made it look like state leaking between them.
 *
 * Binding once and reusing the socket takes a whole run from ~1200 connections
 * to ~120. Nothing about the app changes: it still answers over real TCP from
 * 127.0.0.1, so per-IP budgets and the CSRF checks see what they always saw.
 */
export function httpClient(app, t) {
  const server = app.listen(0, '127.0.0.1');
  server.unref();
  // Node hangs up an idle keep-alive socket after five seconds. Five test files
  // compete for the CPU, so a test can easily be starved for longer than that
  // between two requests and find the pooled socket closed underneath it. The
  // fixture decides when these sockets die, not a timer.
  server.keepAliveTimeout = 0;

  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  t.after(async () => {
    agent.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  // A pooled socket can still be closed by the far end in the instant between
  // being handed out and being written to, and connect() can still lose a race
  // for a port. Both are transport accidents that a browser would retry without
  // telling anyone. Only those: the callback returns false for every HTTP
  // status, so a real 429 or 500 from the app is never retried and never
  // hidden.
  const transportOnly = err => Boolean(err && RETRY_CODES.has(err.code));
  const bind = method => (...args) => {
    const test = supertest(server)[method](...args).agent(agent).retry(2, transportOnly);
    // A multipart body cannot be replayed: superagent has already drained the
    // form stream by the time a retry starts, so the server waits sixty seconds
    // for a body that never arrives and answers 408. Slip uploads therefore get
    // a connection of their own, which nothing else can have closed underneath
    // them, and no retry.
    for (const name of ['field', 'attach']) {
      const original = test[name].bind(test);
      test[name] = (...rest) => original(...rest).agent(ownConnection).retry(0);
    }
    return test;
  };

  return {
    get: bind('get'), post: bind('post'), put: bind('put'), patch: bind('patch'),
    delete: bind('delete'), options: bind('options'), head: bind('head'),
  };
}

const RETRY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EADDRINUSE', 'EPIPE']);
const ownConnection = new Agent({ keepAlive: false });
