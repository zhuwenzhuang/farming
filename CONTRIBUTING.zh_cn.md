# 贡献指南

> English version: [CONTRIBUTING.md](./CONTRIBUTING.md)

感谢你帮助改进 Farming。

## 开发环境

```bash
npm install
npm start
```

仅在可信本地开发环境中，可以关闭 token 校验：

```bash
npm run start:no-auth
```

## 提交 PR 前

根据改动范围运行对应检查：

```bash
npm test
npm run typecheck
npm run lint
```

如果改动影响浏览器界面或交互，也运行：

```bash
npm run test:e2e:playwright
```

同时请实际打开产品走一遍受影响流程，确认使用效果。涉及可见界面或交互变化时，建议在 PR 中附上截图或短视频。

如果改动影响产品截图或产品文档，也运行：

```bash
npm run docs:product:screenshots
```

## 文档同步

当行为、打包方式、配置或用户可见流程变化时，请在同一个改动中更新相关文档。

- 根项目介绍：`README.md` 和 `README.zh_cn.md`
- Agent 开发说明：`AGENTS.md` 和 `AGENTS.zh_cn.md`
- Farming Code 产品文档：`docs/products/code/README.md` 和 `docs/products/code/README.zh_cn.md`

不要把公开聊天记录或临时调试记录加入仓库。

## 发布卫生

不要提交 release binary、内部机器地址、个人机器路径、token、真实 `.env` 文件，或包含隐私信息的截图。

产品截图应使用示例主机名、匿名路径，或者在内容适合公开时使用 Farming 仓库本身。
