'use strict';

// Widths are local preferences. The handles work with mouse, touch, and keys.
(() => {
  const workspace = document.getElementById('workspace');
  const outline = document.getElementById('outline-drawer');
  const stage = document.getElementById('dual-stage');
  const split = document.getElementById('split-resizer');
  const textView = document.getElementById('text-view');
  const read = (key, fallback) => {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch { return fallback; }
  };
  const save = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
  const clamp = (value, min, max) => Math.min(Math.max(min, max), Math.max(min, value));

  function handle(label, cssClass) {
    const element = document.createElement('div');
    element.className = `layout-handle ${cssClass}`;
    element.setAttribute('role', 'separator');
    element.setAttribute('aria-label', label);
    element.setAttribute('aria-orientation', 'vertical');
    element.tabIndex = 0;
    element.title = `${label}：拖动调整，双击恢复默认，方向键微调`;
    return element;
  }

  const sideHandle = handle('调整侧栏宽度', 'sidebar-handle');
  const outlineHandle = handle('调整目录宽度', 'outline-handle');
  const textHandle = handle('调整原译段落宽度', 'text-split-handle');
  workspace.append(sideHandle);
  outline.append(outlineHandle);
  textView.prepend(textHandle);

  function applySide(value) {
    const width = clamp(value, 200, Math.min(520, workspace.clientWidth - 320));
    workspace.style.setProperty('--sidebar-width', `${width}px`);
    sideHandle.setAttribute('aria-valuenow', String(Math.round(width)));
    return width;
  }
  function applyOutline(value) {
    const available = outline.parentElement.clientWidth || workspace.clientWidth;
    const width = clamp(value, 160, Math.min(460, available - 300));
    outline.style.setProperty('--outline-width', `${width}px`);
    outlineHandle.setAttribute('aria-valuenow', String(Math.round(width)));
    return width;
  }
  function applySplit(value) {
    const percent = clamp(value, 25, 75);
    stage.style.setProperty('--split-left', `${percent}%`);
    textView.style.setProperty('--split-left', `${percent}%`);
    for (const item of [split, textHandle]) item.setAttribute('aria-valuenow', String(Math.round(percent)));
    return percent;
  }

  function bind(element, key, defaults, minimum, maximum, apply, position) {
    element.setAttribute('aria-valuemin', String(minimum));
    element.setAttribute('aria-valuemax', String(maximum));
    let value = apply(read(key, defaults));
    let pointer = null;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      pointer = event.pointerId;
      element.setPointerCapture(pointer);
      element.classList.add('dragging');
      workspace.classList.add('layout-dragging');
      event.preventDefault();
    });
    element.addEventListener('pointermove', event => {
      if (pointer !== event.pointerId) return;
      value = apply(position(event));
    });
    const finish = event => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      element.classList.remove('dragging');
      workspace.classList.remove('layout-dragging');
      save(key, value);
    };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
    element.addEventListener('dblclick', () => { value = apply(defaults); save(key, value); });
    element.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const delta = event.shiftKey ? 30 : 10;
      const current = Number(element.getAttribute('aria-valuenow')) || value;
      const target = event.key === 'Home' ? minimum : event.key === 'End' ? maximum :
        current + (event.key === 'ArrowRight' ? delta : -delta);
      value = apply(target);
      save(key, value);
    });
  }

  bind(sideHandle, 'paper_studio_sidebar_width', 276, 200, 520, applySide,
    event => event.clientX - workspace.getBoundingClientRect().left);
  bind(outlineHandle, 'paper_studio_outline_width', 230, 160, 460, applyOutline,
    event => event.clientX - outline.getBoundingClientRect().left);
  bind(textHandle, 'paper_studio_split_percent', 50, 25, 75, applySplit,
    event => (event.clientX - textView.getBoundingClientRect().left) / textView.clientWidth * 100);
  split.setAttribute('role', 'separator');
  split.setAttribute('aria-label', '调整原译页面宽度');
  split.setAttribute('aria-orientation', 'vertical');
  split.setAttribute('aria-valuemin', '25');
  split.setAttribute('aria-valuemax', '75');
  split.tabIndex = 0;
  // The existing reader owns pointer dragging on this handle.
  const syncSplit = () => {
    const value = parseFloat(stage.style.getPropertyValue('--split-left')) || 50;
    textView.style.setProperty('--split-left', `${value}%`);
    split.setAttribute('aria-valuenow', String(Math.round(value)));
    textHandle.setAttribute('aria-valuenow', String(Math.round(value)));
    save('paper_studio_split_percent', value);
  };
  split.addEventListener('pointerup', syncSplit);
  split.addEventListener('pointercancel', syncSplit);
  split.addEventListener('dblclick', () => requestAnimationFrame(syncSplit));
  split.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = parseFloat(stage.style.getPropertyValue('--split-left')) || 50;
    const amount = event.shiftKey ? 10 : 2;
    applySplit(event.key === 'Home' ? 25 : event.key === 'End' ? 75 :
      current + (event.key === 'ArrowRight' ? amount : -amount));
    syncSplit();
  });
  window.addEventListener('resize', () => {
    applySide(read('paper_studio_sidebar_width', 276));
    applyOutline(read('paper_studio_outline_width', 230));
  });
})();
