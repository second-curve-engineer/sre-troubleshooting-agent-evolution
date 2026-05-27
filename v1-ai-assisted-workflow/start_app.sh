#!/bin/bash

# AI问题诊断工具 - 双模式启动脚本

echo "🚀 启动AI智能问题诊断工具（双模式版）..."
echo "📍 当前目录: $(pwd)"
echo "⏰ 启动时间: $(date)"
echo ""

# 检查Python环境
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 未安装"
    exit 1
fi

# 检查Streamlit
if ! python3 -c "import streamlit" &> /dev/null; then
    echo "⚠️  Streamlit 未安装，正在安装..."
    pip3 install streamlit
fi

# 检查streamlit命令是否可用
if ! command -v streamlit &> /dev/null; then
    echo "⚠️  streamlit命令不在PATH中，将使用 python3 -m streamlit"
    STREAMLIT_CMD="python3 -m streamlit"
else
    STREAMLIT_CMD="streamlit"
fi

echo "✅ 环境检查完成"
echo ""
echo "🌐 启动双模式Web界面..."
echo ""
echo "🔧 支持两种诊断模式:"
echo "   1️⃣ 🔍 Trace ID 诊断 - 完整5步流程"
echo "   2️⃣ 📝 异常栈诊断 - 快速3步流程"
echo ""
echo "💡 功能特性:"
echo "   ✅ 智能代码定位"
echo "   ✅ AI根因分析"
echo "   ✅ 自动解决方案生成"
echo "   ✅ 多语言支持"
echo ""
echo "🛑 按 Ctrl+C 停止服务"
echo "=================================="

# 启动Streamlit应用
$STREAMLIT_CMD run app.py --server.port 8501 --server.address 0.0.0.0