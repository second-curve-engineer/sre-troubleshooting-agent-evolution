import subprocess

def run(input: dict) -> dict:
    logs = "\n".join(input["logs"])
    stack = input["stack"]
    code = input["code"]

    prompt = f"""
你是一名资深后端工程师。请根据以下信息分析代码报错原因：

【日志】\n{logs}

【异常栈】\n{stack}

【源码】\n{code}

请指出可能的错误原因。
"""
    process = subprocess.Popen(["claude"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    output, error = process.communicate(prompt)
    if process.returncode != 0:
        raise RuntimeError(f"Claude CLI 调用失败: {error}")
    return {"root_cause": output.strip()}