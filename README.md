# AI 实时控制网页 + 长期记忆

给**任意 HTML 页面**加一行 `<script>`，就获得"可被 AI 实时操控"的能力：
AI 能看页面、点按钮、填表单、改样式、跳路由，并且**记住**上次做过什么。

> ⚠️ **安全第一条**：本仓库所有代码与文档**不含任何真实密钥**。
> 请把你自己的密钥放在**后端**或运行时注入，**不要**写进 HTML / JS 源码里提交到公开仓库。

---

## 一、它到底是怎么工作的

### 1. 三层结构

```
┌─────────────┐   ① 指令     ┌─────────────┐   ② 工具调用   ┌──────────────┐
│   你 / AI   │ ───────────→ │  模型服务    │ ────────────→ │  你的网页     │
│             │ ←─────────── │（你自己的）  │ ←────────────  │ ai-control.js │
└─────────────┘   ④ 回复     └─────────────┘   ③ 执行结果   └──────────────┘
```

关键点：**模型不直接碰你的页面**。模型只返回"我要调用 `click`，参数是 `{"sel":"#btn"}`"，
由页面里的 `ai-control.js` 真正执行，再把结果回传。这叫 **function calling / tool use**。

好处：
- 模型看不到你的密钥（密钥在你自己后端）
- 模型只能调用你**注册过**的工具，想干坏事也干不了
- 每一步都可控、可中断（`maxSteps` 限制最多连干几步）

### 2. AI 怎么"看见"页面（识图的两条路）

| 方式 | 怎么做的 | 代价 | 适合 |
|---|---|---|---|
| **结构化快照** | 遍历 DOM，输出缩进的标签树 + 文本 | 极小，纯文本 | 日常操作：点、填、跳 |
| **视觉截图** | `html2canvas` 把页面画成 JPEG base64 发给视觉模型 | 大，慢，贵 | 看图表、验证码、布局错乱 |

默认走**快照**（便宜够用）。需要"看图"时才开截图：

```js
AI.setup({ autoScreenshot: true });
```

### 3. 长期记忆怎么做到

记忆写 `localStorage`（键 `ai_control_memory_v1`），跨刷新、跨会话保留。

```js
AI.remember('用户名', '张三');
AI.recall('用户名');      // '张三'
```

每次对话时，记忆会被自动塞进 system prompt，所以 AI "记得"你。

**注意：`token` 被刻意排除在持久化之外**（见 `pickCfg()`），只有端点、模型名这些非敏感项落盘。

---

## 二、三分钟接入

### 最简版

```html
<!-- 你的页面 -->
<h1 id="title">Hello</h1>
<button id="btn">点我</button>

<!-- 加这两行 -->
<script src="ai-control.js"></script>
<script>
  AI.setup({
    endpoint: 'https://你的后端.com/v1/chat/completions',
    token: 运行时注入   // 千万别硬编码
  });

  AI.chat('把标题改成红色，然后点一下按钮');
</script>
```

### 带调试面板（推荐先跑这个）

```html
<script src="ai-control.js"></script>
<script>
  AI.setup({ endpoint: '...', token: '...' });
  AI.panel();   // 右下角出现输入框，直接打字试
</script>
```

### 自定义工具

AI 只能调用你注册的工具。加自己的：

```js
AI.register('提交订单', function (args) {
  // args = { id: 123 }
  doSomething(args.id);
  return { ok: true };
}, '提交指定订单，参数 {id}');
```

---

## 三、网络不通怎么办（代理与通道）

这是国内最常踩的坑。前端直连模型 API 会遇到两个问题：**跨域（CORS）** 和 **网络不可达**。

### 方案对比

| 方案 | 原理 | 优点 | 缺点 |
|---|---|---|---|
| **后端转发（推荐）** | 你的服务器去请求模型，前端只跟自己后端通信 | 密钥安全、无跨域、最稳 | 要有个服务器 |
| **公共 CORS 代理** | 第三方服务器帮你转发 | 零成本 | 不稳定、随时可能停服、有隐私风险 |
| **自建 Cloudflare Worker** | 自己部署一个转发脚本，有自己的域名 | 免费、可控、无跨域 | 要会部署（其实就粘贴一段代码） |
| **GitHub Actions 中转** | 借 GitHub 的机器去取 | 网络质量好 | 慢（几十秒到几分钟） |
| **浏览器扩展** | 扩展不受 CORS 限制 | 用户端零配置 | 只适合自己用 |

### 内置的多通道自动切换

`ai-control.js` 内置了通道列表，一个不通自动换下一个：

