# 运行与维护

> English version: [README.md](./README.md)

运行与维护文档面向已经完成首次使用、需要持续运行 Farming 的用户。

## 常用操作

| 命令 | 用途 |
| --- | --- |
| `farming daemon` | 在后台启动 Farming。 |
| `farming status` | 查看 Farming 是否正在运行。 |
| `farming url` | 输出当前本机 URL。 |
| `farming logs` | 查看服务日志。 |
| `farming stop` | 停止 Farming。 |

运行 `farming --help` 查看当前安装版本的完整命令列表。Browser 命令通过
`farming browser --help` 逐步披露。

## 部署与访问

- [安全与可信网络说明](../../SECURITY.zh_cn.md)
- [运行依赖版本与更新绑定](runtime-dependencies.zh_cn.md)
- [连接外部 CDP 浏览器](../products/code/external-cdp-browser.zh_cn.md)

远程连接经过不可信网络时，请使用 VPN、SSH Tunnel、HTTPS Reverse Proxy 或等价访问控制。

## 排障

先执行 `farming status` 和 `farming logs`。服务未运行时执行 `farming daemon`。
Agent 或 Browser 不可用时，先阅读 Farming 中显示的能力状态与错误信息，再修改设置。

在 [GitHub Issues](https://github.com/zhuwenzhuang/farming/issues) 报告问题时，请提供
Farming 版本、Host 平台、相关日志片段和用户可见的精确错误；不要提供 Token 或私有
仓库内容。
