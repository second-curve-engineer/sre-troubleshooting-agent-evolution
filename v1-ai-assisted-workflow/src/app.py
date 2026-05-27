import streamlit as st
import sys
import json
import traceback
from datetime import datetime
import os
import time
import threading
import pickle
from typing import List

# 添加agents目录到path
sys.path.append('agents')

# 导入agents
try:
    from code_locator_agent import run as code_locator
    from root_cause_analysis_agent import run as root_cause_analyzer
    from solution_suggest_agent import run as solution_suggester
    from trace_log_query_agent import run as trace_query, run_error_code_query
    from stack_trace_analyze_agent import run as stack_analyzer
except ImportError as e:
    st.error(f"Agent导入失败: {e}")

# 任务持久化相关函数
# 使用项目目录下的临时文件夹，更安全和规范
TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp_tasks")
if not os.path.exists(TEMP_DIR):
    os.makedirs(TEMP_DIR)

def save_task_state(task_id: str, state: dict):
    """保存任务状态到临时文件"""
    try:
        task_file = os.path.join(TEMP_DIR, f"{task_id}.pkl")
        with open(task_file, 'wb') as f:
            pickle.dump(state, f)
    except Exception as e:
        print(f"保存任务状态失败: {e}")

def load_task_state(task_id: str) -> dict:
    """从临时文件加载任务状态"""
    try:
        task_file = os.path.join(TEMP_DIR, f"{task_id}.pkl")
        if os.path.exists(task_file):
            with open(task_file, 'rb') as f:
                return pickle.load(f)
    except Exception as e:
        print(f"加载任务状态失败: {e}")
    return {}

def cleanup_task_state(task_id: str):
    """清理任务状态文件"""
    try:
        task_file = os.path.join(TEMP_DIR, f"{task_id}.pkl")
        if os.path.exists(task_file):
            os.remove(task_file)
    except Exception as e:
        print(f"清理任务状态失败: {e}")

def get_task_id() -> str:
    """获取当前会话的任务ID"""
    if 'task_id' not in st.session_state:
        st.session_state.task_id = f"task_{int(time.time())}_{hash(str(datetime.now()))}"
    return st.session_state.task_id

def check_interrupted_task():
    """检查是否有被中断的任务"""
    task_id = get_task_id()
    task_state = load_task_state(task_id)
    
    if task_state.get('diagnosing', False):
        st.warning("⚠️ 检测到未完成的诊断任务")
        col1, col2 = st.columns(2)
        
        with col1:
            if st.button("🔄 恢复任务"):
                st.session_state.diagnosing = task_state.get('diagnosing', False)
                st.session_state.diagnosis_type = task_state.get('diagnosis_type', None)
                st.session_state.interrupted_task = task_state
                st.info("✅ 任务状态已恢复，但需要重新运行诊断")
                
        with col2:
            if st.button("🗑️ 清除任务"):
                cleanup_task_state(task_id)
                st.success("✅ 已清除未完成的任务")

def run_full_diagnosis(trace_id: str, time_range_hours: int = None):
    """完整诊断流程：基于trace_id调用5个agent"""
    results = {}
    
    try:
        # 步骤1：查询日志
        st.write("🔍 **步骤1：查询日志平台...**")
        with st.spinner("正在查询日志平台API..."):
            step1_result = trace_query({'trace_id': trace_id, 'time_range_hours': time_range_hours})
        
        results['step1'] = step1_result
        
        if not step1_result.get('success', False):
            st.error(f"❌ 日志查询失败: {step1_result.get('error', '未知错误')}")
            return results
            
        log_count = step1_result.get('log_count', 0)
        services = step1_result.get('services', [])
        used_real_data = step1_result.get('note', '') == ''  # 没有note说明使用了真实数据
        
        if used_real_data:
            st.success(f"✅ 日志查询完成，从 {len(services)} 个服务获取到 {log_count} 条日志")
        else:
            st.warning(f"⚠️ 使用模拟数据，获取到 {log_count} 条日志（{step1_result.get('note', '')}）")
        
        # 显示查询详情
        with st.expander("📊 查询详情", expanded=False):
            col1, col2 = st.columns(2)
            with col1:
                st.write("**查询服务:**")
                for service in services:
                    st.write(f"- {service}")
                    
            with col2:
                query_time_range = step1_result.get('query_time_range', '')
                if query_time_range:
                    st.write(f"**时间范围:** {query_time_range}")
                st.write(f"**日志条数:** {log_count}")
        
        # 显示部分日志内容
        logs = step1_result.get('logs', [])
        if logs:
            with st.expander("📋 日志预览 (前5条)", expanded=False):
                for i, log in enumerate(logs[:5]):
                    st.text(f"{i+1}. {log}")
                if len(logs) > 5:
                    st.caption(f"... 还有 {len(logs) - 5} 条日志")
        
        # 步骤2：解析异常栈和调用链
        st.write("🔍 **步骤2：分析异常栈和调用链...**")
        with st.spinner("正在分析异常信息和请求链路..."):
            # 传递完整的step1_result给stack_analyzer，包括important_info
            step2_result = stack_analyzer(step1_result)
        
        results['step2'] = step2_result
        
        if not step2_result.get('success', False):
            st.error(f"❌ 异常栈分析失败: {step2_result.get('error', '未知错误')}")
            return results
        
        has_exception = step2_result.get('has_exception', False)
        used_real_api_data = step2_result.get('analysis_summary', {}).get('used_real_api_data', False)
        
        if has_exception:
            if used_real_api_data:
                st.success("✅ 发现真实异常，异常栈分析完成")
            else:
                st.warning("⚠️ 异常栈分析完成（基于模拟数据）")
        else:
            st.info("ℹ️ 未发现异常信息，继续进行调用链分析")
        
        # 显示分析结果
        with st.expander("🔍 分析详情", expanded=False):
            analysis_summary = step2_result.get('analysis_summary', {})
            col1, col2 = st.columns(2)
            
            with col1:
                st.write("**涉及服务:**")
                for service in analysis_summary.get('services_involved', []):
                    st.write(f"- {service}")
                
            with col2:
                st.write(f"**异常状态:** {'有异常' if has_exception else '无异常'}")
                st.write(f"**请求参数:** {'有' if analysis_summary.get('has_request_params') else '无'}")
                if has_exception:
                    error_service = analysis_summary.get('error_service', 'unknown')
                    st.write(f"**错误服务:** {error_service}")
        
        # 如果有异常栈，显示主要错误位置
        main_error_location = step2_result.get('main_error_location')
        if main_error_location:
            with st.expander("🎯 主要错误位置", expanded=True):
                st.write(f"**文件:** {main_error_location.get('file', 'N/A')}")
                st.write(f"**方法:** {main_error_location.get('method', 'N/A')}")
                st.write(f"**行号:** {main_error_location.get('line', 'N/A')}")
                st.write(f"**服务:** {main_error_location.get('service', 'N/A')}")
                is_our_service = main_error_location.get('is_our_service', False)
                if is_our_service:
                    st.success("✅ 这是我们负责的服务，可以进行代码定位")
                else:
                    st.warning("⚠️ 这不是我们负责的服务")
        
        # 步骤3-5：使用现有的agent继续处理
        stacktrace = step2_result.get('stacktrace', step2_result.get('stack', ''))
        if not stacktrace and has_exception:
            # 如果没有格式化的栈信息，尝试从异常信息中获取
            exception_info = step2_result.get('exception_info', {})
            stacktrace = exception_info.get('exception_stacktrace', '')
        
        return run_remaining_steps(logs, stacktrace, results)
        
    except Exception as e:
        st.error(f"❌ 完整诊断过程中出现错误: {e}")
        st.error(f"错误详情: {traceback.format_exc()}")
        return results

