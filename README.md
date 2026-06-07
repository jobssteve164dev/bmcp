<p align="center">
  <img src="https://raw.githubusercontent.com/jobssteve164dev/bmcp/main/icon.png" width="128" height="128" alt="BMCP Logo">
</p>

# BMCP (Browser Media Control Protocol)

BMCP is a visible VS Code browser scaffold designed for local AI Agent CLIs. It empowers agent CLIs (such as Claude Code, Cursor Agent, Gemini CLI, etc.) to open and interact with a visible browser session directly inside VS Code workspace.

BMCP 专为本地 AI 代理（Agent CLI）设计，提供 VS Code 可视化浏览器控制脚手架。它让本地 AI 代理（如 Claude Code, Cursor Agent, Gemini CLI 等）能够直接在 VS Code 工作区中打开并控制一个完全可见的浏览器实例。

---

## English Version

### 🚀 Key Features

1. **Fully Integrated Sidebar Browser (`BMCP Browser`)**  
   An elegant, high-performance sidebar browser view that enables you to browse and stream modern, complex media websites (like YouTube or Bilibili) natively within VS Code with **zero latency**.

2. **Native Port Tunneling (`portMapping`)**  
   Utilizes VS Code's official `portMapping` API to automatically establish a secure tunnel. Webviews and iframes can seamlessly communicate with the container backend using `localhost` with **zero-configuration**—fully compatible with Coder, `code-server`, GitHub Codespaces, and Remote SSH.

3. **Smart Asset Link Patching**  
   The built-in reverse proxy automatically rewrites relative asset paths (CSS, JS, images, etc.) into absolute CDN paths. These assets load directly via the host browser, reducing container bandwidth overhead and eliminating all mixed-content and 404 routing issues.

4. **RESTful HTTP Control API**  
   Exposes a local API endpoint at `http://127.0.0.1:17333` (automatically auto-increments to `17334`, etc. on port conflict) for local Agent CLIs to query:
   * `/open` - Navigate to any URL.
   * `/snapshot` - Retrieve a structured accessibility tree and DOM snapshot (instead of raw screenshots).
   * `/click` / `/type` / `/read` - Execute human-like actions on elements via stable selectors.

5. **CDP Viewport Screencast (Hybrid Mode)**  
   Includes a secondary out-of-process Chrome mode powered by Puppeteer/Playwright. It streams viewport frames via WebSockets and forwards keyboard/mouse events back to the native Chrome instance for advanced headless automation.

---

### 📦 Installation & Getting Started

1. Install **BMCP** from the Visual Studio Marketplace.
2. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
3. Run **`BMCP: Open Browser`** and enter a URL (e.g., `https://youtube.com`), or leave it empty to open the sidebar.
4. Run **`BMCP: Run Demo`** to watch the automated sign-in demo flow on a local fixture page.

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

1. **完全集成的侧边栏浏览器 (`BMCP Browser`)**  
   专为 VS Code 侧边栏量身定制的高颜值、高性能浏览器视图。由于采用本地原生渲染技术，您可以在 VS Code 内部以**零延迟**流畅播放 YouTube、Bilibili 等现代化视频多媒体网站。

2. **官方原生端口隧道桥接 (`portMapping`)**  
   基于 VS Code 官方 `portMapping` 接口，自动在后台建立安全隧道。前端 Webview 能够无感地通过 `localhost` 访问容器内的代理服务端，**零配置**完美兼容 Coder、`code-server`、GitHub Codespaces 以及 Remote SSH 远程开发环境。

3. **智能静态资源路径补全**  
   内置反向代理会自动将网页上的相对资源链接（CSS、JS、图片等）改写为公网绝对 CDN 地址，让静态资源直接由您的物理机宿主浏览器加载。大幅节省远程服务器带宽，并彻底根除 code-server 环境下的混合内容与 404 路由报错。

4. **统一 RESTful 控制接口**  
   在本地默认监听 `127.0.0.1:17333`（端口冲突时会自动递增寻找空闲端口，如 `17334`），为本地 Agent 命令行工具提供以下调用端点：
   * `/open` - 网页导航切换。
   * `/snapshot` - 获取结构化元素和 DOM 树快照（返回稳定元素引用，拒绝视觉猜测）。
   * `/click` / `/type` / `/read` - 根据元素引用执行点击、输入和内容读取。

5. **CDP 画面流与键鼠转发（混合模式）**  
   保留了通过 CDP 驱动的外部 Chrome 无头模式。支持通过 WebSocket 将外部 Chrome 的画面帧实时投影到 VS Code Webview 之中，并反向同步用户的键盘和鼠标动作。

---

### 📦 快速上手与使用

1. 在 VS Code Marketplace 安装 **BMCP** 插件。
2. 按下 `Ctrl+Shift+P`（或 `Cmd+Shift+P`）打开命令面板。
3. 执行 **`BMCP: Open Browser`** 并输入您想访问的网址（如 `https://youtube.com`），或直接打开侧边栏。
4. 执行 **`BMCP: Run Demo`** 体验在本地测试页面上自动输入账密并登录的演示流程。

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

BMCP is designed for user-authorized browser work in a visible local VS Code workspace. It does not provide features for CAPTCHA bypass, anti-fraud evasion, or scraping stealth. 

BMCP 旨在为用户授权的、留在本地工作区内的浏览器自动化提供可视化脚手架。它不支持、也不提供任何用于绕过验证码（CAPTCHA）、反欺诈机制或指纹对抗的爬虫工具属性。
