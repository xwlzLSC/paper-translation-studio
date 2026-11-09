'use strict';

(() => {
  const pageWidth = 540;
  const ctx = document.createElement('canvas').getContext('2d');
  const credit = 'Powered by Google Translate';
  const serif = typeof FontFace === 'function'
    ? new FontFace('PaperStudioSerif', 'url("/static/SourceHanSerifCN-Regular.otf")')
    : null;
  const ready = serif ? serif.load().then(face => document.fonts.add(face)).catch(() => {}) : Promise.resolve();

  function font(size, face) {
    const [family, flags] = face;
    return (flags & 2 ? 'italic ' : '') + (flags & 1 ? '700 ' : '400 ') + size + 'px ' +
      (family === 'paper-serif' ? '"PaperStudioSerif", serif' : family);
  }

  function typography(source, kind, language) {
    let [family, flags] = source || [kind === 'heading' ? 'sans-serif' : 'serif', 0];
    if (family === 'serif' && !['ja', 'ko', 'zh-tw'].includes(language)) family = 'paper-serif';
    return [family, flags | (kind === 'heading' ? 1 : 0)];
  }

  function wrap(text, width, size, face, notation = [], sourceHeight = 0) {
    ctx.font = font(size, face);
    const rows = [];
    let runs = [];
    let used = 0;
    let ascent = size * .88;
    let descent = size * .25;

    function flush() {
      if (runs.length) rows.push({runs, ascent, descent});
      runs = [];
      used = 0;
      ascent = size * .88;
      descent = size * .25;
    }

    function writeWord(word, start) {
      if (!runs.length && !word.trim()) return;
      const last = runs[runs.length - 1];
      const joins = last && last.text != null && last.start + last.text.length === start;
      const combined = joins ? last.text + word : word;
      const x = joins ? last.x : used;
      const advance = ctx.measureText(combined).width;
      if (used && x + advance > width) {
        flush();
        if (word.trim()) writeWord(word, start);
        return;
      }
      if (joins) last.text = combined;
      else runs.push({text:word, start, x});
      used = x + advance;
    }

    function writeText(start, end) {
      for (const match of text.slice(start, end).matchAll(/[\u2e80-\u9fff\uac00-\ud7af]|\s+|[^\u2e80-\u9fff\uac00-\ud7af\s]+/gu)) {
        const word = match[0];
        let offset = start + match.index;
        if (ctx.measureText(word).width > width) {
          for (const character of word) {
            writeWord(character, offset);
            offset += character.length;
          }
        } else writeWord(word, offset);
      }
    }

    let offset = 0;
    for (const [start, end, box, baseline, originalSize] of notation) {
      if (start < offset || end <= start || end > text.length || !box?.[2] || !box[3] || !originalSize) continue;
      writeText(offset, start);
      const originalWidth = box[2] * pageWidth;
      const scale = Math.min(size * .88 / (originalSize * pageWidth), width / originalWidth);
      const w = originalWidth * scale;
      const h = box[3] * sourceHeight * scale;
      const above = h * baseline;
      if (used && used + w > width) flush();
      runs.push({box, x:used, start, end, w, h, above});
      used += w;
      ascent = Math.max(ascent, above);
      descent = Math.max(descent, h - above);
      offset = end;
    }
    writeText(offset, text.length);
    flush();
    return rows;
  }

  function totalHeight(rows, gap) {
    return rows.reduce((height, row) => height + row.ascent + row.descent, 0) + Math.max(0, rows.length - 1) * gap;
  }

  function placeRows(model, rows, x, y, size, face, segment, gap) {
    for (const {runs, ascent, descent} of rows) {
      const baseline = y + ascent;
      for (const run of runs) {
        if (run.box) {
          model.crops.push([run.box, x + run.x, baseline - run.above, run.w, run.h, segment, run.start, run.end]);
        } else {
          model.lines.push([run.text, x + run.x, baseline, size, Boolean(face[1] & 1), segment, run.start, face]);
        }
      }
      y += ascent + descent + gap;
    }
    return y;
  }

  function finish(model, height, provider) {
    if (provider === 'offline') {
      model.lines.push([credit, 36, height + 14, 8, false]);
      height += 21;
    }
    model.height = Math.ceil(height);
    return model;
  }

  function textPage(paragraphs, page, kind, provider, language) {
    const model = {sourceHeight:0, lines:[[(kind === 'translated' ? '译文  /  ' : '原文  /  ') + page, 36, 38, 10, true]], masks:[], crops:[]};
    let y = 64;
    if (!paragraphs.some(Boolean)) paragraphs = [kind === 'translated' ? '本页暂无译文。' : '本页没有可读的正文。'];
    paragraphs.forEach((text, index) => {
      if (!text) return;
      const heading = index === 0 && text.length < 90;
      const face = typography(null, heading ? 'heading' : '', language);
      const size = heading ? 17 : 12;
      y = placeRows(model, wrap(text, 468, size, face), 36, y, size, face, index, size * .23) + 10;
    });
    return finish(model, Math.max(695, y + 40), provider);
  }

  function subtract(rect, reserved) {
    const [x, y, w, h] = rect;
    const [a, b, c, d] = reserved;
    const left = Math.max(x, a), top = Math.max(y, b);
    const right = Math.min(x + w, a + c), bottom = Math.min(y + h, b + d);
    if (left >= right || top >= bottom) return [rect];
    return [[x, y, w, top - y], [x, bottom, w, y + h - bottom],
      [x, top, left - x, bottom - top], [right, top, x + w - right, bottom - top]]
      .filter(([, , width, height]) => width > 0 && height > 0);
  }

  function overlay(entry, pairs, provider, language) {
    const sourceHeight = pageWidth * entry.height / entry.width;
    const model = {sourceHeight, lines:[], masks:[], crops:[]};
    const extra = [];
    const toPage = box => box.map((v, i) => v * (i % 2 ? sourceHeight : pageWidth));
    const retained = pairs.flatMap(([original, text], i) => {
      const box = entry.boxes?.[i];
      return box && (!text || entry.kept?.[i] || text === original) ? [toPage(box)] : [];
    });
    pairs.forEach(([original, text], segment) => {
      if (!text || entry.kept?.[segment] || text === original) return;
      const face = typography(entry.typefaces?.[segment], entry.kinds?.[segment], language);
      const notation = entry.pdfNotation?.[segment] || [];
      const box = entry.boxes?.[segment];
      if (!box) { extra.push({text, segment, face, notation}); return; }
      const [x, y, width, height] = toPage(box);
      for (const line of entry.masks?.[segment]?.length ? entry.masks[segment] : [box]) {
        const [left, top, w, h] = toPage(line);
        const side = Math.min(1.8, Math.max(.8, h * .12));
        const above = Math.min(1.8, Math.max(.65, h * .10));
        const below = Math.min(3.4, Math.max(1.45, h * .22));
        let patch = [[left - side, top - above, w + side * 2, h + above + below]];
        for (const reserved of retained) patch = patch.flatMap(rect => subtract(rect, reserved));
        model.masks.push(...patch);
      }
      const heading = entry.kinds?.[segment] === 'heading';
      const size = Math.min(heading ? 22 : 13, Math.max(7.35, (entry.fonts?.[segment] || .016) * pageWidth * (heading ? 1.12 : 1.20)));
      const lower = Math.max(6.25, size * .76);
      const columnWidth = Math.max(8, width - .5);
      for (let fit = size; fit >= lower - .01; fit -= .25) {
        const rows = wrap(text, columnWidth, fit, face, notation, sourceHeight);
        const gap = fit * .10;
        if (rows.length && totalHeight(rows, gap) <= height + fit * .30) {
          placeRows(model, rows, x + .18, y, fit, face, segment, gap);
          return;
        }
      }
      extra.push({text, segment, face, notation});
      if (width >= 12 && height >= 5) model.lines.push(['〔' + extra.length + '〕', x, y + Math.min(7, height), 7, true]);
    });
    let height = sourceHeight;
    if (extra.length) {
      let y = height + 28;
      model.lines.push(['本页补充译文', 36, y, 11, true]);
      y += 9;
      extra.forEach(({text, segment, face, notation}, index) => {
        model.lines.push(['〔' + (index + 1) + '〕', 36, y + 9, 9, true]);
        y = placeRows(model, wrap(text, 442, 11, face, notation, sourceHeight), 62, y, 11, face, segment, 2.5) + 8;
      });
      height = y + 12;
    }
    return finish(model, height, provider);
  }

  function draw(model, requestedWidth, sourceImage) {
    const canvas = document.createElement('canvas');
    const width = Math.min(1500, Math.max(160, requestedWidth || 960));
    const scale = Math.min(width / pageWidth, 6000 / model.height);
    canvas.width = Math.max(1, Math.round(pageWidth * scale));
    canvas.height = Math.max(1, Math.round(model.height * scale));
    const page = canvas.getContext('2d');
    page.scale(canvas.width / pageWidth, canvas.height / model.height);
    page.fillStyle = '#fff';
    page.fillRect(0, 0, pageWidth, model.height);
    if (sourceImage) {
      page.drawImage(sourceImage, 0, 0, pageWidth, model.sourceHeight);
      for (const [x, y, w, h] of model.masks) page.fillRect(x, y, w, h);
      for (const [[left, top, width, height], x, y, w, h] of model.crops || []) {
        page.drawImage(sourceImage, left * sourceImage.naturalWidth, top * sourceImage.naturalHeight,
          width * sourceImage.naturalWidth, height * sourceImage.naturalHeight, x, y, w, h);
      }
    }
    page.fillStyle = '#202633';
    for (const [text, x, y, size, bold, , , face = ['sans-serif', bold ? 1 : 0]] of model.lines) {
      page.font = font(size, face);
      page.fillText(text, x, y);
    }
    return canvas;
  }

  function boxes(model, hits) {
    const rects = [];
    const matchIds = [];
    for (const [text, x, y, size, bold, segment, offset, face = ['sans-serif', bold ? 1 : 0]] of model.lines) {
      for (const hit of hits) {
        if (hit.segment !== segment || hit.end <= offset || hit.start >= offset + text.length) continue;
        const a = Math.max(0, hit.start - offset);
        const b = Math.min(text.length, hit.end - offset);
        ctx.font = font(size, face);
        rects.push([(x + ctx.measureText(text.slice(0, a)).width) / pageWidth,
          (y - size) / model.height, ctx.measureText(text.slice(a, b)).width / pageWidth, size * 1.25 / model.height]);
        matchIds.push(hit.match_index);
      }
    }
    for (const [, x, y, w, h, segment, start, end] of model.crops || []) {
      for (const hit of hits) {
        if (hit.segment === segment && hit.end > start && hit.start < end) {
          rects.push([x / pageWidth, y / model.height, w / pageWidth, h / model.height]);
          matchIds.push(hit.match_index);
        }
      }
    }
    return {boxes:rects, match_ids:matchIds, aspect:pageWidth / model.height};
  }

  window.PaperPageLayout = {pageWidth, ready, textPage, overlay, draw, boxes};
})();
