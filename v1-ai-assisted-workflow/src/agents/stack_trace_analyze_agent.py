import json
import re
from typing import Dict, List, Any, Optional


def load_config() -> dict:
    """加载配置文件"""
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"加载配置文件失败: {e}")
        return {}


def extract_exception_info(logs: List[str]) -> Dict[str, Any]:
    """从日志中提取异常信息"""
    exception_info = {
        "has_exception": False,
        "exception_type": "",
        "exception_message": "",
        "exception_stacktrace": "",
        "source_service": ""
    }
    
    for log in logs:
        # 查找异常栈信息
        if "StackTrace:" in log:
            stacktrace = log.replace("StackTrace:", "").strip()
            exception_info["exception_stacktrace"] = stacktrace
            exception_info["has_exception"] = True
            
            # 根据文档说明分析异常来源服务
            if "com.example.ads" in stacktrace:
                exception_info["source_service"] = "ad-gateway"  # ad-gateway服务
            elif "com.example.order" in stacktrace:
                exception_info["source_service"] = "order-service"  # order服务
        
        # 查找异常类型和消息
        if "Exception:" in log:
            parts = log.split("Exception:")[-1].strip()
            if " - " in parts:
                exc_type, exc_msg = parts.split(" - ", 1)
                exception_info["exception_type"] = exc_type.strip()
                exception_info["exception_message"] = exc_msg.strip()
            else:
                exception_info["exception_type"] = parts.strip()
    
    return exception_info


def extract_request_parameters(logs: List[str]) -> List[Dict[str, Any]]:
    """从日志中提取请求参数"""
    parameters = []
    
    for log in logs:
        # 查找args字段（请求参数）
        if '"args":' in log or 'args=' in log:
            try:
                # 尝试提取JSON格式的args
                if '"args":' in log:
                    start_idx = log.find('"args":')
                    # 简单提取，实际可能需要更复杂的JSON解析
                    args_part = log[start_idx:].split(',')[0] if ',' in log[start_idx:] else log[start_idx:]
                    parameters.append({
                        "type": "json_args",
                        "content": args_part,
                        "source_log": log[:100] + "..." if len(log) > 100 else log
                    })
                
                # 尝试提取URL参数格式的args
                elif 'args=' in log:
                    start_idx = log.find('args=')
                    end_idx = log.find(' ', start_idx) if ' ' in log[start_idx:] else len(log)
                    args_content = log[start_idx:end_idx]
                    parameters.append({
                        "type": "url_args", 
                        "content": args_content,
                        "source_log": log[:100] + "..." if len(log) > 100 else log
                    })
            except Exception as e:
                print(f"提取参数时出错: {e}")
    
    return parameters


def analyze_call_chain(logs: List[str]) -> Dict[str, Any]:
    """分析请求调用链"""
    call_chain = {
        "services": [],
        "request_flow": [],
        "error_point": None
    }
    
    service_pattern = r'\[([^]]+)\]'
    path_pattern = r'path:([^\s]+)'
    
    for log in logs:
        # 提取服务名
        service_matches = re.findall(service_pattern, log)
        for service in service_matches:
            if service not in call_chain["services"] and ("demo." in service or "example" in service):
                call_chain["services"].append(service)
        
        # 提取请求路径
        path_matches = re.findall(path_pattern, log)
        for path in path_matches:
            call_chain["request_flow"].append({
                "path": path,
                "service": service_matches[-1] if service_matches else "unknown",
                "log_snippet": log[:200] + "..." if len(log) > 200 else log
            })
        
        # 识别错误点
        if any(level in log.upper() for level in ["ERROR", "EXCEPTION", "FAILED"]):
            if not call_chain["error_point"]:
                call_chain["error_point"] = {
                    "log": log,
                    "service": service_matches[-1] if service_matches else "unknown"
                }
    
    return call_chain


