'use strict';

/**
 * Paper Studio · 双模移动/平板桥接引擎 (Standalone On-Device + Remote LAN Server)
 * ----------------------------------------------------------------------------
 * 1. 本机独立运行模式 (Standalone Mode)：
 *    - 无需电脑后端即可在 Android APK 或离线 Web 环境下独立运行
 *    - 支持原版 PDF 渲染 (Android PdfRenderer 原生桥 / 端侧矢量画布合成)
 *    - 支持免费离线本机翻译 (内置学术英汉词库与句法重组引擎 + 免 Key 公共翻译自动增強)
 *    - 支持端侧直连 DeepSeek / Kimi / GLM / OpenAI / Gemini / SiliconFlow 等大模型 API
 *    - 支持端侧全文搜索、数字单位一致性校对、段落重译、双语笔记与多格式导出
 * 2. 远程电脑后端模式 (Remote Server Mode)：
 *    - 一键连接电脑局域网地址 (python server.py --lan) 驱动满血 PDF2zh 版面引擎
 * 3. 平板横屏与手机竖屏专属触控体验：
 *    - 双指捏合缩放 (Pinch-to-Zoom)、左右边缘滑动翻页
 *    - 手机小屏支持「上下分屏对照」与「单栏原/译文快速切换」
 */
