# SoloBrowser 产品简报

## 1. 产品边界

SoloBrowser 是一个给本地 agent CLI 使用的、在 VS Code 中真正可见的浏览器。

它不尝试成为新的 agent CLI。第一版产品边界是：让 Claude Code、Codex、Cursor Agent、Gemini CLI 以及其他支持 MCP 或 HTTP 调用的本地 agent CLI，能够在 VS Code 中打开并操作一个用户看得见的浏览器。

核心承诺很简单：当 agent 需要使用网站时，用户能看到真实浏览器和每一步动作，并且整个过程仍然留在同一个编辑器工作流里。

## 2. 当前市场信号

类似项目已经存在，BMCP 应该向它们学习，而不是假设这个方向没有先例。

- BrowserMCP 通过 MCP server 和 Chrome 扩展，让 AI 应用操作用户本地浏览器。值得学习的是：本地运行、复用用户已登录的浏览器 profile、隐私优先定位，以及使用真实浏览器 profile，而不是新开一个自动化专用 profile。来源：https://github.com/BrowserMCP/mcp
- AlienMcp 把 MCP 客户端连接到真实 Chrome 标签页。值得学习的是：按标签组限定 agent 可见范围、由用户明确选择哪些标签页开放给 agent、只走 localhost 通信，以及用 CDP 支撑 click/type/hover，而不是依赖脆弱的页面脚本事件。来源：https://www.alien-mcp.com/
- Integrated Browser MCP 是一个 VS Code 扩展，把 VS Code 内置浏览器通过 HTTP 和 MCP 暴露出来。值得学习的是：VS Code 原生浏览器界面、按需启动浏览器、本地 HTTP API、MCP 桥接、workspace 到 window 的路由，以及浏览器状态诊断。来源：https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp
- Microsoft Playwright MCP 推广了面向 agent 的结构化 accessibility snapshot。值得学习的是：给 agent 一个精确的页面操作模型，而不是只依赖截图或视觉识别。来源：https://github.com/microsoft/playwright-mcp
- ManulMcpServer 在 VS Code 中提供确定性的浏览器自动化，并强调可回放脚本和元素扫描。值得学习的是：可解释的动作、可读的执行步骤、持久浏览器会话，以及操作失败后的检查与重试。来源：https://marketplace.visualstudio.com/items?itemName=manul-engine.manul-mcp-server

BMCP 的初始差异化应该比完整浏览器自动化套件更窄：它是一个 VS Code 本地、可见浏览器的脚手架，让大厂本地 agent CLI 可以接入，而不要求用户采用一个新的 agent。

## 3. 目标用户

主要用户是已经在 VS Code 中工作、并且已经使用本地 agent CLI 的开发者和运营型用户。

他们希望 agent 能处理网站任务，同时自己保留视觉控制权：

- 测试本地 Web 应用；
- 使用用户已有登录态进入 SaaS 产品；
- 填写表单并检查结果；
- 浏览后台页面、文档、仪表盘或 issue 系统；
- 在操作完成后提取页面上的可见状态。

他们不想要另一个聊天产品、另一个自治 agent，或者一个看不见的远程浏览器。他们要的是：让当前正在使用的 agent CLI 获得一只能被信任的浏览器手。

## 4. VS Code 中的核心浏览器动作

第一条有用工作流应该支持本地 agent CLI 在 VS Code workspace 中发起这些动作：

- 在 VS Code 中打开一个可见浏览器视图；
- 导航到指定 URL；
- agent 操作时向用户显示当前页面；
- 返回带稳定元素引用的结构化页面快照；
- 点击被引用的元素；
- 向被引用的输入框输入内容；
- 等待页面状态变化；
- 读取可见文本和关键页面状态；
- 把最终结果返回给 agent CLI。

截图可以作为给用户看的证据，但不能成为 agent 的主要操作模型。agent 应该通过浏览器原生页面结构来操作：accessibility tree、DOM metadata、CDP target state、元素位置、role、label，以及稳定元素引用。

## 5. 可见浏览器要求

BMCP 必须有一个用户能在 VS Code 中清楚看到的浏览器界面。