def run_error_code_diagnosis(api_path: str, error_code: str, time_range_hours: int = None, selected_services: List[str] = None):
    """错误码诊断流程：两步诊断法
    
    第一步：根据接口+错误码查询日志，提取trace_id
    第二步：复用trace_id诊断流程进行完整分析
    """
    results = {}
    
    try:
        # 执行两步诊断法
        st.write("🔍 **步骤1：根据接口路径和错误码查询日志...**")
        with st.spinner("正在查询错误日志并提取trace_id..."):
            step1_result = run_error_code_query({
                'api_path': api_path,
                'error_code': error_code,
                'time_range_hours': time_range_hours,
                'selected_services': selected_services
            })
        
        results['step1'] = step1_result
        
        if not step1_result.get('success', False):
            # 显示错误信息
            error_step = step1_result.get('step', 'unknown')
            st.error(f"❌ 错误码查询失败 ({error_step}): {step1_result.get('error', '未知错误')}")
            
            # 显示详细错误信息
            if error_step == "query_logs":
                error_details = step1_result.get('error_details', {})
                if error_details:
                    st.markdown("**🔍 查询详情:**")
                    st.write(f"- 接口路径: `{error_details.get('api_path', 'N/A')}`")
                    st.write(f"- 错误码: `{error_details.get('error_code', 'N/A')}`")
                    st.write(f"- 查询条件: `{error_details.get('query_condition', 'N/A')}`")
                    st.write(f"- 时间范围: 最近{error_details.get('query_time_range_hours', 24)}小时")
                    
                    suggestions = error_details.get('suggestions', [])
                    if suggestions:
                        st.markdown("**💡 建议:**")
                        for suggestion in suggestions:
                            st.write(f"- {suggestion}")
            elif error_step == "extract_trace_id":
                st.markdown("**📊 查询统计:**")
                st.write(f"- 找到的日志数: {step1_result.get('found_logs', 0)}")
                st.write(f"- 日志字段示例: {step1_result.get('sample_log_fields', [])}")
                st.warning("⚠️ 日志中可能没有trace_id字段，或字段名不匹配")
            
            return results
        
        # 显示成功信息
        error_code_context = step1_result.get('error_code_context', {})
        if error_code_context:
            st.success("✅ 错误码查询成功")
            
            col1, col2, col3 = st.columns(3)
            with col1:
                st.metric("初始日志数", error_code_context.get('initial_logs_found', 0))
            with col2:
                st.metric("提取trace_id数", error_code_context.get('trace_ids_extracted', 0))
            with col3:
                selected_trace_id = error_code_context.get('selected_trace_id', 'N/A')
                st.text("选中trace_id:")
                st.code(selected_trace_id, language=None)
        
        st.write("🔍 **步骤2：基于trace_id进行完整诊断...**")
        st.info("💡 后续流程与 'Trace ID 诊断' 完全相同，将进行5步完整分析")
        
        # 获取trace_id并继续完整的诊断流程
        selected_trace_id = error_code_context.get('selected_trace_id', '')
        if selected_trace_id:
            # 调用完整诊断流程
            remaining_results = run_full_diagnosis(selected_trace_id, time_range_hours)
            
            # 合并第一步的错误码查询结果和后续的完整诊断结果
            results.update(remaining_results)
            
            return results
        else:
            st.error("❌ 未能从错误码查询结果中提取到有效的trace_id")
            return results
        
    except Exception as e:
        st.error(f"❌ 错误码诊断过程中出现错误: {e}")
        st.error(f"错误详情: {traceback.format_exc()}")
        return results

