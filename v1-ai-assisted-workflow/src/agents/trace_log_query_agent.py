import json
import time
import requests
from datetime import datetime
from typing import Dict, List, Any, Optional


def load_config() -> dict:
    """加载配置文件"""
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"加载配置文件失败: {e}")
        return {}


def query_log_platform(app_id: str, trace_id: str, config: dict, time_range_hours: int = None) -> List[Dict[str, Any]]:
    """查询日志平台API"""
    log_platform_config = config.get('log_platform', {})
    
    # 构造时间范围：支持自定义时间范围
    current_time = int(time.time())
    if time_range_hours is None:
        time_range_hours = log_platform_config.get('query_time_range_hours', 24)
    from_time = current_time - (time_range_hours * 3600)
    to_time = current_time
    
    # 构造请求参数
    payload = {
        "appId": app_id,
        "query": f"SELECT * WHERE log.trace_id = '{trace_id}'",
        "from": from_time,
        "to": to_time,
        "pageSize": log_platform_config.get('default_page_size', 100),
        "page": 1
    }
    
    headers = log_platform_config.get('headers', {})
    url = log_platform_config.get('base_url', '')
    
    try:
        print(f"查询日志平台 - appId: {app_id}, trace_id: {trace_id}")
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            result = response.json()
            if result.get('code') == 0:
                logs = result.get('data', {}).get('logs', [])
                print(f"成功获取 {len(logs)} 条日志")
                return logs
            else:
                print(f"日志查询失败: {result.get('message', '未知错误')}")
                return []
        else:
            print(f"API请求失败: HTTP {response.status_code}")
            return []
            
    except Exception as e:
        print(f"查询日志平台异常: {e}")
        return []


