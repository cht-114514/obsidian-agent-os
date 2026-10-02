/**
 * Per-device Ed25519 identity for the OpenClaw gateway handshake.
 * Keys stay in the injected store (localStorage on device), never in data.json.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * base64url encode/decode without assuming a browser. Obsidian has `btoa`/`atob`;
 * Node (the Mac gateway service reuses this module) does not.
 */
function toBase64(binary) {
  if (typeof btoa === 'function') return btoa(binary);
  return globalThis.Buffer.from(binary, 'binary').toString('base64');
}

function fromBase64(b64) {
  if (typeof atob === 'function') return atob(b64);
  return globalThis.Buffer.from(b64, 'base64').toString('binary');
}

function bytesToBase64Url(bytes) {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  const b64 = toBase64(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = fromBase64(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function normalizeDeviceMeta(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/**
 * v3 payload verified against OpenClaw 2026.9.7 buildDeviceAuthPayloadV3.
 */
export function buildDeviceAuthPayloadV3(params) {
  const scopes = (params.scopes || []).join(',');
  const token = params.token ?? '';
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    normalizeDeviceMeta(params.platform),
    normalizeDeviceMeta(params.deviceFamily),
  ].join('|');
}

export function createDeviceIdentity() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    deviceId: bytesToHex(sha256(publicKey)),
    publicKey: bytesToBase64Url(publicKey),
    privateKey: bytesToBase64Url(privateKey),
  };
}

export function signDevicePayload(identity, payload) {
  const signature = ed.sign(
    new TextEncoder().encode(payload),
    base64UrlToBytes(identity.privateKey)
  );
  return bytesToBase64Url(signature);
}

export function verifyDeviceSignature(publicKey, payload, signature) {
  return ed.verify(
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
    base64UrlToBytes(publicKey)
  );
}

export function createMemoryStore(initial = {}) {
  const data = { ...initial };
  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    set(key, value) {
      data[key] = value;
    },
    remove(key) {
      delete data[key];
    },
  };
}

export function createLocalStorageStore(storage, prefix) {
  const ns = prefix || 'aos:';
  return {
    get(key) {
      try {
        return storage.getItem(ns + key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      storage.setItem(ns + key, String(value));
    },
    remove(key) {
      storage.removeItem(ns + key);
    },
  };
}

const IDENTITY_KEY = 'deviceIdentity';

export function loadOrCreateIdentity(store) {
  const raw = store.get(IDENTITY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.deviceId && parsed?.publicKey && parsed?.privateKey) return parsed;
    } catch {
      /* regenerate */
    }
  }
  const created = createDeviceIdentity();
  store.set(IDENTITY_KEY, JSON.stringify(created));
  return created;
}

export function readSecret(store, key) {
  const value = store.get(key);
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function writeSecret(store, key, value) {
  const next = String(value || '').trim();
  if (!next) store.remove(key);
  else store.set(key, next);
}
