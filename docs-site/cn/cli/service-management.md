# 服务管理

Farming 可以作为后台服务持续运行。浏览器断开不会自动停止服务或 Agent。

## 启动

```bash
farming daemon
```

需要临时前台观察启动输出时，可以使用：

```bash
farming start
```

## 查看状态

```bash
farming status
```

状态检查用于确认服务是否运行、当前实例位置和基本连接信息。不要只根据浏览器是否能打开判断后台进程状态。

## 查看地址

```bash
farming url
```

该命令只在当前配置实例已经运行时输出地址。新的浏览器需要使用有效的带鉴权 URL。

## 查看日志

```bash
farming logs
```

报告问题前，截取与失败时间相邻的必要日志。删除 Token、私有路径、仓库内容和账号信息。

## 停止

```bash
farming stop
```

停止服务会中断当前浏览器连接，并影响仍在运行的 Agent。执行前先确认重要任务已经到达可恢复状态。

## 自定义实例参数

```bash
farming daemon --port 6694 --base-path /farming --config-dir /path/to/config
```

自定义配置目录必须使用明确、专用的位置。不要让两个实例共享同一可变配置根，也不要用宽泛清理命令处理多个实例。
