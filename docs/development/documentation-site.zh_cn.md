# 公开文档站

> English version: [documentation-site.md](./documentation-site.md)

公开文档站是位于 `docs-site/` 下的独立 VitePress 项目。它的依赖、锁文件、构建命令
和 CI 工作流都与 Farming 应用分离；持久架构和维护者契约继续放在 `docs/` 中。

## 内容边界

公开站只描述已经适合解释和支持的用户行为。仍处于草稿阶段的 Surface 不进入站点。
已经实现但缺少代表性真实案例的能力，只能放入实验性功能分组，并在页面首屏显示明确的
实验性标识。

第一轮只准备中文内容。等中文信息架构和正文经过 Review 并稳定后，再增加英文公开页面。

## 展示契约

公开站首先是文档入口，不是产品营销页。首页保持简短并以任务为中心：先用简短的用户视角
介绍 Farming，再提供 Code、CRT、常用能力、插件和工作流入口。产品操作截图放在解释对应
界面的具体页面；首页 Hero 可以使用克制的、随主题变化的品牌视觉。Code 与 CRT 是两个主要
界面；Browser 和其他可选能力属于插件或实验性功能，不得作为同级顶层产品展示。

首屏可以轻量使用 Farming 的暖色视觉，正文阅读区应保持安静和高对比度。优先使用系统
字体、稳定布局、克制的卡片和直接的用户语言；避免自造口号、超大宣传区、客户背书式布局
或重复罗列功能。截图用于解释具体界面或工作流，是文档证据，不能代替正文。

## 本地命令

```bash
cd docs-site
npm ci
npm run dev
npm run build
npm run preview
```

`npm run build` 是链接和静态构建的权威检查。公开站使用的产品截图放在
`docs-site/cn/assets/`，必须使用匿名工作区，不得包含私有 Host、Token 或草稿界面。

在仓库根目录重新生成产品截图：

```bash
npm run docs:product:screenshots
```

需要生成选定界面的深色版本、同时保留暖色原图时：

```bash
FARMING_SCREENSHOT_APPEARANCE=dark \
FARMING_SCREENSHOT_FILES=05-mobile-agent-chat.png,11-code-agent-process.png \
npm run docs:product:screenshots
```

该命令使用匿名、确定性的工作区和 Agent Fixture，对构建后的真实 Farming UI 进行
截图；它会更新产品文档的权威截图，并把公开站所需图片同步到
`docs-site/cn/assets/`。不要用手工拼接的效果图替代这些真实截图。
深色截图使用 `-dark` 文件名后缀；Usage activity、Farming CRT 等原生深色界面继续使用
权威文件名，不生成无意义的重复副本。

Farming Browser 的插件与 Viewer 截图由 Browser 专项 E2E 场景生成，仍然来自真实
界面，但暂不由上述主截图命令同步。修改 Browser 截图时，应运行对应的 Browser E2E
截图流程并同时检查公开站引用。

不要把文档站依赖加入根 `package.json`，不要使用 npm workspace，也不要让 Farming
应用构建依赖这个项目。

## 发布

`.github/workflows/docs.yml` 从 `main` 构建文档，并把静态产物部署到 GitHub Pages。
仓库的 Pages Source 需要设置为 GitHub Actions。项目站默认 Base Path 为 `/farming/`；
未来使用独立域名时，可以通过 `FARMING_DOCS_BASE` 覆盖。
Canonical 与 Sitemap 的站点 Origin 可以通过 `FARMING_DOCS_ORIGIN` 覆盖。
