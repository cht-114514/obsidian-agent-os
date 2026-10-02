/**
 * One-shot OpenClaw gateway handshake probe.
 * Prints codes, client ids, and request ids only — never tokens or keys.
 *
 * Usage: node scripts/kernel-spike.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GATEWAY_URL = process.env.AOS_GATEWAY_URL || "ws://127.0.0.1:18789";
const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const STATE_PATH = "/tmp/aos-kernel-spike.json";
const SECRET_KEYS = /token|password|signature|private|secret|publickey|nonce|deviceToken/i;

function loadToken() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("gateway.auth.token missing");
  }
  return token.trim();
}

function redact(value, token) {
  if (value == null) return value;
  if (typeof value === "string") {
    let out = token ? value.split(token).join("<redacted>") : value;
    if (out.length > 96 && !out.includes(" ")) return `<redacted:${out.length}>`;
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, token));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) {
        out[key] = item == null ? item : "<redacted>";
        continue;
      }
      out[key] = redact(item, token);
    }
    return out;
  }
  return value;
}

function log(label, value, token) {
  const safe = redact(value, token);
  console.log(label, typeof safe === "string" ? safe : JSON.stringify(safe));
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function loadOrCreateIdentity() {
  if (fs.existsSync(STATE_PATH)) {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (saved.publicKey && saved.privateKey && saved.deviceId) return saved;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const rawPrivate = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const identity = {
    deviceId: crypto.createHash("sha256").update(rawPublic).digest("hex"),
    publicKey: b64url(rawPublic),
    privateKey: b64url(rawPrivate),
    operator: null,
    node: null,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

function saveIdentity(identity) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(identity), { mode: 0o600 });
}

function signPayload(identity, payload) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(identity.privateKey, "base64url"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return b64url(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function authPayload({ identity, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  return [
    "v3",
    identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(signedAtMs),
    token ?? "",
    nonce,
    String(platform || "").trim().toLowerCase(),
    String(deviceFamily || "").trim().toLowerCase(),
  ].join("|");
}

function connectOnce({ identity, token, clientId, clientMode, role, scopes, commands, caps, platform, deviceFamily, origin, deviceToken }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY_URL);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: { code: "TIMEOUT", message: "handshake timeout" } });
    }, 8000);
    const finish = (result) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };
    ws.addEventListener("open", () => {
      if (origin) {
        log("note", "browser Origin cannot be set from the Node WebSocket global; origin check needs Obsidian", token);
      }
    });
    ws.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        const signedAtMs = frame.payload?.ts;
        const payload = authPayload({
          identity, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily,
        });
        const signature = signPayload(identity, payload);
        const params = {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: clientId,
            version: "0.2.0-beta",
            platform,
            deviceFamily,
            mode: clientMode,
            displayName: "Obsidian Agent OS spike",
          },
          role,
          scopes,
          caps,
          commands,
          auth: deviceToken ? { token, deviceToken } : { token },
          device: {
            id: identity.deviceId,
            publicKey: identity.publicKey,
            signature,
            signedAt: signedAtMs,
            nonce,
          },
        };
        ws.send(JSON.stringify({ type: "req", id: "connect-1", method: "connect", params }));
        return;
      }
      if (frame.type === "res" && frame.id === "connect-1") {
        finish(frame.ok
          ? { ok: true, hello: frame.payload }
          : { ok: false, error: frame.error || { code: "CONNECT_FAILED", message: "connect rejected" } });
      }
    });
    ws.addEventListener("error", () => {
      finish({ ok: false, error: { code: "SOCKET", message: "socket error" } });
    });
  });
}

function requestIdFrom(error) {
  const details = error?.details;
  if (details && typeof details === "object") {
    return details.requestId || details.pairingRequestId || details.deviceRequestId || null;
  }
  return null;
}

function approve(kind, requestId) {
  const bin = process.env.OPENCLAW_BIN || "openclaw";
  const args = kind === "device"
    ? ["devices", "approve", requestId]
    : ["nodes", "approve", requestId];
  log("approve", `${bin} ${args.join(" ")}`);
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: 20000 });
  log("approve.exit", result.status);
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (text) log("approve.out", text.slice(0, 500));
  return result.status === 0;
}

async function probeRole({ identity, token, spec }) {
  log("probe", {
    role: spec.role,
    clientId: spec.clientId,
    clientMode: spec.clientMode,
    platform: spec.platform,
    commands: spec.commands || [],
  });
  let result = await connectOnce({ identity, token, ...spec, deviceToken: spec.savedToken });
  log("result", {
    ok: result.ok,
    code: result.error?.code,
    message: result.error?.message,
    details: result.error?.details,
    protocol: result.hello?.protocol,
    authRole: result.hello?.auth?.role,
    scopes: result.hello?.auth?.scopes,
    hasDeviceToken: Boolean(result.hello?.auth?.deviceToken),
    methods: Array.isArray(result.hello?.features?.methods)
      ? result.hello.features.methods.filter((name) => /^(chat|sessions|models|agents|health|node)\./.test(name)).slice(0, 40)
      : undefined,
  }, token);
  const requestId = requestIdFrom(result.error);
  if (!result.ok && requestId) {
    const kind = spec.role === "node" ? "node" : "device";
    if (approve(kind, requestId)) {
      result = await connectOnce({ identity, token, ...spec });
      log("after-approve", {
        ok: result.ok,
        code: result.error?.code,
        message: result.error?.message,
        details: result.error?.details,
        hasDeviceToken: Boolean(result.hello?.auth?.deviceToken),
        scopes: result.hello?.auth?.scopes,
      }, token);
    }
  }
  return result;
}

async function main() {
  const token = loadToken();
  const identity = loadOrCreateIdentity();
  log("device", { deviceId: identity.deviceId, url: GATEWAY_URL });

  const operatorSpecs = [
    { role: "operator", clientId: "webchat-ui", clientMode: "ui", platform: "macos", deviceFamily: "desktop", scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "chat-only-assistant-text"], savedToken: identity.operator?.deviceToken },
    { role: "operator", clientId: "gateway-client", clientMode: "backend", platform: "macos", deviceFamily: "desktop", scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "chat-only-assistant-text"] },
    { role: "operator", clientId: "openclaw-control-ui", clientMode: "ui", platform: "macos", deviceFamily: "desktop", scopes: ["operator.read", "operator.write", "operator.approvals"], caps: ["tool-events"] },
  ];

  let operator = null;
  for (const spec of operatorSpecs) {
    const result = await probeRole({ identity, token, spec });
    if (result.ok) {
      operator = { spec, result };
      if (result.hello?.auth?.deviceToken) {
        identity.operator = {
          clientId: spec.clientId,
          clientMode: spec.clientMode,
          deviceToken: result.hello.auth.deviceToken,
          scopes: result.hello.auth.scopes || spec.scopes,
        };
        saveIdentity(identity);
      }
      break;
    }
    if (result.error?.code && result.error.code !== "INVALID_REQUEST") {
      // pairing/auth failures are informative; keep trying other ids only for schema rejects
      if (!/client|mode|invalid/i.test(`${result.error.code} ${result.error.message || ""}`)) break;
    }
  }

  const nodeSpecs = [
    { role: "node", clientId: "node-host", clientMode: "node", platform: "macos", deviceFamily: "desktop", scopes: [], caps: [], commands: ["mcp.tools.call.v1", "system.notify"], savedToken: identity.node?.deviceToken },
    { role: "node", clientId: "node-host", clientMode: "node", platform: "ios", deviceFamily: "phone", scopes: [], caps: [], commands: ["system.notify"] },
  ];
  for (const spec of nodeSpecs) {
    const result = await probeRole({ identity, token, spec });
    if (result.ok && spec.platform === "macos" && result.hello?.auth?.deviceToken) {
      identity.node = {
        clientId: spec.clientId,
        clientMode: spec.clientMode,
        deviceToken: result.hello.auth.deviceToken,
        scopes: result.hello.auth.scopes || [],
      };
      saveIdentity(identity);
      await publishTools({ identity, token, spec, deviceToken: result.hello.auth.deviceToken });
    }
  }

  if (!operator) log("summary", "operator handshake did not succeed");
  else log("summary", `operator ok via ${operator.spec.clientId}/${operator.spec.clientMode}`);
}

function publishTools({ identity, token, spec, deviceToken }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY_URL);
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, 6000);
    ws.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        const signedAtMs = frame.payload?.ts;
        const payload = authPayload({
          identity,
          clientId: spec.clientId,
          clientMode: spec.clientMode,
          role: "node",
          scopes: [],
          signedAtMs,
          token,
          nonce,
          platform: spec.platform,
          deviceFamily: spec.deviceFamily,
        });
        ws.send(JSON.stringify({
          type: "req",
          id: "connect-node",
          method: "connect",
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: spec.clientId,
              version: "0.2.0-beta",
              platform: spec.platform,
              deviceFamily: spec.deviceFamily,
              mode: spec.clientMode,
              displayName: "AOS vault node spike",
            },
            role: "node",
            scopes: [],
            caps: [],
            commands: spec.commands,
            auth: { token, deviceToken },
            device: {
              id: identity.deviceId,
              publicKey: identity.publicKey,
              signature: signPayload(identity, payload),
              signedAt: signedAtMs,
              nonce,
            },
          },
        }));
        return;
      }
      if (frame.type === "res" && frame.id === "connect-node") {
        log("tools.connect", { ok: frame.ok, code: frame.error?.code, message: frame.error?.message }, token);
        if (!frame.ok) {
          clearTimeout(timer);
          ws.close();
          resolve();
          return;
        }
        ws.send(JSON.stringify({
          type: "req",
          id: "tools-1",
          method: "node.pluginTools.update",
          params: {
            tools: [{
              pluginId: "obsidian-agent-os",
              name: "vault_read",
              description: "Read a vault note",
              command: "mcp.tools.call.v1",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            }],
          },
        }));
        return;
      }
      if (frame.type === "res" && frame.id === "tools-1") {
        log("tools.update", { ok: frame.ok, code: frame.error?.code, message: frame.error?.message, details: frame.error?.details, toolCount: frame.payload?.tools?.length }, token);
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((error) => {
  console.error("spike failed", error instanceof Error ? error.message : "unknown");
  process.exit(1);
});
