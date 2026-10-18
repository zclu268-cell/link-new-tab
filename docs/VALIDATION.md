# 本地验证记录

日期：2026-10-18。扩展版本：1.1.0。

项目整理后，使用 npm lockfile 中的开发依赖和迁移后的 tests/ 脚本重新验证。环境为 Windows、Node.js 24.18.0、Playwright 1.62.1、Chromium 153.0.8010.12。通过 CHROMIUM_EXECUTABLE_PATH 指定本机已缓存的测试浏览器；源码未包含本机路径。

| 检查 | 结果 |
| --- | --- |
| Manifest、资源引用、版本一致性、JavaScript 语法、固定路径检查 | 通过 |
| 链接浏览器测试 | 24 / 24 通过 |
| 画中画浏览器测试 | 21 / 21 通过 |
| 可选 YouTube 实站测试 | 通过 |

YouTube 使用 [Blender 官方公开视频](https://www.youtube.com/watch?v=aqz-KE-bpKQ)。实际视频播放后，点击扩展按钮成功进入浏览器画中画，未模拟画中画 API。

测试使用独立临时 profile，结束后清理；未使用日常 Chrome 的账号或配置。画中画测试以 headless 浏览器的进入/退出事件及 pictureInPictureElement 为依据，未目视验证操作系统悬浮窗的置顶、拖动或缩放。未执行远程 GitHub Actions，未完成日常 Chrome 安装或 Chrome 网上应用店发布。

可通过 README 中的命令重新验证；本地详细报告生成于 test-results/，不纳入源码包。
