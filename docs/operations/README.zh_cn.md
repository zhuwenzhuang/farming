# 运行与维护

> English version: [README.md](./README.md)

普通服务命令和故障排查统一在在线文档维护：

- [服务管理](https://zhuwenzhuang.github.io/farming/cn/cli/service-management)
- [故障排查](https://zhuwenzhuang.github.io/farming/cn/help/troubleshooting)
- [手机与远程使用](https://zhuwenzhuang.github.io/farming/cn/code/mobile-and-remote)

仓库文档继续保存运行和安全契约：

- [安全与可信网络说明](../../SECURITY.zh_cn.md)
- [运行依赖版本与更新绑定](runtime-dependencies.zh_cn.md)
- [连接外部 CDP Browser](../products/code/external-cdp-browser.zh_cn.md)
- [配置实例隔离](../development/config-instance-isolation.zh_cn.md)

常用生命周期命令仍是 `farming daemon`、`farming status`、`farming logs`、
`farming url` 与 `farming stop`。当前安装版本的权威命令列表以 `farming --help` 为准。

`farming-server.json` 是运行中 Server 的临时控制元数据，并非持久监控 API。成功执行
`farming stop` 会删除它，因此 stop 后文件不存在是预期行为，不表示空状态或文件损坏。
监控应使用 `farming status --config-dir PATH` 判断生命周期状态，并用 HTTP readiness
检查服务可用性；不能只根据该文件是否存在得出结论。