def run_stack_diagnosis(stack_trace: str):
    """异常栈诊断流程：直接从异常栈开始"""
    results = {}
    
    try:
        # 生成模拟的logs
        mock_logs = [
            f"异常时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "请求类型: 用户创意保存操作",
            "异常类型: NullPointerException",
            "影响范围: 单个请求失败"
        ]
        
        return run_remaining_steps(mock_logs, stack_trace, results)
        
    except Exception as e:
        st.error(f"❌ 异常栈诊断过程中出现错误: {e}")
        st.error(f"错误详情: {traceback.format_exc()}")
        return results

def run_remaining_steps(logs, stack_trace, results):
    """执行剩余的诊断步骤（步骤3-5）"""
    
    # 步骤3：代码定位
    st.write("🔍 **步骤3：代码定位中...**")
    locator_result = code_locator({'stacktrace': stack_trace})
    results['locator'] = locator_result
    
    if not locator_result.get('success'):
        st.error(f"❌ 代码定位失败: {locator_result.get('error', '未知错误')}")
        if 'parsed_calls' in locator_result:
            st.info(f"📝 解析到 {len(locator_result['parsed_calls'])} 个调用，但未找到源文件")
        return results
    
    st.success(f"✅ 代码定位成功: {locator_result.get('relative_file', 'N/A')}:{locator_result.get('line', 'N/A')}")
    
    # 验证必要字段并提供默认值
    required_fields = ['code', 'relative_file', 'method', 'line']
    for field in required_fields:
        if field not in locator_result:
            if field == 'code':
                locator_result['code'] = '无法获取代码片段'
            elif field == 'relative_file':
                locator_result['relative_file'] = 'N/A'
            elif field == 'method':
                locator_result['method'] = 'N/A'
            elif field == 'line':
                locator_result['line'] = 0
    
    # 步骤4：根因分析
    st.write("🔍 **步骤4：根因分析中...**")
    analysis_input = {
        'logs': logs,
        'stack': stack_trace,
        'code': locator_result.get('code', '无法获取代码片段')
    }
    
    analysis_result = root_cause_analyzer(analysis_input)
    results['analysis'] = analysis_result
    st.success("✅ 根因分析完成")
    
    # 步骤5：解决方案建议
    st.write("🔍 **步骤5：生成解决方案中...**")
    suggestion_input = {
        'root_cause': analysis_result.get('root_cause', '根因分析失败'),
        'code': locator_result.get('code', '无法获取代码片段'),
        'file': locator_result.get('relative_file', 'N/A'),
        'line': locator_result.get('line', 0)
    }
    
    try:
        suggestion_result = solution_suggester(suggestion_input)
        results['suggestion'] = suggestion_result
        st.success("✅ 解决方案生成完成")
    except Exception as e:
        st.warning(f"⚠️ 解决方案生成失败: {e}")
        # 提供备用解决方案
        results['suggestion'] = {
            'suggestion': f"""**AI解决方案生成失败，基于根因分析提供建议:**

{analysis_result.get('root_cause', '无根因分析结果')}

**通用修复建议:**
1. 添加null检查
2. 使用Optional模式
3. 检查数据源完整性
4. 增加异常处理
"""
        }
    
    return results