def is_infrastructure_code(method_name: str, file_name: str) -> bool:
    """判断是否为基础设施代码（切面、拦截器、框架代码等）"""
    full_path = f"{method_name} {file_name}"
    
    # 先检查是否为我们的业务代理类（这些不是基础设施代码）
    business_proxy_patterns = [
        'com.example.order.service.proxy.',
        'com.example.ads.service.proxy.'
    ]
    
    for pattern in business_proxy_patterns:
        if pattern in method_name:
            return False  # 业务代理类，不是基础设施代码
    
    # 基础设施代码模式
    infrastructure_patterns = [
        # 切面和拦截器
        'Interceptor', 'interceptor', 'Aspect', 'aspect',
        # Spring框架
        'cglib', 'spring.aop', 'reflect',
        # gRPC框架
        'grpc.stub', 'grpc.internal', 'grpc.observable',
        # 其他框架
        'AbstractObservability', 'ErrorHandling'
    ]
    
    return any(pattern in full_path for pattern in infrastructure_patterns)

def get_business_priority(method_name: str, file_name: str) -> int:
    """获取业务逻辑优先级，数字越小优先级越高"""
    # 判断是否为我们的服务
    is_our_service = any(prefix in method_name for prefix in ["com.example.order", "com.example.ads"])
    
    if not is_our_service:
        return 10  # 非我们的服务，优先级最低
    
    # 基础设施代码优先级低
    if is_infrastructure_code(method_name, file_name):
        return 8
    
    # 代理类优先级低
    if "<generated>" in file_name or "$$" in method_name:
        return 7
    
    # 根据包路径判断业务价值
    if ".service.proxy." in method_name:
        return 1  # 服务代理层，通常是业务入口
    elif ".service.impl." in method_name:
        return 2  # 业务实现层
    elif ".app.rpc." in method_name:
        return 3  # RPC服务层
    elif ".app.aspect." in method_name:
        return 6  # 切面层，优先级较低
    elif ".app.grpc.interceptor." in method_name:
        return 9  # 拦截器层，优先级很低
    else:
        return 4  # 其他业务代码

def parse_stacktrace(stacktrace: str) -> List[Dict[str, Any]]:
    """解析异常栈 - 增强版，支持更多格式，智能跳过基础设施代码"""
    stack_frames = []
    
    if not stacktrace:
        return stack_frames
    
    # 清理异常栈文本（移除转义字符等）
    cleaned_stacktrace = stacktrace.replace('\\\\n', '\n').replace('\\\\t', '\t').replace('\\n', '\n').replace('\\t', '\t')
    
    # 如果异常栈是一行连续的文本，尝试按"at "分割
    if '\n' not in cleaned_stacktrace and cleaned_stacktrace.count(' at ') > 1:
        # 处理连续异常栈的情况
        parts = cleaned_stacktrace.split(' at ')
        lines = [parts[0]]  # 异常消息
        for part in parts[1:]:
            lines.append('at ' + part)
        cleaned_stacktrace = '\n'.join(lines)
    
    # Java异常栈模式（更宽松的匹配）
    java_patterns = [
        r'at\s+([^(]+)\(([^:)]+):(\d+)\)',  # 标准格式: at method(file:line)
        r'at\s+([^(]+)\(([^:)]+)\)',        # 无行号格式: at method(file)
        r'at\s+([^(]+)\(<generated>\)',     # 代理类格式: at method(<generated>)
    ]
    
    lines = cleaned_stacktrace.split('\n')
    for line_idx, line in enumerate(lines):
        line = line.strip()
        
        # 跳过空行和异常消息行
        if not line or (line_idx == 0 and not line.startswith('at ')):
            continue
        
        for pattern in java_patterns:
            match = re.search(pattern, line)
            if match:
                method_name = match.group(1).strip()
                file_name = match.group(2).strip() if len(match.groups()) >= 2 else ""
                line_number = int(match.group(3)) if len(match.groups()) >= 3 and match.group(3).isdigit() else 0
                
                # 判断是否为我们的服务
                is_our_service = any(prefix in method_name for prefix in ["com.example.order", "com.example.ads"])
                
                # 排除非我们服务的基础设施代码
                if not is_our_service:
                    skip_frame = any(skip in method_name.lower() for skip in ['cglib', 'spring.aop', 'proxy', 'reflect'])
                    if skip_frame:
                        break
                
                # 计算业务优先级
                business_priority = get_business_priority(method_name, file_name)
                is_infrastructure = is_infrastructure_code(method_name, file_name)
                
                stack_frames.append({
                    "method": method_name,
                    "file": file_name,
                    "line": line_number,
                    "full_line": line,
                    "is_generated": "<generated>" in line or "$$" in method_name,
                    "is_our_service": is_our_service,
                    "is_infrastructure": is_infrastructure,
                    "business_priority": business_priority
                })
                break
    
    # 按业务价值排序：业务优先级高的优先
    stack_frames.sort(key=lambda frame: (
        frame.get("business_priority", 10),  # 业务优先级
        not frame.get("is_our_service", False),  # 我们的服务优先
        frame.get("is_generated", False)  # 非生成代码优先
    ))
    
    return stack_frames