它不是传统 headless browser MCP，也不是 screenshot-only skill。用户应该能看到页面打开、看到点击和输入发生、必要时中断，并且知道当前哪个网站正在被 agent 操作。

第一版可以很小，但可见浏览器必须是产品体验的一部分，而不是调试时才出现的附属窗口。

## 6. 网站交互的信任边界

BMCP 应该使用用户本地、可见的浏览器界面和浏览器原生交互通道，让网站接收到正常浏览器来源的动作，而不是页面脚本拼出来的合成快捷操作。

目标体验是：

- 默认路径不是 headless-only 浏览器；
- 主路径不是 screenshot-only 坐标点击；
- 不使用远程浏览器农场；
- 不创建一个独立的假 agent 浏览器身份；
- 浏览器事件应尽可能来自真实浏览器控制路径；
- 用户对自己授权的网站、会话和动作负责。

BMCP 不应该被定位为 CAPTCHA 绕过、反欺诈绕过、爬虫规避或安全控制规避工具。产品要求是避免由糟糕架构制造不必要的自动化特征，而不是帮助用户对抗网站的保护机制。

## 7. 首个演示网站场景

首个演示应该使用一个安全、可公开复现的网站，证明产品闭环，而不需要真实用户凭证。

推荐首个场景：

1. 用户在 BMCP workspace 中打开 VS Code。
2. 用户在 VS Code terminal 中启动自己已有的本地 agent CLI。
3. agent 请求 BMCP 在 VS Code 中打开一个可见浏览器。
4. BMCP 导航到 `https://www.saucedemo.com/`。
5. agent 收到结构化页面快照，而不是只有截图。
6. agent 填入用户名 `standard_user` 和密码 `secret_sauce`。
7. agent 点击 Login。
8. 可见浏览器显示商品列表页面。
9. agent 读取页面状态，并报告商品列表已经可见。

SauceDemo 适合第一版演示，因为它是稳定的浏览器自动化演示网站，表单字段稳定，也不涉及真实用户数据。如果后续更希望完全本地化演示，同一流程可以迁移到仓库内的静态 fixture 页面。

## 8. 非目标范围

BMCP 第一版不做这些事：

- 构建一个新的通用 agent CLI；
- 替代 Claude Code、Codex、Cursor Agent、Gemini CLI、Copilot 或其他本地 agent；
- 成为大型托管浏览器自动化平台；
- 运行隐藏的远程浏览器会话；
- 提供规模化爬取、代理轮换、指纹伪装、CAPTCHA 解决或 anti-bot bypass 工具；
- 把截图作为 agent 理解页面控件的主路径；
- 要求用户先学习新的浏览器自动化 DSL 才能跑通首个演示；
- 在证明 VS Code 可见浏览器工作流之前，优先优化 CI headless testing。

## 9. 成功标准

第一版产品切片成功，必须同时满足：

- 本地 agent CLI 可以触发 VS Code 中的可见浏览器。
- 用户能看到 agent 正在操作的网站。
- 浏览器动作闭环支持导航、快照、点击、输入、等待和读取结果。
- agent 能拿到结构化的元素级信息，足以准确选择动作，而不是靠视觉猜测。
- 演示场景可以从 VS Code terminal 到可见浏览器再到 agent 最终结果完整跑通。
- 产品不要求用户采用新的 agent CLI。
- 设计把控制权留在用户本机和当前 workspace。
- 浏览器信任边界明确：真实可见浏览器路径、默认不走 headless、不把产品定位成规避风控工具。

## 10. 最小验收命令

对这份简报本身：

```bash
test -f docs/product-brief.zh.md
sed -n '1,260p' docs/product-brief.zh.md
rg -n "目标用户|核心浏览器动作|可见浏览器|首个演示网站场景|非目标范围|成功标准|本地 agent CLI|VS Code|结构化页面快照|稳定元素引用|不尝试成为新的 agent CLI|CAPTCHA 绕过|anti-bot bypass" docs/product-brief.zh.md
```

对后续首个实现切片：

```bash
node --check src/cli.js
node src/cli.js browser open https://www.saucedemo.com/
node src/cli.js browser snapshot
node src/cli.js browser demo saucedemo
```

如果实现阶段尚未创建 `src/cli.js`，当前路线图环节只需要执行简报验证命令。
