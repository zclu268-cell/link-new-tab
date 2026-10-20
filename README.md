# 链接新开

一个轻量的 Chrome 扩展：点击普通网页链接时，在新标签页打开目标，保留当前页面；观看 YouTube 等 HTML5 视频时，可点击「小窗播放」进入独立的画中画窗口。

当前版本 **1.2.0**，使用 Manifest V3。运行时不需要账号、服务器或构建工具，不包含远程代码和统计服务。

## 功能

- **链接新开**：左键点击普通 HTTP / HTTPS 链接，新建标签页；支持自动切换到新标签页或在后台打开。
- **网站例外**：可以只对当前网站关闭链接新开。设置按完整域名匹配，`example.com` 与 `www.example.com` 分别设置；子框架使用顶层网站的设置。
- **视频小窗**：默认在扩展面板点击「显示小窗按钮」后才检测 HTML5 视频；也可开启自动显示；支持 YouTube 常见视频页面，使用浏览器原生画中画。
- **保留常用操作**：Ctrl / Command、Shift、Alt 点击及鼠标中键沿用浏览器原有行为；同页锚点、下载链接和邮件链接等不强制新开。
- **本地设置**：开关与网站例外只保存在本机。

## 安装与更新

需要 Chrome 109 或更新版本，建议使用当前稳定版。

### 从仓库安装

1. 下载本仓库 ZIP 并解压，或使用 `git clone` 克隆仓库。
2. 在 Chrome 地址栏输入 `chrome://extensions`。
3. 开启右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择仓库中的 **`extension` 文件夹**，其中应直接包含 `manifest.json`。
5. 刷新已打开的网页。可点击工具栏的拼图图标，将「链接新开」固定到工具栏。

不要选择仓库根目录或 ZIP 文件。请保留安装时所选的文件夹；移动或删除它后，需要重新加载正确位置。

更新源码后，在 `chrome://extensions` 点击扩展卡片上的「重新加载」，然后刷新需要使用扩展的网页。

**从 1.1.1 或更早版本升级：**替换安装目录中的文件后，必须先重新加载扩展，再刷新已打开的网页一次，或关闭旧标签重新打开。只更新磁盘文件无法修复旧网页中已经运行的脚本。

1.2.0 默认采用按需视频检测，升级后自动显示默认关闭。需要恢复原来的使用方式，可开启「自动显示视频按钮」。

已激活的视频脚本会在扩展重新加载或停用后，于旧网页下一次 DOM 变化、滚动、焦点或其他受监听的活动中检查扩展是否失效，并清理旧的视频按钮、监听器和待执行任务。此检查没有定时轮询；完全静止的网页不保证立即移除按钮。清理不会主动退出浏览器原生画中画，新版本功能仍需刷新网页后使用。

### 从发布包安装

本地执行 `npm run build` 会生成 `dist/link-new-tab-v1.2.0.zip`。解压后，选择**直接包含 `manifest.json` 的目录**加载。此 ZIP 仅包含扩展运行文件，也可作为 Chrome 网上应用店的上传包；生成发布包不代表已经上架。

## 使用方法

点击扩展图标，调整以下设置：

| 设置 | 效果 |
| --- | --- |
| 开启链接新开 | 控制链接新开功能；关闭后恢复网页原有点击行为 |
| 切换到新标签页 | 关闭后在后台打开新标签页，继续停留在原页面 |
| 在此网站启用 | 单独控制当前域名；仍受全局开关约束 |
| 自动显示视频按钮 | 默认关闭；开启后自动检测视频，关闭时停止所有页面的检测 |

安装并刷新网页后，调整设置即可生效。链接开关和网站例外不会关闭视频小窗功能。

观看视频时：

1. 打开 YouTube 等 HTTP / HTTPS 视频页面，并开始播放视频。
2. 点击扩展图标中的「显示小窗按钮」，再回到网页点击高亮的「小窗播放」。小窗可拖动和缩放，点击「退出小窗」或关闭小窗可返回原播放器。
3. 不再需要页面按钮时，点击「停止本页检测」，释放此页的视频监听；已经打开的小窗继续播放。

手动检测仅在本页找到视频后启动；没有视频的框架保持休眠。本页停止检测、全部视频移除或导航离开后，手动会话结束；SPA 后续新视频可再次点击「显示小窗按钮」。开启自动显示会持续发现新视频；「停止本页检测」会停止本页当前已加载的框架，直到手动恢复、切换自动开关或重新导航。自动模式下，之后新加载的内嵌播放器仍按全局设置运行；要让所有页面保持按需检测，请关闭「自动显示视频按钮」。

画中画期间请保留原视频标签页。浏览器要求直接的用户操作，扩展不会在加载网页时自动弹出视频窗口。

## 支持范围与限制