def determine_main_error_location(exception_info: Dict, stack_frames: List[Dict]) -> Optional[Dict]:
    """确定主要错误位置 - 优先选择我们服务的最深层调用"""
    if not stack_frames:
        return None
    
    our_service_frames = []
    other_frames = []
    
    # 分类栈帧：我们的服务 vs 其他服务
    for frame in stack_frames:
        method = frame.get("method", "")
        if any(prefix in method for prefix in ["com.example.order", "com.example.ads"]):
            service_name = "order-service" if "com.example.order" in method else "ad-gateway"
            our_service_frames.append({
                "method": method,
                "file": frame.get("file", ""),
                "line": frame.get("line", 0),
                "service": service_name,
                "is_our_service": True,
                "full_frame": frame
            })
        else:
            other_frames.append({
                "method": method,
                "file": frame.get("file", ""),
                "line": frame.get("line", 0),
                "service": "external",
                "is_our_service": False,
                "full_frame": frame
            })
    
    # 如果有我们服务的栈帧，选择第一个（通常是最直接的错误位置）
    if our_service_frames:
        return our_service_frames[0]
    
    # 如果没有我们服务的错误，返回第一个external frame
    if other_frames:
        return other_frames[0]
    
    return None


def analyze_important_info(important_info: Dict[str, Any]) -> Dict[str, Any]:
    """分析从trace_log_query_agent传来的重要信息"""
    analysis = {
        "has_real_exceptions": False,
        "real_stacktrace": "",
        "real_exception_type": "",
        "real_exception_message": "",
        "request_chain": [],
        "error_service": ""
    }
    
    # 分析真实异常信息
    exceptions = important_info.get("exceptions", [])
    if exceptions:
        analysis["has_real_exceptions"] = True
        # 使用第一个异常（extract_important_info已经选择了最佳异常）
        best_exception = exceptions[0]
        analysis["real_stacktrace"] = best_exception.get("stacktrace", "")
        analysis["real_exception_type"] = best_exception.get("type", "")
        analysis["real_exception_message"] = best_exception.get("message", "")
        analysis["error_service"] = best_exception.get("service", "")
    
    # 分析请求链路
    caller_paths = important_info.get("caller_paths", [])
    service_calls = important_info.get("service_calls", [])
    
    for path_info in caller_paths:
        analysis["request_chain"].append({
            "type": "request_path",
            "service": path_info.get("service", ""),
            "path": path_info.get("path", "")
        })
    
    for call_info in service_calls:
        analysis["request_chain"].append({
            "type": "service_call",
            "from": call_info.get("from_service", ""),
            "to": call_info.get("to_service", ""),
            "path": call_info.get("path", ""),
            "timestamp": call_info.get("timestamp", 0)
        })
    
    # 按时间戳排序
    analysis["request_chain"].sort(key=lambda x: x.get("timestamp", 0))
    
    return analysis


