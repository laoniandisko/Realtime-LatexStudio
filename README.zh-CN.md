# SideX LaTeX Studio

[观看功能演示：56 秒，无声，界面操作动画](docs/media/demo.mp4)

**带项目主页、PDF 原位编辑和可配置智能体的本地 LaTeX 工作区。**

[English](README.md) · [项目优势与性能说明](docs/PROJECT_ADVANTAGES.zh-CN.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

在浏览器中使用 Monaco 编辑 TeX，在真实排版输出中编辑正文和公式，底部保留终端与智能体。项目主页提供新建、导入、搜索、排序、重命名、归档和恢复，无需云端账户。

本项目基于 [Sidenai/Sidex](https://github.com/Sidenai/sidex) 的基础依赖与 MIT 许可，接入 [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex)。公开仓库聚焦 LaTeX 应用，不包含上游完整桌面版与扩展平台。

## 主要功能

| 功能 | 使用方式 |
| --- | --- |
| 项目主页 | 网格/列表、搜索排序、最近项目、新建空白或文章、导入本地目录、改显示名、归档恢复 |
| 编辑工作区 | TeX 与 PDF 左右分栏、隐藏源码、拖动调整面板、文档大纲、文件搜索和本地终端 |
| 页面原位编辑 | 在可映射的正文中放置光标、选字、编辑整段和撤销，修改回写 TeX |
| 公式和定位 | 在公式附近修改 LaTeX 表达式；映射到字符的源码与页面双向定位 |
| 图片和表格 | 八方向尺寸柄、独立宽高、整体浮动体移动，保留 caption 与 label |
| 可选智能体 | 输入 API 地址和密钥后自动获取模型；支持粘贴图片、项目搜索和跨文件修改 |

每个项目拥有独立的文件根目录、会话令牌、终端、实时引擎和智能体任务。打开 B 项目后，A 页面仍保存到 A。模型设置在本机应用内共享。这里没有提供多人协同编辑或云端同步服务。

## Windows 一键启动

先安装 **Node.js 22.11+ LTS 或更新版本**。编译文档还需要 **TeX Live 或 MiKTeX**；尚未安装 TeX 时也能进入项目主页。

1. 下载或克隆完整仓库。
2. 双击 [一键启动.cmd](一键启动.cmd)，或 [Start-LaTeXStudio.cmd](Start-LaTeXStudio.cmd)。
3. 首次启动自动安装锁定的 npm 依赖，必要时构建，隐藏启动本地服务并打开 **http://127.0.0.1:1421/home**。
4. 新建项目，或导入已有目录，然后进入工作区。

首次安装依赖需要联网。启动器不会自动下载大型 TeX 发行版，也不修改全局 TeX 设置。如果服务已经运行，会复用服务并打开主页。

安装和构建会实时显示日志与已用时间；网络重试和阶段等待均有上限。若 npm 下载返回 502 或连接失败，请检查本机网络、代理或 npm 配置，并查看 `.runtime/npm.stdout.log` 和 `.runtime/npm.stderr.log`。依赖安装完成后，后续启动会复用已有依赖。

手动运行：

~~~sh
npm ci
npm run build
npm start
~~~

开发模式：

~~~sh
npm run dev
~~~

## 可选实时排版

普通编译使用本机可用的 pdfLaTeX、XeLaTeX 或 LuaLaTeX。实时段落排版使用 LuaLaTeX 和固定的 realtime-tex 0.0.6。

已验证的 Windows x64 路径需要 Python 3.9+ 和带 LuaLaTeX 的 TeX Live，然后执行：

~~~sh
npm run setup:rtex
~~~

安装脚本下载官方发行包并校验其公布的 SHA-256。仓库不包含原生引擎二进制。Windows 嵌入宿主校验 0.0.6 ABI；可选宿主不可用时回退到官方 CLI。

程序通过环境变量、本地配置、随项目安装的工具链、PATH 和标准安装目录发现 TeX。自定义路径可设置 SIDEX_TEXLIVE_BIN 或 SIDEX_TEX_BIN，也可创建被 Git 忽略的 .runtime/tex-config.json：

~~~json
{
  "bin": "C:/texlive/2026/bin/windows"
}
~~~

请填写自己机器上实际存在的 bin 目录，修改工具链配置后重启服务。

## 本地项目与数据位置

- 默认新项目保存在 **.local/projects**，项目目录索引为 **.local/projects.json**。
- 导入只登记已有目录，不复制或移动原文件。
- 重命名只更改显示名称；归档不会删除文件，归档后可以恢复。
- **.local 包含论文数据，不是可随意清理的缓存。** 移动或删除程序目录前，请先备份项目。
- 可用 SIDEX_PROJECTS_DIR 和 SIDEX_PROJECTS_STATE 指定外部项目库与索引文件。
- 运行时、构建产物、模型设置、日志和智能体备份位于被忽略的本地目录，不应随源码上传。

工作区的主页按钮会先保存待修改文件再返回项目列表。每个项目会记住所选主文档，其他可独立编译的 .tex 文件也能设为主文件。

## 模型配置与数据边界

在模型设置中输入 API 基础地址和密钥，程序请求模型目录，再从目录选择模型，不必手动输入 ID。聊天请选择聊天模型；图片消息需要所选模型支持图像输入。

API 密钥只保存在当前服务进程内存中，重启服务后需要重新输入。非敏感设置和模型目录保存在本机。公开版本不会读取其他程序配置中的凭据。

智能体是可选功能。使用时，消息、所选上下文、图片和工具结果会发送到你配置的 API。项目工具可读取、搜索和修改当前项目中的文件，显示执行记录与差异，并保留本地修改备份。

## 排版能力与边界

实时路径重新排版受影响的段落，按真实 TeX 字形数据绘制；分页、引用和浮动图表由后台完整排版处理。近似或越界的局部结果保留上一份有效 PDF，输入节点继续可用，未完成语法不必丢弃当前输入。

公式目前编辑的是 LaTeX 表达式，并非可视化数学符号编辑器。图表的最终位置遵循模板的浮动规则。复杂宏、依赖页面状态的内容及不兼容模板可能需要源码编辑或完整编译。LuaLaTeX 与 pdfLaTeX 可能产生不同断行和分页，最终输出请使用投稿要求的引擎。

## 验证与开发

~~~sh
npm test
npm run typecheck
npm run build
npm run test:session
npm run test:page-tools
npm run test:host
~~~

后三项集成测试需要原生实时运行时与兼容 TeX 工具链。默认测试会在缺少前置条件时跳过相关原生用例。当前主要在 Windows 验证，其他系统取决于当地 TeX 与终端工具链。

[优势说明](docs/PROJECT_ADVANTAGES.zh-CN.md) 区分了引擎、控制器下发和完整 PDF 可用等指标。测量不包含浏览器绘制，也不构成所有项目的延迟保证；本项目不宣称整篇编译只需 1ms。

## 许可证与来源

采用 [MIT 许可证](LICENSE)，保留上游版权声明。两个 vendor 目录保留 Henry Yang 的 MIT 许可。Codicons 的 CC BY 4.0、PDF.js 的 Apache 2.0 等依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
