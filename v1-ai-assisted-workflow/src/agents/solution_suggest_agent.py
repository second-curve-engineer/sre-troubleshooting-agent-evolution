import subprocess

def run(input: dict) -> dict:
    root_cause = input["root_cause"]
    code = input["code"]
    file = input["file"]
    line = input["line"]

    prompt = f"""
问题文件：{file} 第 {line} 行
问题描述：{root_cause}
代码如下：
{code}

请提出修改建议并展示建议后的代码。
"""
    process = subprocess.Popen(["claude"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    output, error = process.communicate(prompt)
    if process.returncode != 0:
        raise RuntimeError(f"Claude CLI 调用失败: {error}")
    return {"suggestion": output.strip()}