def display_results(results, mode_name):
    """显示诊断结果"""
    if not results:
        st.warning("⚠️ 没有诊断结果可显示")
        return
    
    st.markdown("---")
    st.subheader(f"📊 {mode_name} - 诊断结果")
    
    # 创建选项卡 - 为Trace ID模式增加日志查询选项卡
    if "Trace ID" in mode_name and 'step1' in results:
        tabs = ["📊 总览", "📋 日志查询", "🔍 异常分析", "📍 代码定位", "🧠 根因分析", "💡 解决方案", "📄 详细信息"]
    else:
        tabs = ["📊 总览", "📍 代码定位", "🔍 根因分析", "💡 解决方案", "📋 详细信息"]
    
    tab_objects = st.tabs(tabs)
    
    with tab_objects[0]:  # 总览
        st.markdown("### 🎯 诊断总览")
        
        col1, col2, col3 = st.columns(3)
        
        with col1:
            if results.get('locator', {}).get('success'):
                st.success("✅ 代码定位成功")
                locator = results['locator']
                st.markdown(f"""
                **📁 文件**: `{locator.get('relative_file', 'N/A')}`  
                **🔧 方法**: `{locator.get('method', 'N/A')}`  
                **📍 行号**: `{locator.get('line', 'N/A')}`
                """)
            else:
                st.error("❌ 代码定位失败")
        
        with col2:
            if 'analysis' in results:
                st.success("✅ 根因分析完成")
                root_cause = results['analysis'].get('root_cause', '')
                preview = root_cause[:100] + "..." if len(root_cause) > 100 else root_cause
                st.markdown(f"**分析预览**: {preview}")
            else:
                st.error("❌ 根因分析失败")
        
        with col3:
            if 'suggestion' in results:
                st.success("✅ 解决方案已生成")
                suggestion = results['suggestion'].get('suggestion', '')
                preview = suggestion[:100] + "..." if len(suggestion) > 100 else suggestion
                st.markdown(f"**方案预览**: {preview}")
            else:
                st.error("❌ 解决方案生成失败")
    
    # 添加日志查询选项卡（仅对Trace ID模式）
    tab_index = 1
    if "Trace ID" in mode_name and 'step1' in results:
        with tab_objects[tab_index]:  # 日志查询
            st.markdown("### 📋 日志查询结果")
            step1_result = results['step1']
            
            # 查询概要
            col1, col2 = st.columns(2)
            with col1:
                log_count = step1_result.get('log_count', 0)
                st.metric("日志条数", log_count)
                
            with col2:
                services = step1_result.get('services', [])
                st.metric("查询服务", len(services))
            
            # 查询详情
            if services:
                st.markdown("**🔧 查询的服务:**")
                for service in services:
                    st.write(f"- {service}")
            
            query_time_range = step1_result.get('query_time_range', '')
            if query_time_range:
                st.markdown(f"**⏰ 查询时间范围:** {query_time_range}")
            
            # 重要信息展示
            important_info = step1_result.get('important_info', {})
            if important_info:
                st.markdown("**🎯 提取的重要信息:**")
                
                # 异常信息
                exceptions = important_info.get('exceptions', [])
                if exceptions:
                    st.markdown("**⚠️ 异常信息:**")
                    for i, exc in enumerate(exceptions[:3]):  # 只显示前3个
                        with st.expander(f"异常 {i+1}: {exc.get('type', 'Unknown')}", expanded=i==0):
                            st.write(f"**服务:** {exc.get('service', 'Unknown')}")
                            st.write(f"**类型:** {exc.get('type', 'Unknown')}")
                            st.write(f"**消息:** {exc.get('message', 'N/A')}")
                            if exc.get('stacktrace'):
                                st.code(exc['stacktrace'][:500] + "..." if len(exc['stacktrace']) > 500 else exc['stacktrace'])
                
                # 请求参数
                request_params = important_info.get('request_params', [])
                if request_params:
                    st.markdown("**📋 请求参数:**")
                    for i, param in enumerate(request_params[:3]):
                        with st.expander(f"参数 {i+1} - {param.get('service', 'Unknown')}", expanded=False):
                            st.write(f"**服务:** {param.get('service', 'Unknown')}")
                            st.write(f"**作用域:** {param.get('scope', 'Unknown')}")
                            st.code(param.get('args', 'N/A'))
                
                # 服务调用链
                service_calls = important_info.get('service_calls', [])
                if service_calls:
                    st.markdown("**🔗 服务调用链:**")
                    for call in service_calls[:5]:
                        st.write(f"- {call.get('from_service', 'Unknown')} → {call.get('to_service', 'Unknown')}")
            
            # 完整日志
            logs = step1_result.get('logs', [])
            if logs:
                st.markdown("**📜 完整日志:**")
                with st.expander("展开查看所有日志", expanded=False):
                    for i, log in enumerate(logs):
                        st.text(f"{i+1:3d}. {log}")
        
        tab_index += 1
        
        # 异常分析选项卡
        if 'step2' in results:
            with tab_objects[tab_index]:  # 异常分析
                st.markdown("### 🔍 异常栈和调用链分析")
                step2_result = results['step2']
                
                # 分析概要
                analysis_summary = step2_result.get('analysis_summary', {})
                has_exception = step2_result.get('has_exception', False)
                
                col1, col2 = st.columns(2)
                with col1:
                    st.metric("异常状态", "有异常" if has_exception else "无异常")
                    
                with col2:
                    services_count = len(analysis_summary.get('services_involved', []))
                    st.metric("涉及服务", services_count)
                
                # 异常详情
                if has_exception:
                    exception_info = step2_result.get('exception_info', {})
                    st.markdown("**⚠️ 异常详情:**")
                    col1, col2 = st.columns(2)
                    
                    with col1:
                        st.write(f"**异常类型:** {exception_info.get('exception_type', 'Unknown')}")
                        st.write(f"**错误服务:** {exception_info.get('source_service', 'Unknown')}")
                        
                    with col2:
                        st.write(f"**异常消息:** {exception_info.get('exception_message', 'N/A')}")
                    
                    # 异常栈
                    stacktrace = exception_info.get('exception_stacktrace', '')
                    if stacktrace:
                        st.markdown("**📚 异常栈:**")
                        st.code(stacktrace)
                
                # 主要错误位置
                main_error_location = step2_result.get('main_error_location')
                if main_error_location:
                    st.markdown("**🎯 主要错误位置:**")
                    col1, col2 = st.columns(2)
                    
                    with col1:
                        st.write(f"**文件:** {main_error_location.get('file', 'N/A')}")
                        st.write(f"**方法:** {main_error_location.get('method', 'N/A')}")
                        
                    with col2:
                        st.write(f"**行号:** {main_error_location.get('line', 'N/A')}")
                        st.write(f"**服务:** {main_error_location.get('service', 'N/A')}")
                        
                        is_our_service = main_error_location.get('is_our_service', False)
                        if is_our_service:
                            st.success("✅ 我们负责的服务")
                        else:
                            st.warning("⚠️ 非我们负责的服务")
                
                # 调用链
                call_chain = step2_result.get('call_chain', {})
                if call_chain.get('request_flow'):
                    st.markdown("**🔗 请求调用链:**")
                    for i, flow in enumerate(call_chain['request_flow'][:10]):
                        flow_type = flow.get('type', 'unknown')
                        if flow_type == 'request_path':
                            st.write(f"{i+1}. 📍 {flow.get('service', 'Unknown')}: {flow.get('path', 'N/A')}")
                        elif flow_type == 'service_call':
                            st.write(f"{i+1}. 🔗 {flow.get('from', 'Unknown')} → {flow.get('to', 'Unknown')}")
                
                # 请求参数
                request_params = step2_result.get('request_parameters', [])
                if request_params:
                    st.markdown("**📋 提取的请求参数:**")
                    for i, param in enumerate(request_params):
                        with st.expander(f"参数 {i+1} - {param.get('service', 'Unknown')}", expanded=False):
                            st.write(f"**类型:** {param.get('type', 'Unknown')}")
                            st.code(param.get('content', 'N/A'))
            
            tab_index += 1
    
    with tab_objects[tab_index]:  # 代码定位
        if results.get('locator', {}).get('success'):
            locator_result = results['locator']
            st.success("✅ 代码定位成功")
            
            col1, col2 = st.columns([2, 1])
            
            with col1:
                st.markdown(f"""
                **📁 文件位置**: `{locator_result.get('relative_file', 'N/A')}`  
                **🔧 问题方法**: `{locator_result.get('class', 'N/A')}.{locator_result.get('method', 'N/A')}`  
                **📍 错误行号**: `{locator_result.get('line', 'N/A')}`  
                **💻 编程语言**: `{locator_result.get('language', 'N/A')}`
                """)
                
            with col2:
                # 显示增强信息
                if 'code_context' in locator_result:
                    ctx = locator_result['code_context']
                    if 'file_info' in ctx:
                        file_info = ctx['file_info']
                        st.markdown(f"""
                        **📦 包名**: `{file_info.get('package', 'N/A')}`  
                        **📄 总行数**: `{ctx.get('total_lines', 0)}`  
                        **🔗 imports数**: `{len(file_info.get('imports', []))}`
                        """)
            
            st.markdown("**🐛 问题代码:**")
            st.code(locator_result.get('code', '无法获取代码片段'), language='java')
        else:
            st.error("❌ 代码定位失败")
            if 'locator' in results and 'error' in results['locator']:
                st.error(results['locator']['error'])
    
    tab_index += 1
    with tab_objects[tab_index]:  # 根因分析
        if 'analysis' in results:
            st.success("✅ 根因分析完成")
            st.markdown("**🔍 分析结果:**")
            st.markdown(results['analysis'].get('root_cause', '无分析结果'))
        else:
            st.warning("⚠️ 根因分析未完成")
    
    tab_index += 1
    with tab_objects[tab_index]:  # 解决方案
        if 'suggestion' in results:
            st.success("✅ 解决方案已生成")
            st.markdown("**💡 修复建议:**")
            st.markdown(results['suggestion'].get('suggestion', '无解决方案'))
        else:
            st.warning("⚠️ 解决方案生成未完成")
    
    tab_index += 1
    with tab_objects[tab_index]:  # 详细信息
        st.markdown("**📋 完整诊断信息:**")
        st.json(results, expanded=False)
        
        # 下载结果
        result_json = json.dumps(results, indent=2, ensure_ascii=False)
        st.download_button(
            label="📥 下载诊断报告",
            data=result_json,
            file_name=f"diagnosis_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
            mime="application/json"
        )

