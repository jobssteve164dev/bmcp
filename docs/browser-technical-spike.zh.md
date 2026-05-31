# VS Code 原生浏览器技术刺探

日期：2026-05-31

## 结论

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
