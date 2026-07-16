<p align="center">
  <img src="https://raw.githubusercontent.com/jobssteve164dev/bmcp/main/icon.png" width="128" height="128" alt="SoloBrowser Logo">
</p>

# SoloBrowser

SoloBrowser is a real, visible browser for VS Code. Local AI agents such as Codex, Claude Code, Cursor Agent, and Gemini CLI can browse and operate websites while you watch every action in the editor.

SoloBrowser 为本地 AI 代理提供一个真正可见的 VS Code 浏览器。Codex、Claude Code、Cursor Agent、Gemini CLI 等工具可以浏览和操作网站，而用户始终能在编辑器里看到页面与每一步动作。

---

## English Version

### 🚀 Key Features

1. **Real Browser in VS Code (`SoloBrowser`)**
   Opens a headed local Chrome, Edge, or Chromium session for modern websites such as YouTube and Bilibili, then displays the active tab in VS Code with low-latency WebRTC.

2. **Native Port Tunneling (`portMapping`)**  
   Utilizes VS Code's official `portMapping` API to automatically establish a secure tunnel. Webviews and iframes can seamlessly communicate with the container backend using `localhost` with **zero-configuration**—fully compatible with Coder, `code-server`, GitHub Codespaces, and Remote SSH.

3. **Smart Asset Link Patching**  
   The built-in reverse proxy automatically rewrites relative asset paths (CSS, JS, images, etc.) into absolute CDN paths. These assets load directly via the host browser, reducing container bandwidth overhead and eliminating all mixed-content and 404 routing issues.

4. **RESTful HTTP Control API**  
   Exposes a local API endpoint at `http://127.0.0.1:17333` (automatically auto-increments to `17334`, etc. on port conflict) for local Agent CLIs to query:
   * `/open` - Navigate to any URL.
   * `/snapshot` - Retrieve a structured accessibility tree and DOM snapshot (instead of raw screenshots).
   * `/click` / `/type` / `/read` - Execute human-like actions on elements via stable selectors.

5. **Consistent Real-Browser Identity**
   Prefers the user's stable Chrome, Edge, or Chromium installation and keeps a persistent local profile for cookies and preferences. SoloBrowser uses the browser's own network stack and reported identity; it does not spoof the User-Agent or inject a synthetic fingerprint.

---

### 📦 Installation & Getting Started

1. Install **SoloBrowser** from the Visual Studio Marketplace.
2. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
3. Run **`SoloBrowser: Open Browser`** and enter a URL (e.g., `https://youtube.com`), or leave it empty to open the sidebar.
4. Run **`SoloBrowser: Run Demo`** to watch the automated sign-in demo flow on a local fixture page.

Optional: set `bmcp.browserPath` if you want SoloBrowser to use a specific Chrome, Edge, or Chromium executable. The legacy setting key remains stable so existing installations keep working after the rename.

#### Controlling from Local Agent CLIs
Once activated, local agent scripts can invoke control APIs via cURL:
```bash
# Check service health
curl http://127.0.0.1:17333/health

# Instruct the sidebar browser to navigate
curl -X POST http://127.0.0.1:17333/open \
  -H 'content-type: application/json' \
  -d '{"url":"https://news.ycombinator.com"}'

# Fetch structural accessibility snapshots
curl -X POST http://127.0.0.1:17333/snapshot -d '{}'
```

---

## 中文版说明

### 🚀 核心特性

1. **VS Code 内的真实浏览器 (`SoloBrowser`)**
   使用本机有界面的 Chrome、Edge 或 Chromium 打开 YouTube、Bilibili 等现代网站，再通过 WebRTC 将当前标签页低延迟显示在 VS Code 内。

2. **官方原生端口隧道桥接 (`portMapping`)**  
   基于 VS Code 官方 `portMapping` 接口，自动在后台建立安全隧道。前端 Webview 能够无感地通过 `localhost` 访问容器内的代理服务端，**零配置**完美兼容 Coder、`code-server`、GitHub Codespaces 以及 Remote SSH 远程开发环境。

3. **智能静态资源路径补全**  
   内置反向代理会自动将网页上的相对资源链接（CSS、JS、图片等）改写为公网绝对 CDN 地址，让静态资源直接由您的物理机宿主浏览器加载。大幅节省远程服务器带宽，并彻底根除 code-server 环境下的混合内容与 404 路由报错。

4. **统一 RESTful 控制接口**  
   在本地默认监听 `127.0.0.1:17333`（端口冲突时会自动递增寻找空闲端口，如 `17334`），为本地 Agent 命令行工具提供以下调用端点：
   * `/open` - 网页导航切换。
   * `/snapshot` - 获取结构化元素和 DOM 树快照（返回稳定元素引用，拒绝视觉猜测）。
   * `/click` / `/type` / `/read` - 根据元素引用执行点击、输入和内容读取。

5. **一致的真实浏览器身份**
   优先复用用户安装的稳定版 Chrome、Edge 或 Chromium，并通过持久本地 Profile 保留 Cookie、偏好和登录状态。SoloBrowser 使用浏览器自身的网络栈与身份，不伪造 User-Agent，也不注入虚假指纹。

---

### 📦 快速上手与使用

1. 在 VS Code Marketplace 安装 **SoloBrowser** 插件。
2. 按下 `Ctrl+Shift+P`（或 `Cmd+Shift+P`）打开命令面板。
3. 执行 **`SoloBrowser: Open Browser`** 并输入您想访问的网址（如 `https://youtube.com`），或直接打开侧边栏。
4. 执行 **`SoloBrowser: Run Demo`** 体验本地演示流程。

可选：如果希望指定浏览器，可在设置里填写 `bmcp.browserPath`，指向 Chrome、Edge 或 Chromium 可执行文件。为保证升级后原有配置继续生效，设置键暂时保持不变。

#### 本地 AI 代理（Agent）调用示例
插件激活后，本地 Agent 脚本可以直接通过 cURL 操控工作区浏览器：
```bash
# 查询服务状态与实际可用端口
curl http://127.0.0.1:17333/health

# 控制浏览器跳转
curl -X POST http://127.0.0.1:17333/open \
  -H 'content-type: application/json' \
  -d '{"url":"https://news.ycombinator.com"}'

# 获取当前页面的结构化元素快照
curl -X POST http://127.0.0.1:17333/snapshot -d '{}'
```

---

## 🛡️ Safety Boundary / 安全边界

SoloBrowser is designed for user-authorized browser work in a visible local VS Code workspace. A real browser identity improves compatibility, but no browser extension can guarantee acceptance by every website. It does not bypass CAPTCHA, anti-fraud checks, access controls, or site policy.

SoloBrowser 用于用户已授权、且在本地工作区中可见的浏览任务。真实浏览器身份可以减少兼容问题，但不能保证所有网站都接受自动化会话；插件不会绕过验证码、反欺诈检查、访问控制或网站规则。