def merge_and_sort_logs(all_logs: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """合并多个服务的日志并按时间戳排序"""
    merged_logs = []
    
    for logs in all_logs:
        merged_logs.extend(logs)
    
    # 按时间戳排序
    try:
        merged_logs.sort(key=lambda x: x.get('timestamp', 0))
    except:
        # 如果timestamp排序失败，尝试其他时间字段
        try:
            merged_logs.sort(key=lambda x: x.get('log.observed_time', ''))
        except:
            print("警告: 无法按时间排序日志")
    
    return merged_logs


def analyze_stacktrace_quality(stacktrace: str) -> Dict[str, Any]:
    """分析异常栈的质量，用于选择最佳异常栈"""
    from stack_trace_analyze_agent import parse_stacktrace, get_business_priority, is_infrastructure_code
    
    frames = parse_stacktrace(stacktrace)
    our_service_frames = [f for f in frames if f.get('is_our_service', False)]
    
    if not our_service_frames:
        return {
            "quality_score": 0,
            "has_business_code": False,
            "infrastructure_ratio": 1.0,
            "top_business_priority": 10
        }
    
    # 计算业务代码比例
    business_frames = [f for f in our_service_frames if not f.get('is_infrastructure', False)]
    infrastructure_ratio = 1.0 - (len(business_frames) / len(our_service_frames)) if our_service_frames else 1.0
    
    # 获取最高业务优先级（数字越小优先级越高）
    top_business_priority = min(f.get('business_priority', 10) for f in our_service_frames)
    
    # 计算质量分数（分数越高质量越好）
    quality_score = 0
    
    # 有业务代码加分
    if business_frames:
        quality_score += 50
    
    # 业务优先级高加分（优先级数字越小加分越多）
    quality_score += max(0, 10 - top_business_priority) * 10
    
    # 基础设施代码比例低加分
    quality_score += (1.0 - infrastructure_ratio) * 30
    
    # 我们服务栈帧数量加分
    quality_score += min(len(our_service_frames), 10) * 2
    
    return {
        "quality_score": quality_score,
        "has_business_code": len(business_frames) > 0,
        "infrastructure_ratio": infrastructure_ratio,
        "top_business_priority": top_business_priority,
        "our_service_frames": len(our_service_frames),
        "business_frames": len(business_frames)
    }

def select_best_exception(exceptions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """从多个异常中选择最有价值的一个进行分析"""
    if not exceptions:
        return None
    
    if len(exceptions) == 1:
        return exceptions[0]
    
    # 为每个异常计算质量分数
    scored_exceptions = []
    for exc in exceptions:
        stacktrace = exc.get('stacktrace', '')
        if stacktrace:
            quality = analyze_stacktrace_quality(stacktrace)
            scored_exceptions.append({
                'exception': exc,
                'quality': quality
            })
        else:
            scored_exceptions.append({
                'exception': exc,
                'quality': {'quality_score': 0}
            })
    
    # 按质量分数排序，选择最佳的
    scored_exceptions.sort(key=lambda x: x['quality']['quality_score'], reverse=True)
    
    best = scored_exceptions[0]
    print(f"选择最佳异常栈 - 质量分数: {best['quality']['quality_score']:.1f}, "
          f"业务优先级: {best['quality'].get('top_business_priority', 10)}, "
          f"基础设施比例: {best['quality'].get('infrastructure_ratio', 1.0):.2f}")
    
    return best['exception']

def extract_important_info(logs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """从日志中提取重要信息"""
    info = {
        "caller_paths": [],  # 请求路径
        "request_params": [],  # 请求参数
        "exceptions": [],  # 异常信息
        "service_calls": [],  # 服务调用链
        "grpc_calls": []  # gRPC调用信息
    }
    
    for log in logs:
        service_name = log.get('service.name', '')
        
        # 提取caller-path (请求接口URI)
        caller_path = log.get('caller-path', '')
        if caller_path and caller_path not in info["caller_paths"]:
            # 对于order服务的URL需要解码
            if service_name == "demo.order.order-service":
                import urllib.parse
                try:
                    caller_path = urllib.parse.unquote(caller_path)
                except:
                    pass
            info["caller_paths"].append({
                "service": service_name,
                "path": caller_path
            })
        
        # 提取请求参数 (args字段)
        args = log.get('args', '')
        log_scope_name = log.get('log.scope.name', '')
        if args and service_name == "demo.ads.ad-gateway":
            # 根据文档，如果ad-gateway有请求到order服务且log.scope.name为ObservabilityClientInterceptor
            if "ObservabilityClientInterceptor" in log_scope_name:
                info["request_params"].append({
                    "service": service_name,
                    "scope": log_scope_name,
                    "args": args
                })
        
        # 提取异常信息
        exception_msg = log.get('exception.message', '')
        exception_type = log.get('exception.type', '')
        exception_stack = log.get('exception.stacktrace', '')
        
        if exception_stack:
            info["exceptions"].append({
                "service": service_name,
                "type": exception_type,
                "message": exception_msg,
                "stacktrace": exception_stack,
                "timestamp": log.get('timestamp', 0)
            })
        
        # 提取服务调用信息
        peer_service = log.get('peer.service', '')
        if peer_service:
            info["service_calls"].append({
                "from_service": service_name,
                "to_service": peer_service,
                "path": log.get('path', ''),
                "timestamp": log.get('timestamp', 0)
            })
        
        # 提取gRPC调用信息
        if "grpc" in log_scope_name.lower() or log.get('log.category') == 'client-grpc-access-log':
            info["grpc_calls"].append({
                "service": service_name,
                "method": log.get('path', ''),
                "status_code": log.get('status.code', log.get('ret', '')),
                "timestamp": log.get('timestamp', 0)
            })
    
    # 如果有多个异常，选择最有价值的一个
    if len(info["exceptions"]) > 1:
        best_exception = select_best_exception(info["exceptions"])
        if best_exception:
            print(f"从 {len(info['exceptions'])} 个异常中选择了最佳异常进行分析")
            info["exceptions"] = [best_exception]
    
    return info


def format_logs_for_analysis(logs: List[Dict[str, Any]]) -> List[str]:
    """格式化日志用于后续分析"""
    formatted_logs = []
    
    for log in logs:
        # 构造日志字符串
        timestamp = log.get('timestamp', log.get('log.observed_time', ''))
        level = log.get('log.level', 'INFO')
        message = log.get('log.msg', '')
        service = log.get('service.name', '')
        path = log.get('path', log.get('caller-path', ''))
        
        # 添加关键信息
        log_parts = []
        if timestamp:
            if isinstance(timestamp, (int, float)):
                # 如果是时间戳，转换为可读格式
                timestamp_str = datetime.fromtimestamp(timestamp/1000 if timestamp > 1e10 else timestamp).strftime('%Y-%m-%d %H:%M:%S')
            else:
                timestamp_str = str(timestamp)
            log_parts.append(f"[{timestamp_str}]")
        
        log_parts.append(f"{level}")
        
        if service:
            log_parts.append(f"[{service}]")
            
        if path:
            # 对order服务的路径进行URL解码
            if service == "demo.order.order-service":
                import urllib.parse
                try:
                    path = urllib.parse.unquote(path)
                except:
                    pass
            log_parts.append(f"path:{path}")
        
        if message:
            log_parts.append(message)
        
        # 添加异常信息
        exception_msg = log.get('exception.message', '')
        exception_type = log.get('exception.type', '')
        exception_stack = log.get('exception.stacktrace', '')
        
        if exception_type or exception_msg:
            log_parts.append(f"Exception: {exception_type} - {exception_msg}")
            
        if exception_stack:
            # 异常栈另起一行
            formatted_logs.append(' '.join(log_parts))
            formatted_logs.append(f"StackTrace: {exception_stack}")
        else:
            formatted_logs.append(' '.join(log_parts))
    
    return formatted_logs


def query_by_error_code(api_path: str, error_code: str, config: dict, 
                       time_range_hours: int = None, 
                       selected_services: List[str] = None) -> List[Dict[str, Any]]:
    """根据接口路径和错误码查询日志，支持指定服务"""
    log_platform_config = config.get('log_platform', {})
    
    # 构造时间范围
    current_time = int(time.time())
    if time_range_hours is None:
        time_range_hours = log_platform_config.get('query_time_range_hours', 24)
    from_time = current_time - (time_range_hours * 3600)
    to_time = current_time
    
    # 构造查询条件：必须同时包含接口路径和错误码（AND逻辑）
    if api_path and error_code:
        query = f"SELECT * WHERE log.level = 'ERROR' and log.msg ~ '{api_path}' and log.msg ~ '{error_code}'"
    elif api_path:
        query = f"SELECT * WHERE log.level = 'ERROR' and log.msg ~ '{api_path}'"
    elif error_code:
        query = f"SELECT * WHERE log.level = 'ERROR' and log.msg ~ '{error_code}'"
    else:
        query = "SELECT * WHERE log.level = 'ERROR'"
    
    # 确定要查询的服务 - 必须用户明确指定
    if selected_services:
        app_ids = selected_services
        print(f"🎯 用户指定查询服务: {', '.join(app_ids)}")
    else:
        # 如果用户没有指定服务，默认查询所有服务
        app_ids = ["demo.ads.ad-gateway", "demo.order.order-service"]
        print(f"⚠️ 未指定服务，查询所有服务: {', '.join(app_ids)}")
    
    all_logs = []
    query_results = {}  # 记录每个服务的查询结果
    
    headers = log_platform_config.get('headers', {})
    url = log_platform_config.get('base_url', '')
    
    for app_id in app_ids:
        # 构造请求参数
        payload = {
            "appId": app_id,
            "query": query,
            "from": from_time,
            "to": to_time,
            "pageSize": log_platform_config.get('default_page_size', 100),
            "page": 1
        }
        
        try:
            print(f"查询错误日志 - appId: {app_id}, 接口: {api_path}, 错误码: {error_code}")
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            
            if response.status_code == 200:
                result = response.json()
                if result.get('code') == 0:
                    logs = result.get('data', {}).get('logs', [])
                    log_count = len(logs)
                    print(f"在 {app_id} 中获取 {log_count} 条错误日志")
                    all_logs.extend(logs)
                    query_results[app_id] = {'success': True, 'count': log_count}
                else:
                    print(f"服务 {app_id} 日志查询失败: {result.get('message', '未知错误')}")
                    query_results[app_id] = {'success': False, 'error': result.get('message', '未知错误')}
            else:
                print(f"服务 {app_id} API请求失败: HTTP {response.status_code}")
                query_results[app_id] = {'success': False, 'error': f'HTTP {response.status_code}'}
                
        except Exception as e:
            print(f"查询服务 {app_id} 异常: {e}")
            query_results[app_id] = {'success': False, 'error': str(e)}
    
    # 输出查询摘要
    print("\n📊 查询结果摘要:")
    for app_id, result in query_results.items():
        if result['success']:
            print(f"  ✅ {app_id}: {result['count']} 条日志")
        else:
            print(f"  ❌ {app_id}: {result['error']}")
    
    
    return all_logs


def extract_trace_ids_from_logs(logs: List[Dict[str, Any]]) -> List[str]:
    """从日志中提取trace_id列表"""
    trace_ids = []
    
    for log in logs:
        trace_id = log.get('log.trace_id', '')
        if trace_id and trace_id not in trace_ids:
            trace_ids.append(trace_id)
    
    return trace_ids

def run_error_code_query(input: dict) -> dict:
    """
    根据接口路径和错误码查询错误日志，然后提取trace_id进行完整诊断
    
    这是一个两步流程：
    1. 根据接口+错误码查询日志（必须同时满足），获取trace_id
    2. 拿到trace_id后，复用"Trace ID 诊断"流程
    
    Args:
        input: 包含api_path、error_code和可选的selected_services的字典
        
    Returns:
        包含日志列表和分析结果的字典
    """
    api_path = input.get("api_path", "").strip()
    error_code = input.get("error_code", "").strip()
    time_range_hours = input.get("time_range_hours")  # 可选参数
    selected_services = input.get("selected_services")  # 可选参数：指定的服务列表
    
    if not api_path:
        return {
            "success": False,
            "error": "接口路径不能为空",
            "step": "validation"
        }
    
    if not error_code:
        return {
            "success": False,
            "error": "错误码不能为空", 
            "step": "validation"
        }
    
    # 加载配置
    config = load_config()
    if not config.get('projects', {}):
        return {
            "success": False,
            "error": "配置文件中未找到项目配置",
            "step": "config"
        }
    
    # 第一步：根据接口+错误码查询日志（必须同时满足）
    print("🔍 第一步：根据接口路径和错误码查询相关日志...")
    logs = query_by_error_code(api_path, error_code, config, time_range_hours, selected_services)
    
    if not logs:
        actual_time_range = time_range_hours or config.get('log_platform', {}).get('query_time_range_hours', 24)
        return {
            "success": False,
            "error": "未查询到同时包含接口路径和错误码的日志",
            "step": "query_logs",
            "error_details": {
                "api_path": api_path,
                "error_code": error_code,
                "query_time_range_hours": actual_time_range,
                "query_condition": f"log.level = 'ERROR' and log.msg ~ '{api_path}' and log.msg ~ '{error_code}'",
                "suggestions": [
                    "请检查接口路径是否正确",
                    "请检查错误码是否正确",
                    f"确认该错误是否在最近{actual_time_range}小时内发生",
                    "尝试调整时间范围参数"
                ]
            }
        }
    
    # 第二步：从日志中提取trace_id
    print("🔍 第二步：从查询结果中提取trace_id...")
    trace_ids = extract_trace_ids_from_logs(logs)
    
    if not trace_ids:
        return {
            "success": False,
            "error": "查询到的日志中没有找到trace_id字段",
            "step": "extract_trace_id",
            "found_logs": len(logs),
            "sample_log_fields": list(logs[0].keys()) if logs else []
        }
    
    print(f"✅ 成功提取到 {len(trace_ids)} 个trace_id: {trace_ids[:3]}{'...' if len(trace_ids) > 3 else ''}")
    
    # 第三步：选择最新的trace_id，复用"Trace ID 诊断"流程
    selected_trace_id = trace_ids[0]  # 选择第一个（日志已按时间排序）
    print(f"🎯 选择最新的trace_id进行完整诊断: {selected_trace_id}")
    
    # 调用现有的trace_id查询函数，传递时间范围参数
    trace_result = run({"trace_id": selected_trace_id, "time_range_hours": time_range_hours})
    
    # 在结果中添加错误码查询的上下文信息
    if trace_result.get('success'):
        trace_result['error_code_context'] = {
            "api_path": api_path,
            "error_code": error_code,
            "initial_logs_found": len(logs),
            "trace_ids_extracted": len(trace_ids),
            "selected_trace_id": selected_trace_id,
            "all_trace_ids": trace_ids
        }
        trace_result['query_type'] = "error_code_to_trace"
    
    return trace_result


def run(input: dict) -> dict:
    """
    根据trace_id查询日志平台，获取完整调用链日志
    
    Args:
        input: 包含trace_id和可选的time_range_hours的字典
        
    Returns:
        包含日志列表和原始数据的字典
    """
    trace_id = input.get("trace_id", "").strip()
    time_range_hours = input.get("time_range_hours")  # 可选的自定义时间范围
    
    if not trace_id:
        return {
            "success": False,
            "error": "trace_id不能为空",
            "logs": [],
            "raw_data": []
        }
    
    # 加载配置
    config = load_config()
    projects_config = config.get('projects', {})
    
    if not projects_config:
        return {
            "success": False,
            "error": "配置文件中未找到项目配置",
            "logs": [],
            "raw_data": []
        }
    
    # 查询链路中的两个服务
    app_ids = ["demo.ads.ad-gateway", "demo.order.order-service"]
    all_logs = []
    
    for app_id in app_ids:
        logs = query_log_platform(app_id, trace_id, config, time_range_hours)
        all_logs.append(logs)
    
    # 合并并排序日志
    merged_logs = merge_and_sort_logs(all_logs)
    
    if not merged_logs:
        # 如果没有查到日志，返回错误信息
        print("未查询到真实日志")
        actual_time_range = time_range_hours or config.get('log_platform', {}).get('query_time_range_hours', 24)
        
        return {
            "success": False,
            "error": "未查询到相关日志数据",
            "error_details": {
                "trace_id": trace_id,
                "query_time_range_hours": actual_time_range,
                "queried_services": app_ids,
                "suggestions": [
                    "请检查trace_id是否正确",
                    f"确认该trace_id的请求是否在最近{actual_time_range}小时内发生", 
                    "确认trace_id格式是否正确（应为32位十六进制字符串）",
                    "检查网络连接是否正常"
                ]
            },
            "logs": [],
            "raw_data": [],
            "log_count": 0,
            "services": app_ids
        }
    
    # 格式化日志
    formatted_logs = format_logs_for_analysis(merged_logs)
    
    # 提取重要信息
    important_info = extract_important_info(merged_logs)
    
    actual_time_range = time_range_hours or config.get('log_platform', {}).get('query_time_range_hours', 24)
    
    return {
        "success": True,
        "logs": formatted_logs,
        "raw_data": merged_logs,
        "trace_id": trace_id,
        "log_count": len(formatted_logs),
        "services": app_ids,
        "query_time_range": f"最近{actual_time_range}小时",
        "important_info": important_info
    }