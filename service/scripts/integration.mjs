/**
 * Verify the plugin's service client against a live Mac service.
 *
 * This exercises the exact module the Obsidian plugin ships in service mode:
 * pair a device, submit a turn with a client turn id, poll for the result,
 * confirm idempotency, then read and (safely) write notes through the
 * confirmation flow. It never writes into a human zone.
 *
 * Usage:
 *   AOS_INTEGRATION_CODE=<pairing code> node service/scripts/integration.mjs
 * Environment:
 *   AOS_SMOKE_URL   service base URL (default https://agent.chenhaotong.one)
 *   AOS_SMOKE_REAL  set to 0 to skip the real chat turn
 */
import { createServiceClient } from '../../plugin/src/kernel/service-client.js';

const base = process.env.AOS_SMOKE_URL || 'https://agent.chenhaotong.one';
const code = process.env.AOS_INTEGRATION_CODE;
const realTurn = process.env.AOS_SMOKE_REAL !== '0';

let failures = 0;
function step(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

if (!code) {
  console.error('AOS_INTEGRATION_CODE is required (run: node service/bin/agent-os.mjs pair)');
  process.exit(2);
}

const client = createServiceClient({ url: base, getCredential: () => credential });
let credential = '';

// ---- pairing ---------------------------------------------------------------
const paired = await client.pair(code, { name: 'plugin integration', platform: 'cli' });
credential = paired.credential;
step('device pairs and receives its own credential', !!credential, paired.device?.id || '');

const health = await client.health();
step('authenticated health reports a diagnosis', !!health.json.diagnosis, JSON.stringify(health.json.diagnosis));

// ---- a real turn through the plugin client ---------------------------------
if (realTurn) {
  const clientTurnId = `plugin-${Date.now()}`;
  const seen = [];
  const result = await client.runTurn({
    clientTurnId,
    sessionKey: 'agent:main:main',
    message: '只回复两个字：收到',
    pollMs: 2000,
    onProgress: (event) => seen.push(event.status || event.text || ''),
  });
  step('turn completes through the plugin client', result.ok === true, `bytes=${(result.text || '').length}`);
  step('progress was streamed to the UI', seen.length > 0, `${seen.length} updates`);

  // Re-submitting the same clientTurnId must not create a second run.
  const again = await client.submitTurn({
    clientTurnId,
    sessionKey: 'agent:main:main',
    message: '只回复两个字：收到',
  });
  step(
    'a retry reuses the existing turn',
    again.json.duplicate === true && again.json.turn.id === result.turnId,
    `status=${again.status}`
  );

  // A resumed poll reads the stored result without re-running anything.
  const resumed = await client.resumeTurn(result.turnId, { after: 0, pollMs: 2000 });
  step('result can be re-read from the Mac after the fact', resumed.ok === true, `bytes=${(resumed.text || '').length}`);
} else {
  console.log('SKIP  real chat turn (AOS_SMOKE_REAL=0)');
}

// ---- sessions + notes ------------------------------------------------------
const sessions = await client.listSessions();
step('session list is reachable', Array.isArray(sessions.json.sessions), `${sessions.json.sessions?.length || 0} sessions`);

const search = await client.searchNotes('agent-inbox', 3);
step('note search works over HTTPS', Array.isArray(search.json.hits), `${search.json.hits?.length || 0} hits`);

// A write inside the agent's own zone needs no confirmation.
const notePath = `agent-inbox/.integration-${Date.now()}.md`;
const written = await client.writeNote({ path: notePath, content: '# integration probe\n' });
step('agent-owned write succeeds without confirmation', written.status === 200, notePath);
const read = await client.readNote(notePath);
step('written note reads back with a fingerprint', /^sha256:/.test(read.json.note.fingerprint || ''));

// A human-zone write must produce a confirmation request, and must not be applied.
let confirm = null;
try {
  await client.writeNote({ path: '手记/.integration-probe.md', content: 'should never be written' });
} catch (error) {
  if (error.code === 'CONFIRMATION_REQUIRED') confirm = error.details.confirm;
}
step('human-zone write asks for confirmation instead of writing', !!confirm, confirm?.path || '');
if (confirm) {
  const peek = await client.peekConfirmation(confirm.token);
  step('confirmation can be inspected before approval', peek.status === 200 && peek.json.confirm.path === confirm.path);
  // Deliberately do not approve: nothing may be written without a human.
}

console.log(failures ? `\nINTEGRATION FAILED (${failures})` : '\nINTEGRATION PASSED');
process.exit(failures ? 1 : 0);
