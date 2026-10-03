/**
 * Mac service client returns `{ status, json }` from request(); unwrap before reading fields.
 * @param {unknown} payload
 */
export function unwrapServicePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.json && typeof payload.json === 'object') return payload.json;
  return payload;
}

/** @param {unknown} payload */
export function serviceSessionsFromPayload(payload) {
  const body = unwrapServicePayload(payload);
  return Array.isArray(body?.sessions) ? body.sessions : [];
}

/** @param {unknown} payload */
export function serviceMessagesFromPayload(payload) {
  const body = unwrapServicePayload(payload);
  return Array.isArray(body?.messages) ? body.messages : [];
}
