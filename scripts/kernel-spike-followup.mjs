/**
 * Follow-up probe: republish tools after approval, try a custom command,
 * and simulate an Obsidian Origin header. Never prints secrets.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const STATE_PATH = "/tmp/aos-kernel-spike.json";
const URL = "ws://127.0.0.1:18789";

function token() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).gateway.auth.token.trim();
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function sign(identity, payload) {
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
function payloadOf(identity, { clientId, clientMode, role, scopes, signedAtMs, nonce, platform, deviceFamily, authToken }) {
  return ["v3", identity.deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), authToken ?? "", nonce, String(platform || "").toLowerCase(), String(deviceFamily || "").toLowerCase()].join("|");
}
function log(label, value) {
  console.log(label, JSON.stringify(value));
}

function session({ identity, authToken, role, clientId, clientMode, platform, deviceFamily, commands, origin, onReady }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers: origin ? { Origin: origin } : {} });
    const timer = setTimeout(() => { ws.close(); resolve({ ok: false, error: "timeout" }); }, 8000);
    const done = (result) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } resolve(result); };
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload.nonce;
        const signedAtMs = frame.payload.ts;
        const scopes = role === "node" ? [] : ["operator.read", "operator.write", "operator.approvals"];
        const body = payloadOf(identity, { clientId, clientMode, role, scopes, signedAtMs, nonce, platform, deviceFamily, authToken });
        ws.send(JSON.stringify({
          type: "req", id: "c1", method: "connect",
          params: {
            minProtocol: 4, maxProtocol: 4,
            client: { id: clientId, version: "0.2.0-beta", platform, deviceFamily, mode: clientMode, displayName: "AOS follow-up" },
            role, scopes, caps: role === "node" ? [] : ["tool-events", "chat-only-assistant-text"],
            commands,
            auth: { token: authToken },
            device: { id: identity.deviceId, publicKey: identity.publicKey, signature: sign(identity, body), signedAt: signedAtMs, nonce },
          },
        }));
        return;
      }
      if (frame.type === "res" && frame.id === "c1") {
        if (!frame.ok) {
          done({ ok: false, code: frame.error?.code, message: frame.error?.message, details: frame.error?.details ? { code: frame.error.details.code, reason: frame.error.details.reason, requestId: frame.error.details.requestId } : undefined });
          return;
        }
        Promise.resolve(onReady?.(ws)).then((extra) => done({ ok: true, extra, authScopes: frame.payload?.auth?.scopes, hasDeviceToken: Boolean(frame.payload?.auth?.deviceToken) })).catch((error) => done({ ok: false, error: error.message }));
      }
    });
    ws.on("error", (error) => done({ ok: false, error: error.message }));
  });
}

async function main() {
  const authToken = token();
  const identity = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));

  const published = await session({
    identity, authToken, role: "node", clientId: "node-host", clientMode: "node",
    platform: "macos", deviceFamily: "desktop", commands: ["system.notify"],
    onReady: (ws) => new Promise((resolve) => {
      ws.send(JSON.stringify({
        type: "req", id: "t1", method: "node.pluginTools.update",
        params: { tools: [{ pluginId: "obsidian-agent-os", name: "vault_read", description: "Read a vault note", command: "system.notify", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] },
      }));
      const onMsg = (data) => {
        const frame = JSON.parse(String(data));
        if (frame.id !== "t1") return;
        ws.off("message", onMsg);
        resolve({ ok: frame.ok, code: frame.error?.code, message: frame.error?.message, toolCount: frame.payload?.tools?.length, names: (frame.payload?.tools || []).map((tool) => tool.name) });
      };
      ws.on("message", onMsg);
    }),
  });
  log("republish system.notify", published);

  const custom = await session({
    identity, authToken, role: "node", clientId: "node-host", clientMode: "node",
    platform: "macos", deviceFamily: "desktop", commands: ["system.notify", "vault.read"],
  });
  log("custom command connect", custom);

  const origin = await session({
    identity, authToken, role: "operator", clientId: "webchat-ui", clientMode: "ui",
    platform: "macos", deviceFamily: "desktop", origin: "app://obsidian.md",
  });
  log("webchat origin app://obsidian.md", origin);

  const control = await session({
    identity, authToken, role: "operator", clientId: "openclaw-control-ui", clientMode: "ui",
    platform: "macos", deviceFamily: "desktop", origin: "app://obsidian.md",
  });
  log("control-ui origin app://obsidian.md", control);

  const backendOrigin = await session({
    identity, authToken, role: "operator", clientId: "gateway-client", clientMode: "backend",
    platform: "macos", deviceFamily: "desktop", origin: "app://obsidian.md",
  });
  log("gateway-client with origin", backendOrigin);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
});