def main():
    st.set_page_config(
        page_title="AI问题诊断工具",
        page_icon="🤖",
        layout="wide"
    )
    
    # 初始化session state
    if 'diagnosing' not in st.session_state:
        st.session_state.diagnosing = False
    if 'diagnosis_type' not in st.session_state:
        st.session_state.diagnosis_type = None
    if 'button_clicked' not in st.session_state:
        st.session_state.button_clicked = False
    if 'last_click_time' not in st.session_state:
        st.session_state.last_click_time = 0
    
    # 检查被中断的任务
    check_interrupted_task()
    
    st.title("🤖 AI智能问题诊断工具")
    st.markdown("**快速定位代码问题，智能分析根因，自动生成解决方案**")
    
    # 添加页面刷新保护提示
    if st.session_state.diagnosing:
        st.error("⚠️ **诊断进行中 - 请勿刷新页面**")
        st.markdown("""
        <div style="background-color: #ffebee; padding: 10px; border-radius: 5px; border-left: 4px solid #f44336;">
        🔒 <strong>页面保护提示：</strong><br>
        • 刷新页面将终止当前诊断任务<br>
        • 请等待诊断完成后再进行其他操作<br>
        • 如需终止诊断，请关闭浏览器标签页
        </div>
        """, unsafe_allow_html=True)
        
        # 添加页面刷新保护的JavaScript
        st.markdown("""
        <script>
        window.addEventListener('beforeunload', function (e) {
            e.preventDefault();
            e.returnValue = '诊断正在进行中，确定要离开吗？这将终止当前的诊断任务。';
            return '诊断正在进行中，确定要离开吗？这将终止当前的诊断任务。';
        });
        </script>
        """, unsafe_allow_html=True)
        st.markdown("---")
    
    # 模式选择
    st.sidebar.header("🔧 诊断模式")
    
    # 诊断进行中时显示状态
    if st.session_state.diagnosing:
        st.sidebar.warning(f"⏳ 正在进行{st.session_state.diagnosis_type}诊断...")
        st.sidebar.info("🔒 诊断进行中，模式切换已锁定")
        
        # 显示当前模式，但禁用切换
        current_modes = ["🔍 Trace ID 诊断", "📝 异常栈诊断", "⚠️ 错误码诊断"]
        if st.session_state.diagnosis_type == 'trace_id':
            current_mode_index = 0
        elif st.session_state.diagnosis_type == 'stack':
            current_mode_index = 1
        else:  # error_code
            current_mode_index = 2
        
        mode = st.sidebar.radio(
            "当前诊断模式:",
            current_modes,
            index=current_mode_index,
            disabled=True,
            help="诊断进行中，无法切换模式"
        )
    else:
        mode = st.sidebar.radio(
            "选择诊断方式:",
            ["🔍 Trace ID 诊断", "📝 异常栈诊断", "⚠️ 错误码诊断"],
            help="选择适合的诊断模式：Trace ID(完整调用链)、异常栈(快速定位)、错误码(业务监控告警)"
        )
    
    # 侧边栏信息
    with st.sidebar:
        st.markdown("---")
        st.header("ℹ️ 使用说明")
        
        if mode == "🔍 Trace ID 诊断":
            st.markdown("""
            **📋 完整诊断流程:**
            1. 🔍 根据trace_id查询日志
            2. 📊 解析异常栈信息
            3. 📍 精确定位问题代码
            4. 🧠 智能根因分析
            5. 💡 生成解决方案
            """)
        elif mode == "📝 异常栈诊断":
            st.markdown("""
            **⚡ 快速诊断流程:**
            1. 📍 精确定位问题代码
            2. 🧠 智能根因分析  
            3. 💡 生成解决方案
            """)
        else:  # 错误码诊断
            st.markdown("""
            **⚠️ 错误码诊断流程:**
            1. 🔍 根据接口和错误码查询日志
            2. 📊 解析异常栈信息
            3. 📍 精确定位问题代码
            4. 🧠 智能根因分析
            5. 💡 生成解决方案
            """)
        
        st.markdown("---")
        st.header("📝 示例数据")
        if mode == "🔍 Trace ID 诊断":
            # 诊断进行中时禁用示例加载
            example_btn_disabled = st.session_state.diagnosing
            if example_btn_disabled:
                st.caption("⏳ 诊断进行中，示例加载已禁用")
            
            if st.button("加载Trace ID示例", disabled=example_btn_disabled):
                try:
                    # 读取trace示例数据
                    with open('trace_example.json', 'r', encoding='utf-8') as f:
                        example_data = json.load(f)
                    example_trace_id = example_data.get('example_trace_id', '')
                    st.session_state['trace_id_input'] = example_trace_id
                    st.success("✅ 示例Trace ID已加载")
                except Exception as e:
                    # 备用示例数据
                    st.session_state['trace_id_input'] = "7e60eabbd47c38088b009c473d688a06"
                    st.success("✅ 默认示例Trace ID已加载")
        elif mode == "📝 异常栈诊断":
            # 诊断进行中时禁用示例加载
            example_btn_disabled = st.session_state.diagnosing
            if example_btn_disabled:
                st.caption("⏳ 诊断进行中，示例加载已禁用")
            
            if st.button("加载异常栈示例", disabled=example_btn_disabled):
                try:
                    with open('exception.log', 'r') as f:
                        example_stack = f.read()
                    st.session_state['stack_input'] = example_stack
                    st.success("✅ 示例异常栈已加载")
                except:
                    st.session_state['stack_input'] = """java.lang.NullPointerException
    at com.example.service.UserService.getUserById(UserService.java:45)
    at com.example.controller.UserController.getUser(UserController.java:23)"""
                    st.success("✅ 默认示例异常栈已加载")
        else:  # 错误码诊断
            # 诊断进行中时禁用示例加载
            example_btn_disabled = st.session_state.diagnosing
            if example_btn_disabled:
                st.caption("⏳ 诊断进行中，示例加载已禁用")
            
            if st.button("加载错误码示例", disabled=example_btn_disabled):
                # 加载示例错误码数据
                st.session_state['api_path_input'] = "/api/v1/orders/report/list"
                st.session_state['error_code_input'] = "10013"
                st.session_state['time_range_input'] = 24
                st.success("✅ 示例错误码已加载")
        
        st.markdown("---")
        
        # 动态加载项目信息 - 简化显示
        try:
            with open('config.json', 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            projects = config.get('projects', {})
            languages = list(config.get('languages', {}).keys())
            
            # 格式化项目信息 - 换行显示，更美观
            project_names = list(projects.keys())
            
            # 语言名称映射，处理特殊情况
            language_mapping = {
                'java': 'Java',
                'kotlin': 'Kotlin', 
                'python': 'Python',
                'csharp': 'C#'
            }
            formatted_languages = [language_mapping.get(lang, lang.capitalize()) for lang in languages]
            language_list = ', '.join(formatted_languages)
            
            # 构建显示内容 - 项目用逗号分隔
            project_info = "**🏗️ 项目信息**\n\n"
            
            # 项目信息 - 逗号分隔显示
            project_list = ', '.join(project_names)
            project_info += f"**项目:** {project_list}\n"
            
            project_info += f"\n**语言:** {language_list}\n"
            project_info += f"\n**时间:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            
            # 使用 st.info 恢复框框显示，确保换行正确
            st.info(project_info)
            
        except Exception as e:
            # 备用显示 - 恢复正确的格式
            fallback_info = "**🏗️ 项目信息**\n\n"
            fallback_info += "**配置:** 加载失败\n"
            fallback_info += f"\n**时间:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            
            st.info(fallback_info)
    
    # 主界面根据模式显示不同内容
    if mode == "🔍 Trace ID 诊断":
        st.subheader("🔍 Trace ID 模式")
        st.markdown("通过trace_id进行完整的问题诊断，支持自定义查询时间范围")
        
        
        col1, col2 = st.columns([3, 1])
        
        with col1:
            # 输入区域
            input_col1, input_col2 = st.columns([2, 1])
            
            with input_col1:
                trace_id = st.text_input(
                    "请输入 Trace ID:",
                    value=st.session_state.get('trace_id_input', ''),
                    placeholder="例如: 1234567890abcdef",
                    help="输入完整的trace_id，系统将自动查询相关日志并进行分析"
                )
            
            with input_col2:
                # 时间范围选择
                trace_time_range_hours = st.selectbox(
                    "查询时间范围:",
                    options=[1, 2, 6, 12, 24, 48, 72],
                    index=0,  # 默认1小时
                    format_func=lambda x: f"最近{x}小时",
                    help="选择查询日志的时间范围"
                )
        
        with col2:
            st.markdown("<br>", unsafe_allow_html=True)  # 添加间距
            
            # 检查是否应该禁用按钮
            current_time = time.time()
            should_disable = (
                st.session_state.diagnosing or 
                st.session_state.button_clicked or
                (current_time - st.session_state.last_click_time < 2)  # 2秒内防重复点击
            )
            
            # 根据诊断状态显示不同的按钮
            if should_disable and st.session_state.diagnosis_type == 'trace_id':
                st.button("🔄 诊断进行中...", type="secondary", disabled=True)
                st.caption("⏳ 请等待当前诊断完成")
            else:
                diagnose_btn = st.button(
                    "🚀 开始完整诊断", 
                    type="primary",
                    disabled=should_disable
                )
        
        with col2:
            st.markdown("**🎯 完整诊断优势:**")
            st.markdown("""
            - 📊 **完整链路**: 查询全链路日志数据
            - 🔍 **深度分析**: 5步完整诊断流程
            - ⏰ **时间控制**: 自定义查询时间范围
            - 🎯 **精确定位**: AI智能代码定位
            - 💡 **根因分析**: 深度分析问题根因
            - 🚀 **解决方案**: 自动生成修复建议
            """)
        
        # 更严格的点击检查
        current_time = time.time()
        if ('diagnose_btn' in locals() and diagnose_btn and 
            not st.session_state.diagnosing and 
            not st.session_state.button_clicked and
            (current_time - st.session_state.last_click_time >= 2)):
            
            if trace_id.strip():
                # 立即设置防重复标志
                st.session_state.button_clicked = True
                st.session_state.last_click_time = time.time()
                st.session_state.diagnosing = True
                st.session_state.diagnosis_type = 'trace_id'
                
                # 保存任务状态
                task_id = get_task_id()
                save_task_state(task_id, {
                    'diagnosing': True,
                    'diagnosis_type': 'trace_id',
                    'input_data': trace_id.strip(),
                    'start_time': datetime.now().isoformat()
                })
                
                st.markdown("---")
                st.subheader("🔧 完整诊断进行中...")
                
                try:
                    with st.spinner("AI正在执行5步诊断流程..."):
                        results = run_full_diagnosis(trace_id.strip(), trace_time_range_hours)
                    
                    display_results(results, "Trace ID 完整诊断")
                    
                finally:
                    # 重置所有诊断状态
                    st.session_state.diagnosing = False
                    st.session_state.diagnosis_type = None
                    st.session_state.button_clicked = False
                    st.session_state.last_click_time = 0
                    # 清理任务状态
                    cleanup_task_state(task_id)
                    
            else:
                st.error("❌ 请先输入 Trace ID")
    
    elif mode == "📝 异常栈诊断":  # 异常栈诊断模式
        st.subheader("📝 异常栈模式")
        st.markdown("直接输入异常栈信息进行快速诊断")
        
        col1, col2 = st.columns([2, 1])
        
        with col1:
            stack_trace = st.text_area(
                "请粘贴完整的异常栈信息:",
                value=st.session_state.get('stack_input', ''),
                height=300,
                placeholder="""例如：
java.lang.NullPointerException
    at com.example.service.UserService.getUserById(UserService.java:45)
    at com.example.controller.UserController.getUser(UserController.java:23)
    at org.springframework.web.method.support.InvocableHandlerMethod.invoke(InvocableHandlerMethod.java:215)
    ...
""",
                help="粘贴完整的Java/Python/C#等异常栈信息"
            )
            
            col_btn1, col_btn2 = st.columns([1, 1])
            with col_btn1:
                # 检查是否应该禁用按钮
                current_time = time.time()
                should_disable_stack = (
                    st.session_state.diagnosing or 
                    st.session_state.button_clicked or
                    (current_time - st.session_state.last_click_time < 2)
                )
                
                # 根据诊断状态显示不同的按钮
                if should_disable_stack and (st.session_state.diagnosis_type == 'stack' or st.session_state.diagnosing):
                    st.button("🔄 诊断进行中...", type="secondary", disabled=True)
                    st.caption("⏳ 请等待当前诊断完成")
                else:
                    diagnose_btn = st.button(
                        "🚀 开始快速诊断", 
                        type="primary",
                        disabled=should_disable_stack
                    )
            with col_btn2:
                # 诊断进行中时禁用清空按钮
                clear_btn = st.button("🗑️ 清空", disabled=st.session_state.diagnosing)
                if clear_btn and not st.session_state.diagnosing:
                    st.session_state['stack_input'] = ''
                    st.rerun()
        
        with col2:
            st.markdown("**🎯 快速诊断优势:**")
            st.markdown("""
            - ⚡ **速度快**: 跳过日志查询步骤
            - 🎯 **精确**: 直接定位问题代码
            - 🧠 **智能**: AI深度分析根因
            - 💡 **实用**: 提供具体修复方案
            - 🌐 **通用**: 支持多种编程语言
            """)
        
        # 添加诊断状态提示
        if st.session_state.diagnosing:
            if st.session_state.diagnosis_type == 'stack':
                st.info("⏳ 异常栈诊断进行中，请等待...")
            elif st.session_state.diagnosis_type == 'trace_id':
                st.info("⏳ Trace ID诊断进行中，请等待...")
        
        # 异常栈模式的点击检查
        current_time = time.time()
        if (not st.session_state.diagnosing and 
            not st.session_state.button_clicked and
            (current_time - st.session_state.last_click_time >= 2) and
            'diagnose_btn' in locals() and diagnose_btn):
            if stack_trace.strip():
                # 立即设置防重复标志
                st.session_state.button_clicked = True
                st.session_state.last_click_time = time.time()
                st.session_state.diagnosing = True
                st.session_state.diagnosis_type = 'stack'
                
                # 保存任务状态
                task_id = get_task_id()
                save_task_state(task_id, {
                    'diagnosing': True,
                    'diagnosis_type': 'stack',
                    'input_data': stack_trace.strip()[:500],  # 只保存前500字符
                    'start_time': datetime.now().isoformat()
                })
                
                st.markdown("---")
                st.subheader("🔧 快速诊断进行中...")
                
                try:
                    with st.spinner("AI正在分析异常栈..."):
                        results = run_stack_diagnosis(stack_trace.strip())
                    
                    display_results(results, "异常栈快速诊断")
                    
                finally:
                    # 重置所有诊断状态
                    st.session_state.diagnosing = False
                    st.session_state.diagnosis_type = None
                    st.session_state.button_clicked = False
                    st.session_state.last_click_time = 0
                    # 清理任务状态
                    cleanup_task_state(task_id)
                    
            else:
                st.error("❌ 请先输入异常栈信息")
    
    else:  # 错误码诊断模式
        st.subheader("⚠️ 错误码模式")
        st.markdown("基于业务监控告警的接口路径和错误码进行诊断")
        
        col1, col2 = st.columns([3, 1])
        
        with col1:
            # 输入区域
            input_col1, input_col2 = st.columns([2, 1])
            
            with input_col1:
                api_path = st.text_input(
                    "接口路径:",
                    value=st.session_state.get('api_path_input', ''),
                    placeholder="/api/v1/orders/report/list",
                    help="输入出现错误的接口路径"
                )
            
            with input_col2:
                error_code = st.text_input(
                    "错误码:",
                    value=st.session_state.get('error_code_input', ''),
                    placeholder="10013",
                    help="输入业务错误码"
                )
            
            # 时间范围选择
            time_range_hours = st.selectbox(
                "查询时间范围:",
                options=[1, 2, 6, 12, 24, 48, 72],
                index=0,  # 默认1小时
                format_func=lambda x: f"最近{x}小时",
                help="选择查询日志的时间范围"
            )
            
            # 服务选择 - 简化为单选按钮
            service_selection = st.radio(
                "目标服务:",
                options=["ADP", "Pandora"],
                index=0,  # 默认ADP
                horizontal=True
            )
            
            
            # 按钮区域
            col_btn1, col_btn2, col_btn3 = st.columns([1, 1, 1])
            with col_btn1:
                # 检查是否应该禁用按钮
                current_time = time.time()
                should_disable_error = (
                    st.session_state.diagnosing or 
                    st.session_state.button_clicked or
                    (current_time - st.session_state.last_click_time < 2)
                )
                
                # 根据诊断状态显示不同的按钮
                if should_disable_error and (st.session_state.diagnosis_type == 'error_code' or st.session_state.diagnosing):
                    st.button("🔄 诊断进行中...", type="secondary", disabled=True)
                    st.caption("⏳ 请等待当前诊断完成")
                else:
                    diagnose_error_btn = st.button(
                        "🚀 开始错误码诊断", 
                        type="primary",
                        disabled=should_disable_error
                    )
            
            with col_btn2:
                # 诊断进行中时禁用清空按钮
                clear_error_btn = st.button("🗑️ 清空结果", disabled=st.session_state.diagnosing)
                if clear_error_btn and not st.session_state.diagnosing:
                    st.session_state['api_path_input'] = ''
                    st.session_state['error_code_input'] = ''
                    st.session_state['time_range_input'] = 24
                    st.rerun()
        
        with col2:
            st.markdown("**🎯 错误码诊断特点:**")
            st.markdown("""
            - 🚨 **告警响应**: 快速处理监控告警
            - 🔍 **精准查询**: 基于错误码过滤
            - 📊 **批量分析**: 分析同类错误
            - ⏰ **时间控制**: 灵活的时间范围
            - 🎯 **服务指定**: 用户明确选择目标服务
            """)
            
        
        # 添加诊断状态提示
        if st.session_state.diagnosing:
            if st.session_state.diagnosis_type == 'error_code':
                st.info("⏳ 错误码诊断进行中，请等待...")
            elif st.session_state.diagnosis_type in ['stack', 'trace_id']:
                st.info(f"⏳ {st.session_state.diagnosis_type}诊断进行中，请等待...")
        
        # 错误码模式的点击检查
        current_time = time.time()
        if (not st.session_state.diagnosing and 
            not st.session_state.button_clicked and
            (current_time - st.session_state.last_click_time >= 2) and
            'diagnose_error_btn' in locals() and diagnose_error_btn):
            
            if api_path.strip() and error_code.strip():
                # 立即设置防重复标志
                st.session_state.button_clicked = True
                st.session_state.last_click_time = time.time()
                st.session_state.diagnosing = True
                st.session_state.diagnosis_type = 'error_code'
                
                # 保存任务状态
                task_id = get_task_id()
                save_task_state(task_id, {
                    'diagnosing': True,
                    'diagnosis_type': 'error_code',
                    'input_data': {
                        'api_path': api_path.strip(),
                        'error_code': error_code.strip(),
                        'time_range_hours': time_range_hours
                    },
                    'start_time': datetime.now().isoformat()
                })
                
                st.markdown("---")
                st.subheader("🔧 错误码诊断进行中...")
                
                try:
                    # 获取选择的服务 - 根据单选按钮结果映射到实际服务ID
                    if service_selection == "ADP":
                        selected_services = ["demo.ads.ad-gateway"]
                    else:  # Pandora
                        selected_services = ["demo.order.order-service"]
                    
                    with st.spinner("AI正在基于错误码执行诊断流程..."):
                        results = run_error_code_diagnosis(
                            api_path.strip(), 
                            error_code.strip(), 
                            time_range_hours,
                            selected_services
                        )
                    
                    display_results(results, "错误码诊断")
                    
                finally:
                    # 重置所有诊断状态
                    st.session_state.diagnosing = False
                    st.session_state.diagnosis_type = None
                    st.session_state.button_clicked = False
                    st.session_state.last_click_time = 0
                    # 清理任务状态
                    cleanup_task_state(task_id)
                    
            else:
                if not api_path.strip():
                    st.error("❌ 请先输入接口路径")
                if not error_code.strip():
                    st.error("❌ 请先输入错误码")

if __name__ == "__main__":
    main()