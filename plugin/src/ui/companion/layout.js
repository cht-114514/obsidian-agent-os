const CAPSULE_KEY = 'aos:companion:capsule';
const PANEL_KEY = 'aos:companion:panel';

export function loadCapsulePos() {
  try {
    const raw = localStorage.getItem(CAPSULE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveCapsulePos(pos) {
  try {
    localStorage.setItem(CAPSULE_KEY, JSON.stringify(pos));
  } catch {
    /* */
  }
}

export function loadPanelGeom() {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function savePanelGeom(geom) {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(geom));
  } catch {
    /* */
  }
}

export function defaultCapsulePos(mobile, w, h) {
  if (mobile) return { edge: 'bottom', offset: 88, side: 'right' };
  return { left: Math.max(16, w - 72), top: Math.max(16, h - 88) };
}

export function defaultPanelGeom(mobile, w, h) {
  if (mobile) return { heightPct: 0.6 };
  const width = Math.min(420, w - 32);
  const height = Math.min(520, h - 48);
  return {
    width,
    height,
    left: Math.max(16, w - width - 24),
    top: Math.max(16, h - height - 96),
  };
}