```js
AI.config.channels = [
  { name: 'direct',    build: u => u },
  { name: 'cors-lol',  build: u => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
  { name: 'allorigins',build: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'codetabs',  build: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) }
];
```

用完 `AI.config.channel` 会记录**最后成功的那个**，下次优先试它。

### 自建 Worker 的骨架（推荐）

把下面这段粘到 Cloudflare Worker，你就有了自己的专属代理：

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400 });
    const r = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: ['GET','HEAD'].includes(request.method) ? undefined : await request.text()
    });
    return new Response(r.body, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('Content-Type') || 'text/plain',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
```

部署后：

```js
AI.config.channels.unshift({
  name: 'my-worker',
  build: u => 'https://你的worker域名.workers.dev/?url=' + encodeURIComponent(u)
});
```

---

## 四、多模态（识图）怎么配

想让 AI 真正"看图"，需要三件事齐全：

1. **模型支持视觉**（`gpt-4o`、`claude-3-5-sonnet`、`qwen-vl` 这类）
2. **页面能截图**（引入 `html2canvas`）
3. **消息格式是多模态的**（图片 base64 放进 `content` 数组）

```html
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script src="ai-control.js"></script>
<script>
  AI.setup({
    endpoint: 'https://你的后端/v1/chat/completions',
    model: 'gpt-4o-mini',      // 日常操作
    visionModel: 'gpt-4o'      // 识图时自动切这个
  });

  // 手动发一张图给视觉模型
  AI.screenshot().then(function (dataUrl) {
    if (!dataUrl) return console.warn('没加载 html2canvas');
    return AI.call([{
      role: 'user',
      content: [
        { type: 'text', text: '这张图上有什么异常？' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }], { vision: true, tools: false });
  });
</script>
```

> 多模态请求体大很多，**按需开**，别每次对话都截图。

---

## 五、密钥安全（务必看）

| 做法 | 安全性 | 说明 |
|---|---|---|
| 写在 HTML 里 | ❌ 极危险 | 任何人右键查看源码就能拿到 |
| 写在 JS 变量里 | ❌ 危险 | 同上，打包也没用 |
| 放 localStorage | ❌ 危险 | 同源脚本都能读 |
| **放后端，前端拿临时票据** | ✅ 推荐 | 密钥永不离开服务器 |
| **运行时由用户手动输入** | ✅ 可接受 | 只存在内存，刷新即失 |

`ai-control.js` 的做法：`AI.config.token` 只活在内存里，`saveCfg()` 里刻意不写它。

如果你要把页面发给别人用，**一定要走后端转发**，并且在后端限流、校验来源。

---

## 六、完整 API

| 方法 | 作用 |
|---|---|
| `AI.setup({...})` | 配置端点、模型、通道（token 不落盘） |
| `AI.chat('指令')` | 一句话 → AI 自动连续操作页面 |
| `AI.register(name, fn, desc)` | 注册自定义工具 |
| `AI.snapshot()` | 页面结构化快照（文本） |
| `AI.screenshot()` | 截图 dataURL（需 html2canvas） |
| `AI.remember(k, v)` / `AI.recall(k)` / `AI.forget(k)` | 长期记忆读写删 |
| `AI.exportMemory()` / `AI.clearMemory()` | 导出 / 清空记忆 |
| `AI.fetchVia(url)` | 带自动换通道的请求 |
| `AI.call(messages, opt)` | 直接调模型 |
| `AI.panel()` | 右下角调试面板 |

### 内置工具一览

`query` `click` `type` `setStyle` `setHTML` `scroll` `navigate` `snapshot` `screenshot` `remember` `recall`

---

## 七、常见问题

**Q：AI 点错元素了？**
先让它 `query` 看清页面。选择器尽量用 `id`，别让它猜。

**Q：一直转圈没反应？**
多半是网络。看控制台，或者换通道：`AI.config.channels` 里加你自己的 worker。

**Q：能控制别人的网站吗？**
不能。脚本必须注入到目标页面里，且受同源策略限制。这是**安全边界**，不是缺陷。

**Q：记忆能同步到别的设备吗？**
当前版本是本地 localStorage。要多端同步就把 `AI.exportMemory()` 的结果传到你自己的后端。

---

## 文件说明

| 文件 | 用途 |
|---|---|
| `ai-control.js` | 核心库，直接引入 |
| `demo.html` | 完整可跑的示例 |
| `README.md` | 本文档 |

---

## 许可

MIT。随便改，但请保留安全提示。