def run(input: dict) -> dict:
    """
    分析日志和异常栈，提取关键信息和调用链
    
    Args:
        input: 包含logs的字典，可能来自trace_log_query_agent的输出
        
    Returns:
        分析结果，包含异常信息、参数、调用链等
    """
    logs = input.get("logs", [])
    important_info = input.get("important_info", {})  # 新增：来自trace_log_query_agent的重要信息
    
    if not logs:
        return {
            "success": False,
            "error": "输入日志为空",
            "has_exception": False
        }
    
    # 如果有重要信息，优先使用重要信息进行分析
    if important_info:
        important_analysis = analyze_important_info(important_info)
        
        # 使用真实的异常栈信息
        if important_analysis["has_real_exceptions"]:
            stack_frames = parse_stacktrace(important_analysis["real_stacktrace"])
            exception_info = {
                "has_exception": True,
                "exception_type": important_analysis["real_exception_type"],
                "exception_message": important_analysis["real_exception_message"],
                "exception_stacktrace": important_analysis["real_stacktrace"],
                "source_service": important_analysis["error_service"]
            }
            
            main_error_location = determine_main_error_location(exception_info, stack_frames)
            
            # 获取请求参数
            request_params = []
            for param_info in important_info.get("request_params", []):
                request_params.append({
                    "type": "grpc_args",
                    "content": param_info.get("args", ""),
                    "service": param_info.get("service", ""),
                    "scope": param_info.get("scope", "")
                })
            
            # 构造增强的结果
            result = {
                "success": True,
                "has_exception": True,
                "exception_info": exception_info,
                "request_parameters": request_params,
                "call_chain": {
                    "services": list(set([item.get("service", "") for item in important_analysis["request_chain"] if item.get("service")])),
                    "request_flow": important_analysis["request_chain"],
                    "error_point": {
                        "service": important_analysis["error_service"],
                        "exception_type": important_analysis["real_exception_type"]
                    }
                },
                "stack_frames": stack_frames,
                "main_error_location": main_error_location,
                "analysis_summary": {
                    "total_logs": len(logs),
                    "services_involved": list(set([item.get("service", "") for item in important_analysis["request_chain"] if item.get("service")])),
                    "has_request_params": len(request_params) > 0,
                    "error_service": important_analysis["error_service"],
                    "used_real_api_data": True
                }
            }
            
            # 构造标准格式的异常栈字符串供后续使用
            if main_error_location:
                result["stack"] = [{
                    "file": main_error_location["file"],
                    "line": main_error_location["line"],
                    "method": main_error_location["method"],
                    "service": main_error_location["service"]
                }]
                
                if stack_frames:
                    formatted_stack = "\n".join([f"    at {frame['method']}({frame['file']}:{frame['line']})" 
                                               for frame in stack_frames[:10]])
                    result["stacktrace"] = f"{exception_info.get('exception_type', 'Exception')}\n{formatted_stack}"
                else:
                    result["stacktrace"] = f"{exception_info.get('exception_type', 'Exception')} at {main_error_location['method']}({main_error_location['file']}:{main_error_location['line']})"
            
            return result
    
    # 如果没有重要信息，使用原有的分析方法
    # 提取异常信息
    exception_info = extract_exception_info(logs)
    
    # 提取请求参数
    request_params = extract_request_parameters(logs)
    
    # 分析调用链
    call_chain = analyze_call_chain(logs)
    
    # 解析异常栈
    stack_frames = []
    main_error_location = None
    
    if exception_info["has_exception"] and exception_info["exception_stacktrace"]:
        stack_frames = parse_stacktrace(exception_info["exception_stacktrace"])
        main_error_location = determine_main_error_location(exception_info, stack_frames)
    
    # 构造结果
    result = {
        "success": True,
        "has_exception": exception_info["has_exception"],
        "exception_info": exception_info,
        "request_parameters": request_params,
        "call_chain": call_chain,
        "stack_frames": stack_frames,
        "main_error_location": main_error_location,
        "analysis_summary": {
            "total_logs": len(logs),
            "services_involved": call_chain["services"],
            "has_request_params": len(request_params) > 0,
            "error_service": exception_info.get("source_service", "unknown"),
            "used_real_api_data": False
        }
    }
    
    # 如果有主要错误位置，为后续代码定位提供简化的栈信息
    if main_error_location:
        result["stack"] = [{
            "file": main_error_location["file"],
            "line": main_error_location["line"],
            "method": main_error_location["method"],
            "service": main_error_location["service"]
        }]
        
        # 构造标准格式的异常栈字符串供后续使用
        if stack_frames:
            formatted_stack = "\n".join([f"    at {frame['method']}({frame['file']}:{frame['line']})" 
                                       for frame in stack_frames[:10]])  # 只取前10行
            result["stacktrace"] = f"{exception_info.get('exception_type', 'Exception')}\n{formatted_stack}"
        else:
            result["stacktrace"] = f"{exception_info.get('exception_type', 'Exception')} at {main_error_location['method']}({main_error_location['file']}:{main_error_location['line']})"
    
    return result
