import assert from 'node:assert/strict';
import test from 'node:test';
import { navbarReservePx, resolveMobileKeyboardPx, composerOffsetPx } from '../src/ui/mobile-insets.js';

test('resolveMobileKeyboardPx prefers Obsidian --keyboard-height', () => {
  const style = {
    getPropertyValue(name) {
      if (name === '--keyboard-height') return '280px';
      return '';
    },
  };
  assert.equal(resolveMobileKeyboardPx(style, null, 852), 280);
});

test('resolveMobileKeyboardPx ignores small visualViewport gap (safe area)', () => {
  const style = {
    getPropertyValue(name) {
      if (name === '--keyboard-height') return '0px';
      if (name === '--safe-area-inset-bottom') return '34px';
      return '';
    },
  };
  const viewport = { height: 818, offsetTop: 0 };
  assert.equal(resolveMobileKeyboardPx(style, viewport, 852), 0);
});

test('resolveMobileKeyboardPx treats large visualViewport gap as keyboard', () => {
  const style = {
    getPropertyValue(name) {
      if (name === '--keyboard-height') return '0px';
      if (name === '--safe-area-inset-bottom') return '34px';
      return '';
    },
  };
  const viewport = { height: 500, offsetTop: 0 };
  assert.equal(resolveMobileKeyboardPx(style, viewport, 852), 352);
});

test('composerOffsetPx adds safe area once and drops it while the keyboard is open', () => {
  assert.equal(composerOffsetPx({ keyboardPx: 280, safeBottom: 34, hideNavbar: true }), 288);
  assert.equal(composerOffsetPx({ keyboardPx: 0, safeBottom: 34, hideNavbar: true }), 42);
  assert.equal(composerOffsetPx({ keyboardPx: 0, safeBottom: 34, navStack: 96, hideNavbar: false }), 104);
});

test('resolveMobileKeyboardPx drops a stale keyboard height once the page is full again', () => {
  const style = {
    getPropertyValue(name) {
      if (name === '--keyboard-height') return '320px';
      if (name === '--safe-area-inset-bottom') return '34px';
      return '';
    },
  };
  const viewport = { height: 818, offsetTop: 0 };
  assert.equal(resolveMobileKeyboardPx(style, viewport, 852), 0);
  assert.equal(resolveMobileKeyboardPx(style, null, 852, { focused: false }), 0);
});

test('resolveMobileKeyboardPx follows visualViewport gap instead of stale --keyboard-height', () => {
  const style = {
    getPropertyValue(name) {
      if (name === '--keyboard-height') return '320px';
      if (name === '--safe-area-inset-bottom') return '34px';
      return '';
    },
  };
  const viewport = { height: 500, offsetTop: 0 };
  assert.equal(resolveMobileKeyboardPx(style, viewport, 852), 352);
});

test('navbarReservePx prefers viewport stack over box estimate', () => {
  const rect = { height: 52, top: 693 };
  const style = { display: 'flex', visibility: 'visible', marginBottom: '20px' };
  assert.equal(navbarReservePx(rect, style, 852), 159);
});