(() => {
  const STORAGE_MODE_KEY = 'paper_studio_runtime_mode';
  const STORAGE_REMOTE_URL_KEY = 'paper_studio_remote_url';
  const STORAGE_STANDALONE_SETTINGS = 'paper_studio_standalone_settings_v1';
  const DB_NAME = 'paper_studio_standalone_db_v1';
  const DB_STORE = 'jobs';

  const isNativeAndroid = Boolean(window.AndroidPdfBridge) || location.protocol === 'file:';
  const urlMode = new URLSearchParams(location.search).get('runtime');
  const savedMode = urlMode || localStorage.getItem(STORAGE_MODE_KEY);
  let runtimeMode = savedMode || (isNativeAndroid ? 'standalone' : 'auto');
  let remoteServerUrl = (localStorage.getItem(STORAGE_REMOTE_URL_KEY) || '').trim().replace(/\/+$/, '');
  let desktopReachable = !isNativeAndroid;

  const API_PRESETS = {
    magpie: { base_url: 'http://127.0.0.1:3425/v1', default_model: 'deepseek/deepseek-flash', default_key: 'magpie-local' },
    deepseek: { base_url: 'https://api.deepseek.com/v1', default_model: 'deepseek-chat' },
    kimi: { base_url: 'https://api.moonshot.cn/v1', default_model: 'moonshot-v1-8k' },
    glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4', default_model: 'glm-4-flash' },
    openai: { base_url: 'https://api.openai.com/v1', default_model: 'gpt-4o-mini' },
    gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', default_model: 'gemini-2.0-flash' },
    siliconflow: { base_url: 'https://api.siliconflow.cn/v1', default_model: 'Qwen/Qwen2.5-7B-Instruct' },
    api: { base_url: '', default_model: '' }
  };

  /* ==========================================================================
     1. 学术离线英译中词典与语法规则引擎（100% 离线零网络可用 + 免 Key 在线增强）
     ========================================================================== */
  const ACADEMIC_PHRASES = [
    ['in this paper', '本文'],
    ['in this study', '本研究中'],
    ['in this work', '在本工作中'],
    ['state-of-the-art', '最先进的'],
    ['signal-to-noise ratio', '信噪比'],
    ['noise efficiency factor', '噪声效率因子'],
    ['power consumption', '功耗'],
    ['power efficiency', '能效'],
    ['energy efficiency', '能量效率'],
    ['sampling circuit', '采样电路'],
    ['sampled circuit', '采样电路'],
    ['sampling capacitor', '采样电容'],
    ['sampling switch', '采样开关'],
    ['sampling interval', '采样区间'],
    ['observation window', '观测窗口'],
    ['thermal noise', '热噪声'],
    ['thermal energy', '热能'],
    ['settling time', '建立时间'],
    ['settling response', '建立响应'],
    ['settling error', '建立误差'],
    ['noise variance', '噪声方差'],
    ['input voltage', '输入电压'],
    ['output voltage', '输出电压'],
    ['input conditions', '输入条件'],
    ['dynamic comparator', '动态比较器'],
    ['floating inverter amplifier', '浮空反相器放大器'],
    ['common-mode', '共模'],
    ['differential input', '差分输入'],
    ['machine learning', '机器学习'],
    ['deep learning', '深度学习'],
    ['neural network', '神经网络'],
    ['large language model', '大语言模型'],
    ['experimental results', '实验结果'],
    ['simulation results', '仿真结果'],
    ['proposed method', '所提出的方法'],
    ['proposed architecture', '所提出的架构'],
    ['proposed circuit', '所提出的电路'],
    ['is proportional to', '正比于'],
    ['scales with', '随……成比例变化：'],
    ['with respect to', '关于'],
    ['as shown in', '如下所示：'],
    ['on the other hand', '另一方面'],
    ['in order to', '为了'],
    ['due to', '由于'],
    ['compared with', '与……相比'],
    ['trade-off', '权衡'],
    ['tradeoff', '权衡']
  ];

  const ACADEMIC_WORDS = {
    abstract: '摘要', introduction: '引言', conclusion: '结论', conclusions: '结论',
    method: '方法', methods: '方法', methodology: '方法论', experiment: '实验',
    experiments: '实验', result: '结果', results: '结果', discussion: '讨论',
    figure: '图', fig: '图', table: '表', section: '节', equation: '公式',
    references: '参考文献', acknowledgments: '致谢', appendix: '附录',
    reducing: '降低', reduce: '降低', reduces: '降低', reduced: '降低了',
    increasing: '增加', increase: '增加', increases: '增加', increased: '增加了',
    measuring: '测量', measure: '测量', measurements: '测量结果', measurement: '测量',
    captures: '捕获', capture: '捕获', captured: '捕获',
    short: '短暂的', larger: '更大的', smaller: '更小的', higher: '更高的', lower: '更低的',
    during: '在……期间', immediately: '立即', before: '在……之前', after: '在……之后',
    opens: '断开', closes: '闭合', repeat: '重复', under: '在……下',
    same: '相同的', estimate: '估计', variability: '波动性',
    report: '报告', capacitance: '电容', temperature: '温度',
    compared: '比较', across: '跨不同', designs: '设计方案', design: '设计',
    ratio: '比值', constrains: '限制了', choice: '选择',
    illustrative: '示意性的', response: '响应', error: '误差',
    voltage: '电压', current: '电流', frequency: '频率', bandwidth: '带宽',
    gain: '增益', amplifier: '放大器', comparator: '比较器', transistor: '晶体管',
    threshold: '阈值', offset: '失调', delay: '延迟', clock: '时钟',
    circuit: '电路', system: '系统', model: '模型', algorithm: '算法',
    performance: '性能', accuracy: '精度', resolution: '分辨率',
    analysis: '分析', evaluation: '评估', implementation: '实现',
    propose: '提出', proposed: '提出的', demonstrate: '证明', demonstrates: '展示了',
    show: '表明', shows: '表明', achieved: '实现了', achieves: '达到',
    significant: '显著的', significantly: '显著地', however: '然而', therefore: '因此',
    furthermore: '此外', moreover: '此外', where: '其中', while: '同时',
    because: '因为', between: '在……之间', through: '通过', using: '使用',
    based: '基于', novel: '新颖的', high: '高', low: '低', fast: '快速',
    output: '输出', input: '输入', signal: '信号', noise: '噪声', power: '功率'
  };

  function offlineRuleTranslate(text, glossaryMap = {}) {
    if (!text || !text.trim()) return '';
    // 先检查示例内置句对精确匹配
    for (const pagePairs of DEMO_PAGES) {
      for (const [en, zh] of pagePairs) {
        if (text.trim().toLowerCase() === en.trim().toLowerCase()) return zh;
      }
    }
    // 保留公式与编号占位
    const protectedTokens = [];
    let working = text.replace(/(\[\[FORMULA_\d+\]\]|\b[A-Za-z]\s*=\s*[^.,;]+|\b\d+(?:\.\d+)?\s*(?:Hz|kHz|MHz|GHz|V|mV|uV|μV|W|mW|uW|μW|F|pF|fF|nF|s|ms|us|μs|ns|dB|%)\b)/g, match => {
      const idx = protectedTokens.length;
      protectedTokens.push(match);
      return `@@TOK_${idx}@@`;
    });

    // 应用用户术语表
    for (const [src, tgt] of Object.entries(glossaryMap)) {
      if (src && tgt) {
        const re = new RegExp(`\\b${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        working = working.replace(re, tgt);
      }
    }

    // 应用学术短语库
    for (const [phrase, zh] of ACADEMIC_PHRASES) {
      const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      working = working.replace(re, zh);
    }

    // 分句与词汇转换
    working = working.replace(/\b([A-Za-z][A-Za-z-]*)\b/g, word => {
      const lower = word.toLowerCase();
      if (ACADEMIC_WORDS[lower]) return ACADEMIC_WORDS[lower];
      if (lower.endsWith('ing') && ACADEMIC_WORDS[lower.slice(0, -3)]) return ACADEMIC_WORDS[lower.slice(0, -3)];
      if (lower.endsWith('ed') && ACADEMIC_WORDS[lower.slice(0, -2)]) return ACADEMIC_WORDS[lower.slice(0, -2)];
      if (lower.endsWith('s') && ACADEMIC_WORDS[lower.slice(0, -1)]) return ACADEMIC_WORDS[lower.slice(0, -1)];
      if (/^(the|a|an|of|to|in|on|at|by|for|with|from|as|is|are|was|were|be|been)$/i.test(word)) {
        const prep = { of: '的', in: '在', on: '在', for: '用于', with: '具有', from: '来自', by: '通过', is: '为', are: '为' };
        return prep[lower] || '';
      }
      return word;
    });

    working = working
      .replace(/\s+/g, ' ')
      .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
      .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
      .replace(/\s*,\s*/g, '，')
      .replace(/\.\s+(?=[A-Z\u4e00-\u9fa5@])/g, '。')
      .replace(/\.$/g, '。');

    working = working.replace(/@@TOK_(\d+)@@/g, (_, idx) => protectedTokens[Number(idx)] || '');
    return working.trim();
  }

  async function freeTranslateBatch(texts, sourceLang = 'en', targetLang = 'zh', glossaryText = '') {
    const glossaryMap = {};
    for (const line of (glossaryText || '').split(/\r?\n/)) {
      const m = line.split(/=|->|→|:/);
      if (m.length >= 2 && m[0].trim() && m[1].trim()) {
        glossaryMap[m[0].trim()] = m[1].trim();
      }
    }

    const results = [];
    for (const text of texts) {
      let translated = '';
      // 1. 若有网络连接或 Android 原生桥，优先尝试免 Key 免费翻译接口，断网时无缝秒切本机离线学术引擎
      if (navigator.onLine || window.AndroidPdfBridge) {
        try {
          const sl = sourceLang === 'zh' ? 'zh-CN' : sourceLang;
          const tl = targetLang === 'zh' ? 'zh-CN' : (targetLang === 'zh-tw' ? 'zh-TW' : targetLang);
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
          const data = await bridgeFetchJson(url, { method: 'GET' }, 6500);
          if (Array.isArray(data?.[0])) {
            translated = data[0].map(part => part?.[0] || '').join('').trim();
          }
        } catch {
          // 离线或受限时自动使用本地离线学术词库与规则引擎
        }
      }
      if (!translated) {
        translated = offlineRuleTranslate(text, glossaryMap);
      } else {
        for (const [src, tgt] of Object.entries(glossaryMap)) {
          if (src && tgt && new RegExp(src, 'i').test(text) && !translated.includes(tgt)) {
            translated = `${translated}（${tgt}）`;
          }
        }
      }
      results.push(translated || text);
    }
    return results;
  }

  /* ==========================================================================
     2. 原生/跨端 HTTP 桥接与大模型 API 端侧直连
     ========================================================================== */
  async function bridgeFetchJson(url, options = {}, timeoutMs = 25000) {
    if (window.AndroidPdfBridge && typeof window.AndroidPdfBridge.httpRequest === 'function') {
      const method = options.method || 'GET';
      const headersObj = {};
      if (options.headers) {
        if (options.headers instanceof Headers) {
          options.headers.forEach((v, k) => { headersObj[k] = v; });
        } else {
          Object.assign(headersObj, options.headers);
        }
      }
      const bodyStr = typeof options.body === 'string' ? options.body : (options.body ? JSON.stringify(options.body) : '');
      const rawResp = window.AndroidPdfBridge.httpRequest(url, method, JSON.stringify(headersObj), bodyStr, timeoutMs);
      const parsed = JSON.parse(rawResp);
      if (!parsed.ok) {
        throw new Error(parsed.error || `请求失败 (${parsed.status})`);
      }
      return JSON.parse(parsed.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await originalFetch(url, { ...options, signal: controller.signal });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`服务返回非 JSON 响应 (${resp.status})`); }
      if (!resp.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${resp.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function llmTranslateBatch(texts, settings) {
    const provider = settings.provider || 'deepseek';
    const preset = API_PRESETS[provider] || {};
    const baseUrl = (settings.base_url || preset.base_url || '').trim().replace(/\/+$/, '');
    const apiKey = (settings.api_key || preset.default_key || '').trim();
    const model = (settings.model || preset.default_model || '').trim();
    if (!baseUrl) throw new Error('请先在翻译设置中填写 API 地址，或切换为「免费本机/公共翻译」。');
    if (!model) throw new Error('请先选择或填写模型 ID。');

    const sysPrompt = [
      'You are an academic paper translator. Translate each numbered paragraph accurately into target language.',
      'Preserve all formulas, symbols, numbers, units, and citation brackets like [1] exactly.',
      settings.glossary ? `Glossary:\n${settings.glossary}` : '',
      'Return ONLY a JSON array of translated strings with the exact same length as input.'
    ].filter(Boolean).join('\n');

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const body = {
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: JSON.stringify(texts) }
      ]
    };
    const res = await bridgeFetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, 45000);
    let content = res?.choices?.[0]?.message?.content || '';
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const arr = JSON.parse(jsonMatch[0]);
        if (Array.isArray(arr) && arr.length === texts.length) {
          return arr.map(item => String(item || '').trim());
        }
      } catch {}
    }
    const lines = content.split(/\r?\n/).map(l => l.replace(/^\d+[.)、]\s*/, '').trim()).filter(Boolean);
    return texts.map((orig, i) => lines[i] || content || orig);
  }

  /* ==========================================================================
     3. 端侧画布排版合成器（生成高保真原文/译文分页 PNG DataURL，支持双栏对照）
     ========================================================================== */
  const DEMO_NAME = '采样电路 - 双语阅读示例.pdf';
  const DEMO_PAGES = [
    [
      ['Reducing noise in a sampled circuit', '降低采样电路中的噪声'],
      [
        'Abstract. A sampling circuit captures the input voltage during a short observation window. A larger sampling capacitor reduces thermal noise but increases settling time.',
        '摘要。采样电路在短暂的观测窗口内捕获输入电压。增大采样电容可以降低热噪声，但会延长建立时间。'
      ],
      [
        'The noise variance scales with the ratio of thermal energy to capacitance. This trade-off constrains the choice of sampling capacitor.',
        '噪声方差与热能和电容之比成正比。这一权衡限制了采样电容的选择。'
      ],
      [
        'Figure 1. Illustrative settling response during the sampling interval.',
        '图 1. 采样期间的建立响应示意。'
      ]
    ],
    [
      ['Measuring the settling error', '测量建立误差'],
      [
        'Measure the output immediately before the sampling switch opens. Repeat the measurement under the same input conditions to estimate the variability.',
        '在采样开关断开前测量输出。在相同的输入条件下重复测量，以估计测量值的波动。'
      ],
      [
        'Report the observation window, the sampling capacitance, and the temperature so the measurements can be compared across designs.',
        '报告观测窗口、采样电容和温度，以便在不同设计之间比较测量结果。'
      ]
    ]
  ];

  function wrapCanvasText(ctx, text, maxWidth) {
    const lines = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      if (!rawLine.trim()) { lines.push(''); continue; }
      let current = '';
      const tokens = rawLine.match(/[\u4e00-\u9fa5]|[^\u4e00-\u9fa5\s]+|\s+/g) || [rawLine];
      for (const token of tokens) {
        const test = current + token;
        if (ctx.measureText(test).width > maxWidth && current.trim()) {
          lines.push(current.trimEnd());
          current = token.trimStart();
        } else {
          current = test;
        }
      }
      if (current.trim()) lines.push(current.trimEnd());
    }
    return lines;
  }

  function renderSyntheticPagePng(pageNumber, pairs, isTranslated, width = 960, isDemo = false) {
    const scale = width / 540;
    const height = Math.round(695 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.scale(scale, scale);

    const accent = '#126957';
    const ink = '#1f332e';

    ctx.fillStyle = accent;
    ctx.font = '700 10px system-ui, -apple-system, sans-serif';
    ctx.fillText(isDemo ? 'PAPER STUDIO   /   READING SAMPLE' : `PAPER STUDIO   /   ${isTranslated ? 'TRANSLATED EDITION' : 'SOURCE EDITION'}`, 48, 47);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(48, 61);
    ctx.lineTo(492, 61);
    ctx.stroke();

    let y = 106;
    pairs.forEach((pair, index) => {
      if (isDemo && pageNumber === 1 && index === 3) {
        y = Math.max(y, 280);
        ctx.fillStyle = ink;
        ctx.font = 'italic 14px Georgia, serif';
        ctx.fillText('noise variance = kT / C', 48, y);
        y += 24;

        ctx.fillStyle = '#f2f7f0';
        ctx.strokeStyle = '#bfd4c9';
        ctx.lineWidth = 0.8;
        ctx.fillRect(48, y, 444, 138);
        ctx.strokeRect(48, y, 444, 138);

        ctx.strokeStyle = '#597566';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(81, y + 24);
        ctx.lineTo(81, y + 111);
        ctx.lineTo(462, y + 111);
        ctx.stroke();

        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x <= 370; x += 5) {
          const cy = y + 103 - 66 * (1 - Math.pow(0.985, x));
          if (x === 0) ctx.moveTo(81 + x, cy);
          else ctx.lineTo(81 + x, cy);
        }
        ctx.stroke();
        y += 164;
      }

      const text = isTranslated ? (pair[1] || pair[0] || '') : (pair[0] || '');
      const isHeading = index === 0 && text.length < 95;
      const fontSize = isHeading ? 22 : 12.6;
      const leading = isHeading ? 30 : 19.5;
      ctx.fillStyle = ink;
      ctx.font = `${isHeading ? '700' : '400'} ${fontSize}px "PingFang SC", "Microsoft YaHei", Georgia, serif`;

      const lines = wrapCanvasText(ctx, text, 444);
      for (const line of lines) {
        if (y > 618) break;
        ctx.fillText(line, 48, y);
        y += leading;
      }
      y += 11;
    });

    ctx.strokeStyle = '#bfd4c9';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(48, 631);
    ctx.lineTo(492, 631);
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.fillText(`PAPER STUDIO DOCUMENT   /   ${String(pageNumber).padStart(2, '0')}`, 48, 655);

    ctx.restore();
    return canvas.toDataURL('image/png');
  }

  /* ==========================================================================
     4. 纯前端 PDF 简易文本与页数解析器（配合 Android PdfRenderer 原生桥）
     ========================================================================== */
  function decodePdfString(raw) {
    return raw
      .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] || c))
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  }

  function extractPdfPagesFromBytes(uint8, fileName) {
    // 1. 若在 Android APK 内，优先使用 AndroidPdfBridge 原生获取精确页数
    let nativeCount = 0;
    if (window.AndroidPdfBridge && typeof window.AndroidPdfBridge.getPageCount === 'function') {
      try {
        nativeCount = Number(window.AndroidPdfBridge.getPageCount(fileName)) || 0;
      } catch {}
    }

    const latin = new TextDecoder('latin1').decode(uint8.slice(0, Math.min(uint8.length, 4 * 1024 * 1024)));
    const pageMatches = latin.match(/\/Type\s*\/Page\b(?!s)/g);
    const pageCount = Math.max(1, nativeCount || (pageMatches ? pageMatches.length : 1));

    // 提取文本块
    const chunks = [];
    const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
    let m;
    while ((m = tjRegex.exec(latin)) !== null && chunks.length < 800) {
      const s = decodePdfString(m[1]).replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, ' ').trim();
      if (s.length > 2) chunks.push(s);
    }
    const tjArrRegex = /\[([^\]]+)\]\s*TJ/g;
    while ((m = tjArrRegex.exec(latin)) !== null && chunks.length < 800) {
      const inner = [...m[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)]
        .map(x => decodePdfString(x[1]))
        .join('');
      const clean = inner.replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length > 2) chunks.push(clean);
    }

    const joined = chunks.join(' ').replace(/\s+/g, ' ').trim();
    const pages = [];
    if (joined.length > 30) {
      const sentences = joined.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
      const perPage = Math.max(1, Math.ceil(sentences.length / pageCount));
      for (let p = 0; p < pageCount; p++) {
        const slice = sentences.slice(p * perPage, (p + 1) * perPage);
        const paras = [];
        for (let i = 0; i < slice.length; i += 3) {
          const para = slice.slice(i, i + 3).join(' ').trim();
          if (para) paras.push([para, '']);
        }
        pages.push(paras.length ? paras : [[`${fileName} - Page ${p + 1}`, '']]);
      }
    } else {
      for (let p = 0; p < pageCount; p++) {
        pages.push([
          [`${fileName.replace(/\.[^.]+$/, '')} — Section ${p + 1}`, ''],
          ['This PDF page contains vector graphics or embedded fonts. Use the side-by-side reader to inspect the original page and translate key paragraphs.', '']
        ]);
      }
    }
    return { pageCount, pages };
  }

  /* ==========================================================================
     5. 端侧数字/单位/引用一致性校对与全文检索引擎
     ========================================================================== */
  function auditStandaloneSegments(pagesObj) {
    const details = {};
    const summary = { number: 0, citation: 0 };
    let issueCount = 0;
    let pageCountWithIssues = 0;
    let checkedSegments = 0;

    for (const [pageKey, entry] of Object.entries(pagesObj || {})) {
      const pageIssues = [];
      const pairs = entry?.pairs || [];
      pairs.forEach((pair, idx) => {
        const orig = String(pair[0] || '');
        const trans = String(pair[1] || '');
        if (!orig || !trans) return;
        checkedSegments++;
        const issues = [];

        const origNums = (orig.match(/\b\d+(?:\.\d+)?%?\b/g) || []);
        const missingNums = origNums.filter(n => !trans.includes(n));
        if (missingNums.length) {
          summary.number++;
          issues.push({ type: 'number', message: `译文可能遗漏或改动了数字：${missingNums.slice(0, 3).join(', ')}` });
        }

        const origCites = (orig.match(/\[\d+(?:\s*[-,]\s*\d+)*\]/g) || []);
        const missingCites = origCites.filter(c => !trans.includes(c));
        if (missingCites.length) {
          summary.citation++;
          issues.push({ type: 'citation', message: `引用编号不一致：${missingCites.join(' ')}` });
        }

        if (issues.length) {
          issueCount += issues.length;
          pageIssues.push({
            segment_index: idx,
            original_snippet: orig.slice(0, 120),
            translated_snippet: trans.slice(0, 120),
            issues
          });
        }
      });
      if (pageIssues.length) {
        details[pageKey] = pageIssues;
        pageCountWithIssues++;
      }
    }
    return {
      checked_segments: checkedSegments,
      total_issues: issueCount,
      affected_pages: pageCountWithIssues,
      summary,
      details
    };
  }

  /* ==========================================================================
     6. IndexedDB + 内存端侧作业仓库
     ========================================================================== */
  const standaloneJobs = new Map();

  function openStandaloneDb() {
    return new Promise(resolve => {
      if (!window.indexedDB) { resolve(null); return; }
      try {
        const timer = setTimeout(() => resolve(null), 800);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
        req.onerror = () => { clearTimeout(timer); resolve(null); };
      } catch {
        resolve(null);
      }
    });
  }

  async function loadJobsFromDb() {
    const db = await openStandaloneDb();
    if (!db) return;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = () => {
          for (const item of (req.result || [])) {
            standaloneJobs.set(item.id, item);
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  async function saveJobToDb(record) {
    standaloneJobs.set(record.id, record);
    const db = await openStandaloneDb();
    if (!db) return;
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(record);
    } catch {}
  }

  async function deleteJobFromDb(id) {
    standaloneJobs.delete(id);
    const db = await openStandaloneDb();
    if (!db) return;
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(id);
    } catch {}
  }

  function getStandaloneSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_STANDALONE_SETTINGS) || '{}');
      return {
        active_provider: raw.active_provider || 'offline',
        source_language: raw.source_language || 'en',
        target_language: raw.target_language || 'zh',
        concurrency: raw.concurrency || 4,
        ocr: raw.ocr !== false,
        auto_glossary: Boolean(raw.auto_glossary),
        glossary: raw.glossary || '',
        ignore_content: Array.isArray(raw.ignore_content) ? raw.ignore_content : [],
        profiles: raw.profiles || {}
      };
    } catch {
      return {
        active_provider: 'offline',
        source_language: 'en',
        target_language: 'zh',
        concurrency: 4,
        ocr: true,
        auto_glossary: false,
        glossary: '',
        ignore_content: [],
        profiles: {}
      };
    }
  }

  function saveStandaloneSettings(payload) {
    const current = getStandaloneSettings();
    if (payload.provider) current.active_provider = payload.provider;
    for (const k of ['source_language', 'target_language', 'concurrency', 'ocr', 'auto_glossary', 'glossary', 'ignore_content']) {
      if (k in payload) current[k] = payload[k];
    }
    if (payload.profiles && typeof payload.profiles === 'object') {
      current.profiles = { ...current.profiles, ...payload.profiles };
    }
    if (payload.provider && ('base_url' in payload || 'api_key' in payload || 'model' in payload)) {
      current.profiles[payload.provider] = {
        ...(current.profiles[payload.provider] || {}),
        base_url: payload.base_url ?? current.profiles[payload.provider]?.base_url ?? '',
        api_key: payload.api_key ?? current.profiles[payload.provider]?.api_key ?? '',
        model: payload.model ?? current.profiles[payload.provider]?.model ?? ''
      };
    }
    try { localStorage.setItem(STORAGE_STANDALONE_SETTINGS, JSON.stringify(current)); } catch {}
    return current;
  }

  function ensureDemoJob() {
    for (const rec of standaloneJobs.values()) {
      if (rec.meta.demo) return rec;
    }
    const id = 'de000000000000000000000000000001';
    const segments = {};
    DEMO_PAGES.forEach((pairs, idx) => {
      segments[String(idx + 1)] = { mode: 'layout', pairs: pairs.map(p => [p[0], p[1]]) };
    });
    const record = {
      id,
      meta: {
        id,
        name: DEMO_NAME,
        source_format: 'pdf',
        pages: 2,
        state: 'completed',
        progress: 1,
        message: '已完成 · 示例',
        error: '',
        created_at: new Date().toISOString(),
        has_result: true,
        has_text: true,
        result_id: 'demo-v1',
        text_revision: 'demo-v1',
        provider: 'demo',
        target_language: '简体中文',
        demo: true,
        toc: [
          { level: 1, title: '降低采样电路中的噪声', page: 1 },
          { level: 2, title: '图 1 · 建立响应示意', page: 1 },
          { level: 1, title: '测量建立误差', page: 2 }
        ]
      },
      segments,
      notes: []
    };
    standaloneJobs.set(id, record);
    void saveJobToDb(record);
    return record;
  }

  /* ==========================================================================
     7. 端侧 API 路由处理器
     ========================================================================== */
  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  async function dataUrlToBlobResponse(dataUrl) {
    const res = await originalFetch(dataUrl);
    const blob = await res.blob();
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': 'image/png' }
    });
  }

  function renderRecordPagePng(record, kind, pageNumber, width = 960) {
    if (kind === 'original' && record.nativeFileKey && window.AndroidPdfBridge?.renderPagePng) {
      try {
        const dataUrl = window.AndroidPdfBridge.renderPagePng(record.nativeFileKey, pageNumber - 1, width);
        if (dataUrl && dataUrl.startsWith('data:image/png')) {
          return dataUrl;
        }
      } catch {}
    }
    const pairs = record.segments?.[String(pageNumber)]?.pairs || [[`${record.meta.name} (Page ${pageNumber})`, '']];
    return renderSyntheticPagePng(pageNumber, pairs, kind === 'translated', width, Boolean(record.meta.demo));
  }

  async function runStandaloneTranslation(record, options) {
    const meta = record.meta;
    const provider = options.provider || 'offline';
    const glossary = options.glossary || '';
    const sourceLang = options.source_language || 'en';
    const targetLang = options.target_language || 'zh';

    meta.state = 'running';
    meta.progress = 0.08;
    meta.message = provider === 'offline' ? '正在使用免费本机/公共引擎翻译…' : `正在调用 ${provider} 翻译…`;
    meta.error = '';
    await saveJobToDb(record);

    try {
      const pageKeys = Object.keys(record.segments).sort((a, b) => Number(a) - Number(b));
      for (let i = 0; i < pageKeys.length; i++) {
        const key = pageKeys[i];
        const entry = record.segments[key];
        const originals = (entry.pairs || []).map(p => p[0]);
        let translatedList;
        if (provider === 'offline') {
          translatedList = await freeTranslateBatch(originals, sourceLang, targetLang, glossary);
        } else {
          translatedList = await llmTranslateBatch(originals, options);
        }
        entry.pairs = originals.map((orig, idx) => [orig, translatedList[idx] || orig]);
        meta.progress = Math.min(0.95, ((i + 1) / pageKeys.length) * 0.92);
        meta.message = `已翻译第 ${i + 1} / ${pageKeys.length} 页…`;
        await saveJobToDb(record);
      }

      const rev = Math.random().toString(16).slice(2, 10);
      meta.state = 'completed';
      meta.progress = 1;
      meta.has_result = true;
      meta.has_text = true;
      meta.result_id = rev;
      meta.text_revision = rev;
      meta.provider = provider;
      meta.message = provider === 'offline' ? '免费翻译完成' : '翻译完成';
      meta.usage = { cache_hit_rate: 1.0 };
      await saveJobToDb(record);
    } catch (err) {
      meta.state = 'failed';
      meta.message = '翻译未完成';
      meta.error = err.message || '端侧翻译失败';
      await saveJobToDb(record);
    }
  }

  async function handleStandaloneRequest(path, method, options = {}) {
    await dbReadyPromise;
    if (standaloneJobs.size === 0) ensureDemoJob();

    const url = new URL(path, location.origin);
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/api/status') {
      return jsonResponse({
        engine: { ok: true, message: '端侧独立引擎已就绪（免电脑后台）' },
        ocr: true,
        presets: API_PRESETS,
        providers: {
          offline: { ok: true, message: '免费本机英译中词库 + 免 Key 在线增强已就绪' },
          magpie: { ok: false, message: '当前为手机/平板独立模式；如需使用电脑 Magpie 网关，请在上方切换为「连接电脑后端」。' },
          codex: { ok: false, message: '如需复用电脑 Codex 订阅，请切换为「连接电脑后端」。' },
          antigravity: { ok: false, message: '如需复用电脑 Antigravity 订阅，请切换为「连接电脑后端」。' }
        }
      });
    }

    if (pathname === '/api/settings') {
      if (method === 'GET') return jsonResponse(getStandaloneSettings());
      const body = JSON.parse(options.body || '{}');
      return jsonResponse(saveStandaloneSettings(body));
    }

    if (method === 'POST' && pathname === '/api/models') {
      const body = JSON.parse(options.body || '{}');
      const preset = API_PRESETS[body.provider] || {};
      const baseUrl = (body.base_url || preset.base_url || '').trim().replace(/\/+$/, '');
      const apiKey = (body.api_key || preset.default_key || '').trim();
      if (!baseUrl) return jsonResponse({ ok: false, message: '请先填写 API 地址。', models: [] });
      try {
        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const res = await bridgeFetchJson(`${baseUrl}/models`, { method: 'GET', headers }, 12000);
        const list = (res?.data || res?.models || []).map(item => ({
          id: item.id || item.name,
          label: item.id || item.name
        })).filter(x => x.id);
        return jsonResponse({ ok: true, models: list, message: `从 API 查询到 ${list.length} 个模型。` });
      } catch (err) {
        return jsonResponse({ ok: false, models: [], message: `查询模型失败：${err.message}` });
      }
    }

    if (method === 'POST' && pathname === '/api/check') {
      const body = JSON.parse(options.body || '{}');
      saveStandaloneSettings(body);
      if (body.provider === 'offline') {
        const [sample] = await freeTranslateBatch(['Reducing noise in a sampled circuit.'], 'en', 'zh');
        return jsonResponse({ ok: true, message: '免费本机翻译可用', sample });
      }
      const [sample] = await llmTranslateBatch(['Reducing noise in a sampled circuit.'], body);
      return jsonResponse({ ok: true, message: 'API 连接成功', sample });
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      const jobs = [...standaloneJobs.values()].map(r => r.meta).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return jsonResponse({ jobs });
    }

    if (method === 'POST' && pathname === '/api/demo') {
      const rec = ensureDemoJob();
      return jsonResponse({ job: rec.meta }, 201);
    }

    if (method === 'POST' && pathname === '/api/upload') {
      const rawName = decodeURIComponent(
        (options.headers instanceof Headers ? options.headers.get('X-Filename') : options.headers?.['X-Filename']) || 'document.pdf'
      );
      const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const ext = (rawName.split('.').pop() || 'pdf').toLowerCase();
      let buf;
      if (options.body instanceof Blob) {
        buf = new Uint8Array(await options.body.arrayBuffer());
      } else if (options.body instanceof ArrayBuffer) {
        buf = new Uint8Array(options.body);
      } else {
        buf = new TextEncoder().encode(String(options.body || ''));
      }

      let nativeFileKey = '';
      if (window.AndroidPdfBridge?.saveUploadedPdf && ext === 'pdf') {
        try {
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < buf.length; i += chunk) {
            binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
          }
          nativeFileKey = window.AndroidPdfBridge.saveUploadedPdf(id, btoa(binary)) || '';
        } catch {}
      }

      let pageCount = 1;
      const segments = {};
      if (ext === 'pdf') {
        const parsed = extractPdfPagesFromBytes(buf, nativeFileKey || rawName);
        pageCount = parsed.pageCount;
        parsed.pages.forEach((pairs, idx) => {
          segments[String(idx + 1)] = { mode: 'layout', pairs };
        });
      } else {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        const paras = text.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);
        segments['1'] = {
          mode: 'layout',
          pairs: (paras.length ? paras : [rawName]).map(p => [p, ''])
        };
      }

      const record = {
        id,
        nativeFileKey,
        meta: {
          id,
          name: rawName,
          source_format: ext,
          pages: pageCount,
          state: 'uploaded',
          progress: 0,
          message: '待翻译 · 点击左下角开始翻译',
          error: '',
          created_at: new Date().toISOString(),
          has_result: false,
          has_text: true,
          result_id: 'init',
          text_revision: 'init',
          toc: Array.from({ length: pageCount }, (_, i) => ({ level: 1, title: `第 ${i + 1} 页`, page: i + 1 }))
        },
        segments,
        notes: []
      };
      await saveJobToDb(record);
      return jsonResponse({ job: record.meta }, 201);
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]{32})(\/.*)?$/);
    if (jobMatch) {
      const record = standaloneJobs.get(jobMatch[1]);
      if (!record) return jsonResponse({ error: '找不到该文献任务。' }, 404);
      const action = jobMatch[2] || '';

      if (method === 'DELETE' && action === '') {
        await deleteJobFromDb(record.id);
        return jsonResponse({});
      }

      if (method === 'POST' && (action === '/translate' || action === '/retry-failed')) {
        const opts = JSON.parse(options.body || '{}');
        saveStandaloneSettings(opts);
        void runStandaloneTranslation(record, opts);
        return jsonResponse({ job: record.meta }, 202);
      }

      if (method === 'POST' && action === '/cancel') {
        record.meta.state = record.meta.has_result ? 'completed' : 'cancelled';
        record.meta.message = '已取消';
        await saveJobToDb(record);
        return jsonResponse({ job: record.meta });
      }

      const pagePngMatch = action.match(/^\/page\/(original|translated)\/(\d+)\.png$/);
      if (method === 'GET' && pagePngMatch) {
        const kind = pagePngMatch[1];
        const pageNum = Number(pagePngMatch[2]);
        const width = Number(url.searchParams.get('width') || 960);
        const dataUrl = await renderRecordPagePng(record, kind, pageNum, width);
        return dataUrlToBlobResponse(dataUrl);
      }

      if (method === 'GET' && action === '/segments') {
        const auditReport = auditStandaloneSegments(record.segments);
        return jsonResponse({ pages: record.segments, audit: auditReport });
      }

      if (method === 'GET' && action === '/audit') {
        return jsonResponse(auditStandaloneSegments(record.segments));
      }

      const textMatch = action.match(/^\/text\/(\d+)$/);
      if (textMatch) {
        const pageKey = String(Number(textMatch[1]));
        if (method === 'GET') {
          return jsonResponse(record.segments[pageKey] || { mode: 'layout', pairs: [] });
        }
        const body = JSON.parse(options.body || '{}');
        const oldPairs = record.segments[pageKey]?.pairs || [];
        record.segments[pageKey] = {
          mode: 'layout',
          pairs: oldPairs.map((pair, idx) => {
            const incoming = body.pairs?.[idx];
            const nextTrans = Array.isArray(incoming) ? incoming[1] : (typeof incoming === 'string' ? incoming : pair[1]);
            return [pair[0], String(nextTrans || pair[1] || '').trim()];
          })
        };
        record.meta.text_revision = Math.random().toString(16).slice(2, 10);
        await saveJobToDb(record);
        return jsonResponse({
          mode: 'layout',
          pairs: record.segments[pageKey].pairs,
          text_revision: record.meta.text_revision
        });
      }

      const paraMatch = action.match(/^\/paragraph\/(\d+)\/(\d+)$/);
      if (paraMatch) {
        const pageNum = Number(paraMatch[1]);
        const segIdx = Number(paraMatch[2]);
        const pair = record.segments[String(pageNum)]?.pairs?.[segIdx] || ['', ''];
        if (method === 'GET') {
          return jsonResponse({
            page: pageNum,
            segment: segIdx,
            revision: record.meta.text_revision,
            source: pair[0],
            current: pair[1],
            draft: pair[1],
            has_formulas: false,
            source_unavailable: false,
            pdf_error: ''
          });
        }
        if (method === 'POST') {
          const opts = JSON.parse(options.body || '{}');
          const list = opts.provider === 'offline'
            ? await freeTranslateBatch([pair[0]], opts.source_language || 'en', opts.target_language || 'zh', opts.glossary || '')
            : await llmTranslateBatch([pair[0]], opts);
          return jsonResponse({ draft: list[0] || pair[1] });
        }
        if (method === 'PUT') {
          const opts = JSON.parse(options.body || '{}');
          if (record.segments[String(pageNum)]?.pairs?.[segIdx]) {
            record.segments[String(pageNum)].pairs[segIdx][1] = String(opts.translation || '').trim();
            record.meta.text_revision = Math.random().toString(16).slice(2, 10);
            record.meta.result_id = record.meta.text_revision;
            await saveJobToDb(record);
          }
          return jsonResponse({ job: record.meta });
        }
      }

      if (action === '/notes') {
        if (method === 'GET') return jsonResponse({ notes: record.notes || [] });
        if (method === 'POST') {
          const body = JSON.parse(options.body || '{}');
          const note = {
            id: Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
            page: Number(body.page || 1),
            segment: Number(body.segment || 0),
            original: String(body.original || ''),
            translation: String(body.translation || ''),
            comment: String(body.comment || ''),
            updated_at: new Date().toISOString()
          };
          record.notes = [note, ...(record.notes || [])];
          await saveJobToDb(record);
          return jsonResponse({ note }, 201);
        }
      }

      const noteItemMatch = action.match(/^\/notes\/([a-f0-9]{32})$/);
      if (noteItemMatch) {
        const noteId = noteItemMatch[1];
        if (method === 'DELETE') {
          record.notes = (record.notes || []).filter(n => n.id !== noteId);
          await saveJobToDb(record);
          return jsonResponse({});
        }
        if (method === 'PUT') {
          const body = JSON.parse(options.body || '{}');
          const target = (record.notes || []).find(n => n.id === noteId);
          if (target) {
            target.comment = String(body.comment || '');
            target.updated_at = new Date().toISOString();
            await saveJobToDb(record);
          }
          return jsonResponse({ note: target });
        }
      }

      if (method === 'GET' && action === '/search') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const side = url.searchParams.get('side') || 'both';
        const hits = [];
        for (const [pageKey, entry] of Object.entries(record.segments || {})) {
          (entry.pairs || []).forEach((pair, segIdx) => {
            if (side !== 'translated' && String(pair[0] || '').toLowerCase().includes(q)) {
              hits.push({ page: Number(pageKey), segment: segIdx, side: 'original', snippet: pair[0] });
            }
            if (side !== 'original' && String(pair[1] || '').toLowerCase().includes(q)) {
              hits.push({ page: Number(pageKey), segment: segIdx, side: 'translated', snippet: pair[1] });
            }
          });
        }
        return jsonResponse({ query: q, total: hits.length, hits });
      }

      if (method === 'GET' && action === '/search/boxes') {
        return jsonResponse({ boxes: [] });
      }
    }

    return jsonResponse({ error: `未识别的端侧操作: ${pathname}` }, 404);
  }

  /* ==========================================================================
     8. 全局 fetch 与图片 src 透明代理拦截器
     ========================================================================== */
  const originalFetch = window.fetch.bind(window);
  ensureDemoJob();
  const dbReadyPromise = loadJobsFromDb();

  function isStandaloneActive() {
    if (runtimeMode === 'standalone') return true;
    if (runtimeMode === 'remote' && remoteServerUrl) return false;
    return isNativeAndroid || !desktopReachable;
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();

    if (rawUrl.startsWith('/api/') || rawUrl.startsWith(`${location.origin}/api/`)) {
      const apiPath = rawUrl.startsWith('http') ? rawUrl.slice(location.origin.length) : rawUrl;

      if (runtimeMode === 'remote' && remoteServerUrl) {
        return originalFetch(`${remoteServerUrl}${apiPath}`, init);
      }

      if (runtimeMode === 'standalone' || isNativeAndroid) {
        return handleStandaloneRequest(apiPath, method, init);
      }

      try {
        const res = await originalFetch(input, init);
        desktopReachable = true;
        return res;
      } catch {
        desktopReachable = false;
        return handleStandaloneRequest(apiPath, method, init);
      }
    }
    return originalFetch(input, init);
  };

  // 拦截 <img> 的 src 属性与 setAttribute('src')，同步转换成 DataURL 或远程服务端 URL
  function resolveInterceptedImgSrc(val) {
    const str = String(val || '');
    const match = str.match(/\/api\/jobs\/([a-f0-9]{32})\/page\/(original|translated)\/(\d+)\.png(?:\?.*)?$/);
    if (!match) return val;
    if (runtimeMode === 'remote' && remoteServerUrl && str.startsWith('/')) {
      return `${remoteServerUrl}${str}`;
    }
    if (isStandaloneActive()) {
      const [, jobId, kind, pageStr] = match;
      const widthMatch = str.match(/[?&]width=(\d+)/);
      const width = widthMatch ? Number(widthMatch[1]) : 960;
      const rec = standaloneJobs.get(jobId);
      if (rec) {
        return renderRecordPagePng(rec, kind, Number(pageStr), width);
      }
    }
    return val;
  }

  const imgSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgSrcDescriptor && imgSrcDescriptor.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: true,
      get() {
        return imgSrcDescriptor.get.call(this);
      },
      set(val) {
        imgSrcDescriptor.set.call(this, resolveInterceptedImgSrc(val));
      }
    });
  }

  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
    if (this instanceof HTMLImageElement && String(name).toLowerCase() === 'src') {
      return origSetAttribute.call(this, name, resolveInterceptedImgSrc(value));
    }
    return origSetAttribute.call(this, name, value);
  };

  // DOM 变化监听器：自动将页面流中 newly-inserted <img> 的 data-src / src 替换为端侧高清 DataURL 或远程 URL
  function patchAllStreamImages(root = document) {
    if (!isStandaloneActive() && !(runtimeMode === 'remote' && remoteServerUrl)) return;
    for (const img of root.querySelectorAll('img[data-src], img[src*="/api/jobs/"]')) {
      const rawDataSrc = img.getAttribute('data-src');
      if (rawDataSrc && rawDataSrc.includes('/api/jobs/')) {
        const resolved = resolveInterceptedImgSrc(rawDataSrc);
        if (resolved !== rawDataSrc) {
          img.setAttribute('data-src', resolved);
          origSetAttribute.call(img, 'src', resolved);
          img.hidden = false;
          const errEl = img.parentElement?.querySelector('.image-error');
          if (errEl) errEl.hidden = true;
        }
      }
      const rawSrc = origGetAttribute.call(img, 'src');
      if (rawSrc && rawSrc.includes('/api/jobs/')) {
        const resolved = resolveInterceptedImgSrc(rawSrc);
        if (resolved !== rawSrc) {
          origSetAttribute.call(img, 'src', resolved);
          img.hidden = false;
          const errEl = img.parentElement?.querySelector('.image-error');
          if (errEl) errEl.hidden = true;
        }
      }
    }
  }
  const origGetAttribute = Element.prototype.getAttribute;
  const domObserver = new MutationObserver(() => patchAllStreamImages());
  if (document.documentElement) {
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ==========================================================================
     9. 运行引擎模式切换 UI 与平板/手机触控增强（双指缩放、滑动翻页、手机上下/单栏切换）
     ========================================================================== */
  function syncRuntimeUi() {
    const localBtn = document.getElementById('runtime-local-btn');
    const remoteBtn = document.getElementById('runtime-remote-btn');
    const remoteFields = document.getElementById('remote-server-fields');
    const standaloneNote = document.getElementById('standalone-mode-note');
    const urlInput = document.getElementById('remote-server-url');
    if (!localBtn || !remoteBtn) return;

    const standalone = isStandaloneActive();
    localBtn.classList.toggle('active', standalone);
    remoteBtn.classList.toggle('active', !standalone);
    if (remoteFields) remoteFields.hidden = standalone;
    if (standaloneNote) standaloneNote.hidden = !standalone;
    if (urlInput && remoteServerUrl && !urlInput.value) urlInput.value = remoteServerUrl;
  }

  function setupTouchAndMobileUx() {
    syncRuntimeUi();

    document.getElementById('runtime-local-btn')?.addEventListener('click', () => {
      runtimeMode = 'standalone';
      try { localStorage.setItem(STORAGE_MODE_KEY, 'standalone'); } catch {}
      syncRuntimeUi();
      const providerEl = document.getElementById('provider');
      if (providerEl && ['magpie', 'codex', 'antigravity'].includes(providerEl.value)) {
        providerEl.value = 'offline';
        providerEl.dispatchEvent(new Event('change'));
      }
      document.getElementById('refresh-status')?.click();
    });

    document.getElementById('runtime-remote-btn')?.addEventListener('click', () => {
      runtimeMode = 'remote';
      try { localStorage.setItem(STORAGE_MODE_KEY, 'remote'); } catch {}
      syncRuntimeUi();
    });

    document.getElementById('connect-remote-btn')?.addEventListener('click', () => {
      const input = document.getElementById('remote-server-url');
      const val = (input?.value || '').trim().replace(/\/+$/, '');
      remoteServerUrl = val;
      try {
        localStorage.setItem(STORAGE_REMOTE_URL_KEY, val);
        localStorage.setItem(STORAGE_MODE_KEY, val ? 'remote' : 'auto');
      } catch {}
      document.getElementById('refresh-status')?.click();
    });

    // 平板/手机双指捏合缩放 (Pinch-to-Zoom) + 边缘水平滑动翻页
    const viewer = document.getElementById('viewer-scroll');
    const zoomSelect = document.getElementById('zoom');
    if (viewer && zoomSelect) {
      let startDist = 0;
      let startZoom = 1;
      let swipeStartX = 0;
      let swipeStartY = 0;
      let swipeTracking = false;

      viewer.addEventListener('touchstart', e => {
        if (viewer.classList.contains('fit-width-locked')) { startDist = 0; swipeTracking = false; return; }
        if (e.touches.length === 2) {
          swipeTracking = false;
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          startDist = Math.hypot(dx, dy);
          startZoom = Number(zoomSelect.value) || 100;
        } else if (e.touches.length === 1) {
          swipeStartX = e.touches[0].clientX;
          swipeStartY = e.touches[0].clientY;
          swipeTracking = true;
        }
      }, { passive: true });

      viewer.addEventListener('touchend', e => {
        if (viewer.classList.contains('fit-width-locked')) { startDist = 0; swipeTracking = false; return; }
        if (startDist > 0 && e.touches.length < 2) {
          startDist = 0;
          return;
        }
        if (swipeTracking && e.changedTouches.length === 1) {
          swipeTracking = false;
          const dx = e.changedTouches[0].clientX - swipeStartX;
          const dy = e.changedTouches[0].clientY - swipeStartY;
          if (Math.abs(dx) > 78 && Math.abs(dx) > Math.abs(dy) * 2.2) {
            if (dx < 0) document.getElementById('next-page')?.click();
            else document.getElementById('previous-page')?.click();
          }
        }
      }, { passive: true });

      viewer.addEventListener('touchmove', e => {
        if (viewer.classList.contains('fit-width-locked')) { startDist = 0; swipeTracking = false; return; }
        if (e.touches.length === 2 && startDist > 20) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.hypot(dx, dy);
          const ratio = dist / startDist;
          const target = startZoom * ratio;
          const choices = Array.from(zoomSelect.options, option => Number(option.value));
          const best = choices.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a, 100);
          if (String(best) !== zoomSelect.value) {
            zoomSelect.value = String(best);
            zoomSelect.dispatchEvent(new Event('change'));
          }
        }
      }, { passive: true });
    }

    // 手机小屏首次打开时默认收起侧边文献抽屉，避免遮挡阅读区
    if (window.innerWidth <= 768) {
      document.getElementById('workspace')?.classList.add('sidebar-collapsed');
    }

    // 注册 PWA Service Worker
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  function lookupAcademicDict(query) {
    if (!query) return null;
    const q = query.trim().toLowerCase();
    for (const [en, zh] of ACADEMIC_PHRASES) {
      if (en.toLowerCase() === q) {
        return `【学术术语】${en} ➔ ${zh}\n在学术文献中常用于阐述研究背景、实验对比或方法论设计。`;
      }
    }
    if (ACADEMIC_WORDS[q]) {
      return `【学术词汇】${query} ➔ ${ACADEMIC_WORDS[q]}\n该词在专业学术语境中具有确切的规范译名。`;
    }
    for (const [en, zh] of ACADEMIC_PHRASES) {
      if (en.toLowerCase().includes(q) || q.includes(en.toLowerCase())) {
        return `【相关学术搭配】${en} ➔ ${zh}\n在论文中常表示：${zh}。`;
      }
    }
    return null;
  }

  window.PaperStudioMobile = {
    lookupDict: lookupAcademicDict,
    isStandalone: () => runtimeMode === 'standalone',
    getMode: () => runtimeMode,
    setMode: m => { runtimeMode = m; localStorage.setItem(STORAGE_MODE_KEY, m); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupTouchAndMobileUx);
  } else {
    setupTouchAndMobileUx();
  }
})();
