/*!
 * ai-control.js —— 让 AI 实时控制你的网页，并拥有长期记忆
 * 版本 1.0.0  ·  零依赖  ·  直接在 HTML 里 <script src> 引入即可
 *
 * 设计目标：
 *   1. 任何 HTML 页面加一行 script 就获得"可被 AI 操控"的能力
 *   2. 密钥不进前端源码（由你自己的后端或运行时注入）
 *   3. 网络受限时自动换通道
 *   4. 记忆跨刷新保留
 *
 * 用法：
 *   <script src="ai-control.js"></script>
 *   <script>
 *     AI.setup({ endpoint:'https://你的后端/v1/chat', token:'运行时注入' });
 *     AI.chat('把页面标题改成红色');
 *   </script>
 */
(function (global) {
  'use strict';

  var LS_KEY = 'ai_control_memory_v1';
  var CFG_KEY = 'ai_control_config_v1';

  /* ---------------- 记忆层：localStorage + 内存双写，跨刷新保留 ---------------- */
  function loadMemory() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveMemory() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(AI.memory)); } catch (e) {}
  }
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(pickCfg())); } catch (e) {}
  }
  function pickCfg() {
    /* 只持久化非敏感项：端点可以存，密钥绝不落盘 */
    return {
      endpoint: AI.config.endpoint,
      model: AI.config.model,
      visionModel: AI.config.visionModel,
      channel: AI.config.channel,
      autoScreenshot: AI.config.autoScreenshot
    };
  }

  /* ---------------- 默认配置 ---------------- */
  var DEFAULTS = {
    endpoint: '',            // 你自己的后端 /v1/chat/completions
    token: '',               // 运行时注入，不落盘
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o',   // 多模态：识图走这个
    /* 直连不通时的备用通道（按顺序试），可自行增删 */
    channels: [
      { name: 'direct', build: function (u) { return u; } },
      { name: 'cors-lol', build: function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); } },
      { name: 'allorigins', build: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
      { name: 'codetabs', build: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } }
    ],
    channel: 'direct',
    autoScreenshot: false,
    maxSteps: 8              // 一次指令最多让 AI 连续操作几步，防跑飞
  };

  var AI = {
    version: '1.0.0',
    config: Object.assign({}, DEFAULTS, loadCfg()),
    memory: loadMemory(),
    tools: {},
    log: [],
    _busy: false
  };

  /* ---------------- 工具注册：AI 只能调用你注册过的工具 ---------------- */
  AI.register = function (name, fn, desc) {
    AI.tools[name] = { fn: fn, desc: desc || '' };
    return AI;
  };

  /* ---------------- 内置工具（页面操控） ---------------- */
  function q(sel) { return document.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  AI.register('query', function (a) {
    var els = qa(a.sel || a.selector);
    return els.slice(0, a.limit || 20).map(function (el) {
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className && el.className.toString) ? el.className.toString().slice(0, 60) : '',
        text: (el.textContent || '').trim().slice(0, 120)
      };
    });
  }, '按选择器查询元素');

  AI.register('click', function (a) {
    var el = q(a.sel || a.selector);
    if (!el) return { ok: false, err: '找不到元素' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, clicked: a.sel };
  }, '点击元素');

  AI.register('type', function (a) {
    var el = q(a.sel || a.selector);
    if (!el) return { ok: false, err: '找不到输入框' };
    el.focus();
    if ('value' in el) {
      el.value = a.text || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typed: a.text };
    }
    return { ok: false, err: '该元素不支持输入' };
  }, '向输入框写入文本');

  AI.register('setStyle', function (a) {
    var els = qa(a.sel || a.selector);
    els.forEach(function (el) { Object.keys(a.style || {}).forEach(function (k) { el.style[k] = a.style[k]; }); });
    return { ok: true, changed: els.length };
  }, '修改元素样式，例：{"sel":"h1","style":{"color":"red"}}');

  AI.register('setHTML', function (a) {
    var el = q(a.sel || a.selector);
    if (!el) return { ok: false, err: '找不到元素' };
    el.innerHTML = a.html || '';
    return { ok: true };
  }, '替换元素 HTML');

  AI.register('scroll', function (a) {
    window.scrollTo({ top: (a.top != null ? a.top : window.scrollY + (a.by || 0)), behavior: 'smooth' });
    return { ok: true };
  }, '滚动页面');

  AI.register('navigate', function (a) {
    if (a.hash) { location.hash = a.hash; return { ok: true, hash: a.hash }; }
    if (a.url) { location.href = a.url; return { ok: true }; }
    return { ok: false, err: '缺 url 或 hash' };
  }, '站内跳转');

  /* 识图：把页面结构或截图交给视觉模型 */
  AI.register('snapshot', function () {
    return { ok: true, snapshot: AI.snapshot() };
  }, '获取当前页面的结构化快照（文本，轻量）');

  AI.register('screenshot', function () {
    return AI.screenshot().then(function (d) { return { ok: true, dataUrl: d }; });
  }, '截图当前可视区域（需要 html2canvas；未加载时返回提示）');

  /* 记忆 */
  AI.register('remember', function (a) {
    AI.remember(a.key, a.value);
    return { ok: true };
  }, '写入长期记忆');

  AI.register('recall', function (a) {
    return { ok: true, value: AI.recall(a.key) };
  }, '读取长期记忆');

  /* ---------------- 快照：给文本模型看的"页面长什么样" ---------------- */
  AI.snapshot = function () {
    var out = [];
    var main = document.body;
    if (!main) return '';
    var walk = function (el, depth) {
      if (depth > 3 || out.length > 60) return;
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!tag || ['script', 'style', 'noscript'].indexOf(tag) >= 0) return;
      var id = el.id ? '#' + el.id : '';
      var cls = (el.className && el.className.toString) ? '.' + el.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : '';
      var txt = (el.childNodes.length === 1 && el.firstChild.nodeType === 3)
        ? (el.textContent || '').trim().slice(0, 60) : '';
      out.push('  '.repeat(depth) + tag + id + cls + (txt ? ' "' + txt + '"' : ''));
      for (var i = 0; i < el.children.length && out.length <= 60; i++) walk(el.children[i], depth + 1);
    };
    walk(main, 0);
    return out.join('\n');
  };

  /* ---------------- 截图：给视觉模型看的真实画面 ---------------- */
  AI.screenshot = function () {
    return new Promise(function (resolve) {
      if (!global.html2canvas) {
        resolve('');   /* 未加载 html2canvas 时返回空，模型会退回用快照 */
        return;
      }
      global.html2canvas(document.body, { scale: 0.6, logging: false })
        .then(function (c) { resolve(c.toDataURL('image/jpeg', 0.7)); })
        .catch(function () { resolve(''); });
    });
  };

  /* ---------------- 记忆 API ---------------- */
  AI.remember = function (k, v) { AI.memory[k] = v; saveMemory(); return AI; };
  AI.recall = function (k) { return AI.memory[k]; };
  AI.forget = function (k) { delete AI.memory[k]; saveMemory(); return AI; };
  AI.exportMemory = function () { return JSON.stringify(AI.memory, null, 2); };
  AI.clearMemory = function () { AI.memory = {}; saveMemory(); return AI; };

  /* ---------------- 网络层：自动换通道 ---------------- */
  AI.fetchVia = function (url, opt) {
    opt = opt || {};
    var list = AI.config.channels.slice();
    var n = 0;
    function next() {
      if (n >= list.length) return Promise.reject(new Error('所有通道都不可用'));
      var ch = list[n++];
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject(new Error('timeout')); }, opt.timeout || 9000);
        fetch(ch.build(url), opt).then(function (r) {
          clearTimeout(t);
          if (!r.ok) { reject(new Error('HTTP ' + r.status)); return; }
          AI.config.channel = ch.name; saveCfg();
          resolve(r);
        }).catch(function (e) { clearTimeout(t); reject(e); });
      }).catch(function () { return next(); });
    }
    return next();
  };

  /* ---------------- 调用模型 ---------------- */
  AI.call = function (messages, opt) {
    opt = opt || {};
    if (!AI.config.endpoint) return Promise.reject(new Error('未配置 endpoint'));
    var headers = { 'Content-Type': 'application/json' };
    /* 密钥只在运行时存在，从不写入 localStorage */
    if (AI.config.token) headers['Authorization'] = 'Bearer ' + AI.config.token;
    var body = {
      model: opt.vision ? (AI.config.visionModel || AI.config.model) : AI.config.model,
      messages: messages
    };
    if (opt.tools !== false) {
      body.tools = Object.keys(AI.tools).map(function (name) {
        return { type: 'function', function: { name: name, description: AI.tools[name].desc, parameters: { type: 'object', properties: {} } } };
      });
    }
    return fetch(AI.config.endpoint, {
      method: 'POST', headers: headers, body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120)); });
      return r.json();
    });
  };

  /* ---------------- 主入口：一句话指令 → AI 连续操作页面 ---------------- */
  AI.chat = function (userText, opt) {
    opt = opt || {};
    if (AI._busy) return Promise.reject(new Error('上一条还没执行完'));
    AI._busy = true;

    var sys = '你是一个能操控网页的助手。用户会给你一条指令。\n' +
      '你可以调用工具来改变页面。不要臆造选择器——先用 query 看清页面。\n' +
      '当前页面快照：\n' + AI.snapshot().slice(0, 3000) +
      '\n\n长期记忆（跨会话保留）：\n' + JSON.stringify(AI.memory).slice(0, 1200);

    var messages = [{ role: 'system', content: sys }, { role: 'user', content: userText }];
    var steps = 0;

    function loop() {
      if (steps++ >= (opt.maxSteps || AI.config.maxSteps)) { AI._busy = false; return Promise.resolve('已完成（达到步数上限）'); }
      return AI.call(messages).then(function (data) {
        var msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
        messages.push(msg);
        var calls = msg.tool_calls || [];
        if (!calls.length) { AI._busy = false; return msg.content || '(无回复)'; }
        var jobs = calls.map(function (c) {
          var name = c.function && c.function.name;
          var args = {};
          try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch (e) {}
          var t = AI.tools[name];
          if (!t) return Promise.resolve(JSON.stringify({ ok: false, err: '没有这个工具' }));
          var r = t.fn(args);
          return (r && r.then) ? r : Promise.resolve(r);
        });
        return Promise.all(jobs).then(function (results) {
          results.forEach(function (r, i) {
            messages.push({
              role: 'tool',
              tool_call_id: calls[i].id,
              content: typeof r === 'string' ? r : JSON.stringify(r).slice(0, 2000)
            });
          });
          AI.log.push({ step: steps, calls: calls.length });
          return loop();
        });
      });
    }
    return loop().catch(function (e) { AI._busy = false; throw e; });
  };

  /* ---------------- 初始化 ---------------- */
  AI.setup = function (o) {
    Object.assign(AI.config, o || {});
    saveCfg();     /* 注意：token 不在 pickCfg 里，不会被持久化 */
    return AI;
  };

  /* ---------------- 调试面板 ---------------- */
  AI.panel = function () {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;background:#0d1117;color:#c9d1d9;' +
      'border:1px solid #30363d;border-radius:8px;padding:10px;font:12px monospace;max-width:280px';
    d.innerHTML = '<b>AI Control ' + AI.version + '</b><br>' +
      'endpoint: ' + (AI.config.endpoint || '未配置') + '<br>' +
      '通道: ' + AI.config.channel + '<br>' +
      '工具: ' + Object.keys(AI.tools).length + ' 个<br>' +
      '记忆: ' + Object.keys(AI.memory).length + ' 条<br>' +
      '<input id="_aiCmd" placeholder="输入指令…" style="width:100%;margin-top:6px;background:#161b22;' +
      'color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px">' +
      '<div id="_aiOut" style="margin-top:6px;max-height:120px;overflow:auto"></div>';
    document.body.appendChild(d);
    d.querySelector('#_aiCmd').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var v = this.value; this.value = '';
      var out = d.querySelector('#_aiOut');
      out.textContent = '执行中…';
      AI.chat(v).then(function (r) { out.textContent = r; })
        .catch(function (err) { out.textContent = '失败：' + err.message; });
    });
    return d;
  };

  global.AI = AI;
})(window);
