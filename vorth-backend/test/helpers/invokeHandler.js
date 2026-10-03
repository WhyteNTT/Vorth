'use strict';

/**
 * Drives a controller handler in-process, and waits for it to actually finish.
 *
 * asyncHandler(fn) is:
 *
 *     Promise.resolve(fn(req, res, next)).catch(next)
 *
 * so `next` is called **only on rejection**. On success nothing calls it, and the
 * handler's own res.json() is what finishes the work. That gives two ways to get
 * this wrong, and both have been wrong in this repo:
 *
 *   - passing the promise's resolve as `next` settles the promise synchronously,
 *     before the handler has run, because resolve(req, res, next) returns
 *     undefined. The assertion then reads undefined, and node:assert's loose
 *     equality says undefined == null, so it passes. A false pass, on the step
 *     that was supposed to change the database.
 *   - falling back to setImmediate, which races an await inside the handler and
 *     reports success for calls that threw.
 *
 * This settles when the handler responds *or* calls next, whichever comes first.
 *
 * @param {Function|Function[]} chain  a handler, or the [validators..., handler]
 *                                      array the controllers export
 * @param {object} req                 the request
 * @param {object} [res]               a response double; one is built if omitted
 * @returns {Promise<{res: object, error: Error|null}>}
 */
function invokeHandler(chain, req, res) {
  const handler = typeof chain === 'function' ? chain : chain[chain.length - 1];

  const response = res || {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    set(key, value) { this[key] = value; return this; },
    type(t) { this.type_ = t; return this; },
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      resolve({ res: response, error: error || null });
    };

    // Both completion paths, not just next.
    const json = response.json.bind(response);
    response.json = (payload) => {
      json(payload);
      settle(null);
      return response;
    };
    const status = response.status.bind(response);
    response.status = (code) => {
      status(code);
      return response;
    };

    try {
      handler(req, response, settle);
    } catch (err) {
      settle(err);
    }
  });
}

module.exports = { invokeHandler };
