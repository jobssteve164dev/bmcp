# SoloBrowser：VS Code 可见浏览器技术决策

日期：2026-05-31

## 结论

2026-07-16 更新：SoloBrowser 使用“托管系统浏览器运行时 + WebRTC 低延迟显示 + CDP 控制”的主方案。它优先使用本机稳定版 Chrome、Edge 或 Chromium，以持久 Profile 保留真实会话，并且不改写 User-Agent 或注入虚假指纹；没有可用系统浏览器时才按需安装 Chrome for Testing。WebRTC 承担画面显示，CDP 承担导航、输入、快照和 Agent API 控制，旧 CDP/JPEG 画面流只作为备用显示。

同日的 Coder 延迟审计进一步冻结数据面边界：Agent 的快照与操作始终在远程宿主内通过本机 CDP 完成；WebRTC 直接承担远程浏览器到 Webview 的视频下行，并通过 DataChannel 直接承载人工接管输入。可靠有序通道用于点击、键盘和视口尺寸，低延迟无重传通道用于鼠标移动与滚轮；VS Code 消息链只作为 DataChannel 尚未就绪时的兼容回退。插件负责会话和状态编排，不再作为高频人工输入的数据转发层。

以下 2026-05-31 结论保留为历史刺探记录，其中“优先使用 VS Code 原生浏览器入口”已不再作为 BMCP 主路径。

BMCP 不应继续把“外部 Chrome 画面流桥接进 VS Code”作为主体验。这个方向会持续暴露字体、焦点、坐标、延迟和输入法问题，用户感知也不是 VS Code 原生浏览器。

当前环境里可用的 VS Code 原生浏览器能力分成两类：

- `workbench.action.browser.open`：VS Code Integrated Browser 入口。当前 code-server 环境未注册该命令，不能作为当前可落地依赖。
- `simpleBrowser.api.open` / `simpleBrowser.show`：VS Code 内置 Simple Browser 入口。当前环境可调用，底层是 Webview 内的 iframe。

## 已验证事实

本地安装的 Live Preview：`ms-vscode.live-server@0.4.18`。

Live Preview 的 embedded preview 实现方式：

- 启动本地 HTTP server。
- 创建 `WebviewPanel`。
- 在 Webview 内放入导航栏和 `<iframe id="hostedContent" src="..."></iframe>`。
- 只允许 iframe 加载 Live Preview 自己的本地 HTTP server 地址。
- 对可注入 HTML 注入 `injectScript.js`，用于 URL/title 同步、刷新、console 转发、查找等。
- 外链不是 embedded preview 主路径，点击外链会通知扩展打开外部浏览器。

关键文件：

- `.research/vscode-livepreview/src/editorPreview/previewManager.ts`
- `.research/vscode-livepreview/src/editorPreview/webviewComm.ts`
- `.research/vscode-livepreview/media/injectScript.js`

Live Preview 的 Integrated Browser 入口：

```ts
vscode.commands.executeCommand('workbench.action.browser.open', {
  url,
  openToSide: true,
  reuseUrlFilter: '**?vscode-livepreview=true'
});
```

当前 code-server 命令探测结果：

- `workbench.action.browser.open`：不存在，直接调用报 `command 'workbench.action.browser.open' not found`。
- `simpleBrowser.api.open`：存在并可调用。
- `simpleBrowser.show`：存在并可调用。

内置 Simple Browser 实现方式：

- 路径：`/usr/lib/code-server/lib/vscode/extensions/simple-browser`
- README 明确说明它是 “using an iframe embedded in a webview”。
- 编译产物中 CSP 使用 `frame-src *`，页面主体是 `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"></iframe>`。
- 扩展侧只能打开 URL 和控制外壳，不直接获得任意公网页面 DOM。

## 对 BMCP 的影响

更符合产品目标的路线不是自建视频流浏览器，而是：

1. 优先使用 VS Code 原生浏览器入口作为用户可见界面。
2. 当前 code-server 环境可先基于 Simple Browser / 自建 Webview iframe 做最小原生体验。
3. 对可注入页面提供 DOM snapshot、点击、输入等 agent 控制。
4. 对不可注入的公网网站，不承诺完整底层 DOM 控制；需要单独确认 Integrated Browser 或 VS Code 内部 browser tools 是否开放稳定 API。

## 建议下一步

下一轮不要继续修画面流桥接。建议做一个 BMCP 分支实验：

- `/open` 默认调用 `simpleBrowser.api.open` 打开 URL。
- 同时保留一个 BMCP 自有 Webview iframe 模式，用于可注入页面的 DOM 控制验证。
- 先用一个本地 HTML demo 和一个公网普通页面验证原生面板体验。
- 再单独验证 B 站这类登录站点是否能在 Simple Browser 内正常显示、登录和交互。

只有当 Integrated Browser 在目标部署环境中可用，并且能暴露可控接口时，才把“任意公网网站 + 精确底层元素控制”重新纳入首版主路径。
