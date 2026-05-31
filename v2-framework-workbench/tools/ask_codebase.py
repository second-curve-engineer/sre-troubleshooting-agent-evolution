from __future__ import annotations

import subprocess
from pathlib import Path

from agno.tools import tool


MOCK_ANSWERS = {
    "inventory-service": """代码库分析结果:
- 相关文件: src/main/java/com/example/inventory/InventoryService.java
- 相关方法: InventoryService.reserve(String skuId, int quantity)
- 关键逻辑: 方法从 InventoryRepository.findBySkuId(skuId) 获取库存对象后直接调用 inventory.getAvailable()。
- 疑似根因: 当 SKU-10086 没有库存记录或缓存穿透时，repository 返回 null，代码没有判空，导致 NullPointerException。
- 修复建议: 对 inventory 为空增加显式分支，返回可识别的业务错误；同时补充缺失 SKU 的日志字段和单元测试。
""",
    "order-service": """代码库分析结果:
- 相关文件: src/main/java/com/example/order/OrderService.java
- 相关方法: OrderService.createOrder(CreateOrderRequest request)
- 关键逻辑: order-service 调用 inventory-service reserve 接口，捕获远程异常后统一包装为 RemoteServiceException。
- 判断: order-service 是错误传播点，不是最初抛出空指针的位置。
- 建议: 保留 trace_id 和 skuId 字段，方便继续定位 inventory-service 根因。
""",
}


class CodebaseToolFactory:
    def __init__(self, codebases: dict[str, str], enable_claude_code: bool = False):
        self.codebases = codebases
        self.enable_claude_code = enable_claude_code
        # per-session 跟踪已访问过的代码库目录。
        # key: session_id， value: set of resolved dir paths
        # 修复前的 bug：实例级共享一个 set，导致不同 session 之间污染 -c 标志。
        self._session_continued_dirs: dict[str, set[str]] = {}

    def build(self):
        @tool
        def ask_codebase(base_dir: str, question: str, session_id: str = "") -> str:
            """Ask a configured codebase a targeted troubleshooting question.

            Supported demo codebases:
            - order-service
            - inventory-service
            - payment-service

            Args:
                base_dir: Codebase key or directory path. Prefer service keys such as inventory-service.
                question: Specific question with exception type, method, stack frame, or trace context.
                session_id: Optional session identifier for context reuse within the same conversation.

            Returns:
                Code analysis result. In mock mode this returns deterministic demo evidence.
            """
            # TODO(v3): record code question, answer, latency, and source files as trace evidence.
            codebase_key = self._normalize_codebase_key(base_dir)
            resolved_dir = self.codebases.get(codebase_key, base_dir)
            mock_key = self._normalize_codebase_key(resolved_dir)

            if not self.enable_claude_code:
                return MOCK_ANSWERS.get(
                    codebase_key,
                    MOCK_ANSWERS.get(
                        mock_key,
                        "代码库分析结果: 当前公开 demo 未配置该代码库的 mock 回答。请检查 base_dir 是否为 order-service、inventory-service 或 payment-service。",
                    ),
                )

            return self._ask_claude_code(resolved_dir, question, session_id)

        return ask_codebase

    def _normalize_codebase_key(self, base_dir: str) -> str:
        raw = base_dir.strip()
        if raw in self.codebases:
            return raw
        return Path(raw).name

    def _ask_claude_code(self, base_dir: str, question: str, session_id: str = "") -> str:
        path = Path(base_dir).expanduser()
        if not path.exists():
            return f"代码库不存在: {base_dir}"

        command = ["claude", "-p", question]
        dir_key = str(path.resolve())

        # 每个 session 独立跟踪已访问目录，避免不同 session 之间污染 -c 标志。
        # 如果没有传入 session_id，回退为实例级共享模式（与修复前行为一致）。
        if session_id:
            session_dirs = self._session_continued_dirs.setdefault(session_id, set())
        else:
            # 单个用户本地使用时没有 session_id，依然允许实例级共享
            session_dirs = self._session_continued_dirs.setdefault("__default__", set())

        if dir_key in session_dirs:
            command.insert(1, "-c")
        session_dirs.add(dir_key)

        try:
            result = subprocess.run(
                command,
                cwd=path,
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except FileNotFoundError:
            return "未找到 claude CLI。可以设置 ENABLE_CLAUDE_CODE=false 使用 mock mode。"
        except subprocess.TimeoutExpired:
            return "claude CLI 调用超时。"

        if result.returncode != 0:
            return f"claude CLI 调用失败:\n{result.stderr.strip()}"
        return result.stdout.strip()


def build_ask_codebase_tool(codebases: dict[str, str], enable_claude_code: bool = False):
    return CodebaseToolFactory(codebases, enable_claude_code).build()