- 链接功能处理具有 HTTP / HTTPS 目标的普通 `<a>`、`<area>` 链接，包括动态加载的链接。纯 JavaScript 按钮跳转、地址栏导航不在范围内。
- 同页锚点、具有 `download` 属性的链接、`mailto:` / `tel:` / `javascript:` 链接、声明为按钮或页签等操作控件的链接保持原行为。
- Chrome 内部页面、Chrome 网上应用店、浏览器内置 PDF 阅读器等特殊页面不支持或可能不支持。
- 接管链接点击会阻止部分网页自定义点击逻辑执行。遇到登录、跳转或交互异常，可关闭「在此网站启用」。
- 视频小窗仅支持已经加载画面的 HTML5 `<video>`；纯音频、特殊播放器、封装在 **Shadow DOM** 中的视频暂不支持。
- 网站禁用画中画、iframe 权限策略或浏览器限制可能导致无法打开小窗；扩展会显示提示，不会绕过这些限制。
- 字幕、弹幕、清晰度菜单等网站控件不保证显示在原生画中画窗口中。网页切换视频后，可能需要重新点击按钮。

## 开发与验证

需要 **Node.js 22 或更新版本**。扩展本身不依赖 npm；以下依赖仅用于校验、测试和打包。

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run build
```

自动化测试使用独立浏览器配置和本地测试页面，覆盖链接行为、视频画中画、性能回归和脚本生命周期；默认运行无界面的 Chromium。性能测试通过 CDP 对真实扩展的 DOM 调用计数，不把网页加载耗时作为不稳定的通过门槛。视频测试中的后台恢复项模拟可见性输入；实际画中画 API 未被替换。生命周期检查覆盖扩展重载、停用后的清理及页面恢复。具体用例、结果和验证范围见 [验证记录](docs/VALIDATION.md)。Linux 如缺少系统库，可运行 `npx playwright install --with-deps chromium`。需要目视确认桌面悬浮窗的拖动、缩放和置顶时，请另行在桌面 Chrome 中手动验证。

默认模式下，视频脚本只读取一次设置并接收消息，不创建 DOM 观察器、不查询视频，也不绑定页面、媒体和滚动监听。链接新开被全局关闭或网站排除时，点击监听实际卸载。按需模式回归使用 `npm run test:on-demand`。

单独运行性能回归可使用 `npm run test:performance`；生命周期检查使用 `npm run test:lifecycle`。视频选择使用浏览器维护的可见候选集合，单次遍历选择播放器，不对全部视频排序；仅在视频增删或祖先结构变化时重建视频祖先集合，减少长视频列表和无关 DOM 更新带来的工作。这些优化不代表所有网站的加载耗时都会按固定比例下降。

YouTube 真实页面验证需要外网，作为可选检查单独执行：

```sh
npm run test:youtube
```

真实网站的广告、登录、地区限制或页面改版可能影响外网检查。自动化通过后，仍建议在日常使用的网站上手动检查普通链接、网站例外和视频小窗。

测试默认使用 Playwright 安装的 Chromium。如需使用已有的兼容测试浏览器，可通过 `CHROMIUM_EXECUTABLE_PATH` 环境变量指定可执行文件，无需修改源码。YouTube 测试退出码 `0` 表示通过，`1` 表示功能失败，`2` 表示因网络或网站限制而未完成验证。

`npm run build` 生成版本化的扩展 ZIP 及 SHA-256 校验文件。`dist/`、`test-results/` 和 `node_modules/` 不纳入 Git；请勿将个人浏览器配置、账号信息或测试缓存提交到仓库。

执行 `npm run package:source` 可生成干净的源码 ZIP，不包含依赖、浏览器配置和测试缓存。仓库附带 GitHub Actions 工作流，在推送或拉取请求时执行本地测试并生成构建产物；YouTube 外网测试不加入默认 CI。

## 仓库结构

```text
extension/          Chrome 可直接加载的扩展源码
tests/              链接、视频、性能、生命周期和可选 YouTube 浏览器测试
scripts/            源码校验与发布打包脚本
docs/               隐私说明与实现说明
dist/               本地生成的发布文件（Git 忽略）
test-results/       本地测试结果（Git 忽略）
CHANGELOG.md        版本变更
```

实现细节见 [架构说明](docs/ARCHITECTURE.md)，数据和权限说明见 [隐私说明](docs/PRIVACY.md)，本次检查结果见 [验证记录](docs/VALIDATION.md)。

## 上传到自己的 GitHub 仓库

先在 GitHub 创建空仓库，然后在**本项目根目录**执行以下命令。将 `<你的仓库URL>` 替换成实际地址；已存在 Git 仓库或远程地址时，按现有配置调整。

```sh
git init -b main
git add .
git commit -m "Initial release: link new tab and video picture-in-picture"
git remote add origin <你的仓库URL>
git push -u origin main
```

初次提交前，执行 `git status` 确认只包含计划公开的源文件。需要提供可下载安装包时，可将 `dist/` 中的 ZIP 和校验文件作为 GitHub Release 附件上传。

项目尚未指定开源许可证，公开授权前请自行选择并补充 `LICENSE`。

## 参考

- [OpenInNewTab](https://github.com/shiroixw/OpenInNewTab)：参考按网站启停点击监听的设计；未引入它的链接 DOM 改写与访问记录功能。
- [Google 官方画中画扩展](https://github.com/GoogleChromeLabs/picture-in-picture-chrome-extension)：参考用户操作后执行核心视频检测的方式；本扩展使用静态消息入口保持原有权限，未复制第三方源码。Google 项目另有自动画中画入口，不等同于完全没有常驻脚本。
- [Chrome：加载本地扩展](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
- [Chrome：内容脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome：Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome：Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome：视频画中画](https://developer.chrome.com/blog/watch-video-using-picture-in-picture)
