# V3：Workflow-first Lightweight Agent Harness

这里先保留第三版的占位目录。

V3 不再完全依赖框架抽象，而是回到 workflow-first 的 lightweight harness，重点解决生产故障排查 Agent 的几个核心问题：

- 问题分类。
- 上下文预解析。
- workflow 路由。
- step 级工具白名单。
- trace 持久化。
- eval 回归。

V3 带来的关键认知是：

> 对生产故障排查来说，可控性和可调试性不是锦上添花，而是 Agent 系统能否落地的前提。真正有用的 Agent 需要一个围绕模型的 harness。

