'use strict';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function ok(body) {
  return json(200, body);
}

function badRequest(message) {
  return json(400, { error: message });
}

function serverError(err) {
  // Log full detail server-side; never leak internals (DB structure, stack
  // traces) to the client per the spec's security requirements (§49).
  console.error(err);
  return json(500, { error: 'Something went wrong processing that request.' });
}

/** Standard preflight response for browser CORS checks. */
function preflight() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

module.exports = { json, ok, badRequest, serverError, preflight, CORS_HEADERS };
