'use strict';

(() => {
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

  window.PaperStudioReader = {lookupDict:lookupAcademicDict};

  function setupTouchReading() {
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

    if (!window.AndroidPdfBridge && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupTouchReading);
  } else {
    setupTouchReading();
  }
})();
