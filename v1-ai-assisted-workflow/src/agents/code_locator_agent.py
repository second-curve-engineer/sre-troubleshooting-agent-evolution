import os
import re
import json
import glob
from pathlib import Path
from typing import Dict, List, Optional, Tuple

class CodeLocator:
    def __init__(self, config_path: str = None):
        """初始化代码定位器"""
        self.config = self._load_config(config_path)
        self.discovered_modules = None
        self.language_parsers = self._init_language_parsers()
    
    def _load_config(self, config_path: str = None) -> dict:
        """加载配置文件"""
        if config_path is None:
            config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
        
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            # 默认配置 - 兼容旧格式
            return {
                "projects": {
                    "default": {
                        "app_id": "default",
                        "root_path": ".",
                        "source_patterns": ["*/src/main/java", "src/main/java", "src"],
                        "auto_discover_modules": True,
                        "known_modules": [],
                        "package_prefixes": []
                    }
                },
                "languages": {
                    "java": {
                        "file_extensions": [".java"],
                        "stack_pattern": "at\\s+([^(]+)\\(([^:]+):(\\d+)\\)",
                        "package_separator": ".",
                        "path_separator": "/"
                    }
                },
                "search": {
                    "context_lines": 5,
                    "max_search_depth": 10,
                    "exclude_patterns": ["target", "build", ".git"]
                }
            }
    
    def _init_language_parsers(self) -> dict:
        """初始化各语言的异常解析器"""
        parsers = {}
        for lang, config in self.config["languages"].items():
            parsers[lang] = {
                "pattern": re.compile(config["stack_pattern"]),
                "extensions": config["file_extensions"],
                "package_sep": config["package_separator"],
                "path_sep": config["path_separator"]
            }
        return parsers
    
    def _determine_project(self, stacktrace: str) -> str:
        """根据异常栈确定属于哪个项目"""
        projects_config = self.config.get("projects", {})
        
        # 如果只有一个项目或者使用旧配置格式，直接返回
        if len(projects_config) <= 1:
            if "project" in self.config:  # 兼容旧格式
                return "legacy"
            return list(projects_config.keys())[0] if projects_config else "default"
        
        # 根据包名前缀匹配项目 - 按匹配度排序，优先选择最匹配的
        best_match = None
        best_match_score = 0
        
        for project_name, project_config in projects_config.items():
            package_prefixes = project_config.get("package_prefixes", [])
            for prefix in package_prefixes:
                # 计算匹配分数：匹配的字符数
                if prefix in stacktrace:
                    # 统计该前缀在异常栈中出现的次数
                    match_count = stacktrace.count(prefix)
                    match_score = len(prefix) * match_count
                    
                    if match_score > best_match_score:
                        best_match = project_name
                        best_match_score = match_score
                        print(f"找到更好的匹配 - 项目: {project_name}, 前缀: '{prefix}', 分数: {match_score}")
        
        if best_match:
            print(f"根据包名前缀确定项目: {best_match} (得分: {best_match_score})")
            return best_match
        
        # 如果没有匹配到，返回第一个项目
        default_project = list(projects_config.keys())[0]
        print(f"未匹配到具体项目，使用默认项目: {default_project}")
        return default_project
    
    def _get_project_config(self, project_name: str) -> dict:
        """获取指定项目的配置"""
        projects_config = self.config.get("projects", {})
        
        # 兼容旧配置格式
        if project_name == "legacy" and "project" in self.config:
            return self.config["project"]
        
        return projects_config.get(project_name, projects_config.get("default", {}))
    
    def _discover_modules(self, project_config: dict = None) -> List[str]:
        """自动发现项目模块"""
        if project_config is None:
            # 兼容旧版本调用
            project_config = self.config.get("project", {})
        
        root_path = project_config.get("root_path", ".")
        modules = []
        
        # 先添加已知模块
        modules.extend(project_config.get("known_modules", []))
        
        if project_config.get("auto_discover_modules", True):
            # 自动发现包含src目录的模块
            for pattern in ["*/src", "*/src/main", "*/src/main/java", "*/src/main/kotlin"]:
                search_pattern = os.path.join(root_path, pattern)
                for path in glob.glob(search_pattern):
                    module_path = os.path.dirname(path)
                    if pattern.count('/') > 1:  # 深层目录，需要回溯到模块根目录
                        for _ in range(pattern.count('/') - 1):
                            module_path = os.path.dirname(module_path)
                    
                    module_name = os.path.basename(module_path)
                    if module_name not in modules and module_path != root_path:
                        modules.append(module_name)
        
        # 去重并过滤
        exclude_patterns = self.config["search"].get("exclude_patterns", [])
        self.discovered_modules = [m for m in set(modules) 
                                 if not any(ex in m for ex in exclude_patterns)]
        return self.discovered_modules
    
    def _parse_stack_trace(self, stack_trace: str) -> List[dict]:
        """解析异常堆栈，支持多种语言 - 使用增强的解析功能"""
        all_calls = []
        
        # 使用增强的异常栈解析
        try:
            from stack_trace_analyze_agent import parse_stacktrace
            enhanced_frames = parse_stacktrace(stack_trace)
            
            # 转换为旧格式以保持兼容性
            for frame in enhanced_frames:
                call_info = {
                    'language': 'java',  # 目前主要支持Java
                    'full_method': frame.get('method', ''),
                    'class_name': frame.get('method', '').split('.')[-2] if '.' in frame.get('method', '') else '',
                    'method_name': frame.get('method', '').split('.')[-1] if '.' in frame.get('method', '') else frame.get('method', ''),
                    'file_name': frame.get('file', ''),
                    'line_number': frame.get('line', 0)
                }
                all_calls.append(call_info)
                
        except ImportError:
            # 回退到原始解析方法
            lines = stack_trace.split('\n')
            
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                    
                for lang, parser in self.language_parsers.items():
                    match = parser["pattern"].search(line)
                    if match:
                        call_info = self._extract_call_info(match, lang, parser)
                        if call_info:
                            all_calls.append(call_info)
                            break
        
        return all_calls
    
    def _extract_call_info(self, match, lang: str, parser: dict) -> Optional[dict]:
        """从正则匹配中提取调用信息"""
        try:
            if lang in ["java", "kotlin"]:
                full_method = match.group(1)
                file_name = match.group(2)
                line_number = int(match.group(3))
                
                # 提取类名和方法名
                parts = full_method.split(parser["package_sep"])
                method_name = parts[-1]
                class_name = parts[-2] if len(parts) > 1 else parts[-1]
                
                return {
                    'language': lang,
                    'full_method': full_method,
                    'class_name': class_name,
                    'method_name': method_name,
                    'file_name': file_name,
                    'line_number': line_number
                }
            elif lang == "python":
                file_path = match.group(1)
                line_number = int(match.group(2))
                method_name = match.group(3)
                file_name = os.path.basename(file_path)
                
                return {
                    'language': lang,
                    'full_method': f"{file_path}.{method_name}",
                    'class_name': os.path.splitext(file_name)[0],
                    'method_name': method_name,
                    'file_name': file_name,
                    'line_number': line_number,
                    'original_path': file_path
                }
            elif lang == "csharp":
                full_method = match.group(1)
                file_path = match.group(2)
                line_number = int(match.group(3))
                file_name = os.path.basename(file_path)
                
                parts = full_method.split('.')
                method_name = parts[-1]
                class_name = parts[-2] if len(parts) > 1 else parts[-1]
                
                return {
                    'language': lang,
                    'full_method': full_method,
                    'class_name': class_name,
                    'method_name': method_name,
                    'file_name': file_name,
                    'line_number': line_number,
                    'original_path': file_path
                }
        except (IndexError, ValueError):
            pass
        
        return None
    
    def _find_source_file(self, call_info: dict, project_config: dict = None) -> Optional[str]:
        """查找源文件路径"""
        if project_config is None:
            # 兼容旧版本调用
            project_config = self.config.get("project", {})
        
        root_path = project_config.get("root_path", ".")
        
        # Python和C#可能有直接路径
        if 'original_path' in call_info and os.path.exists(call_info['original_path']):
            return call_info['original_path']
        
        # 构建可能的文件路径
        possible_paths = []
        
        # 获取模块列表
        modules = self._discover_modules(project_config)
        if not modules:
            modules = [""]  # 直接在根目录搜索
        
        # Java/Kotlin类型的包路径映射
        if call_info['language'] in ['java', 'kotlin']:
            method_parts = call_info['full_method'].split('.')
            if len(method_parts) > 2:
                # 去掉方法名和类名，保留包路径
                package_parts = method_parts[:-2]
                package_path = '/'.join(package_parts)
            else:
                package_path = ""
            
            # 为每个模块和源码模式组合生成路径
            for module in modules:
                for src_pattern in project_config.get("source_patterns", ["src"]):
                    if module:
                        base_path = os.path.join(root_path, module, src_pattern)
                    else:
                        base_path = os.path.join(root_path, src_pattern)
                    
                    if package_path:
                        file_path = os.path.join(base_path, package_path, call_info['file_name'])
                    else:
                        file_path = os.path.join(base_path, call_info['file_name'])
                    
                    possible_paths.append(file_path)
        
        # 也尝试递归搜索文件名
        self._add_recursive_search_paths(root_path, call_info['file_name'], possible_paths)
        
        # 检查哪个路径存在
        for path in possible_paths:
            if os.path.exists(path):
                return path
        
        return None
    
    def _add_recursive_search_paths(self, root_path: str, file_name: str, paths: List[str]):
        """添加递归搜索路径"""
        exclude_patterns = self.config["search"].get("exclude_patterns", [])
        max_depth = self.config["search"].get("max_search_depth", 10)
        
        def should_exclude(path: str) -> bool:
            return any(pattern in path for pattern in exclude_patterns)
        
        def search_recursive(current_path: str, depth: int):
            if depth > max_depth or should_exclude(current_path):
                return
            
            try:
                for item in os.listdir(current_path):
                    item_path = os.path.join(current_path, item)
                    
                    if os.path.isfile(item_path) and item == file_name:
                        paths.append(item_path)
                    elif os.path.isdir(item_path) and not should_exclude(item_path):
                        search_recursive(item_path, depth + 1)
            except (PermissionError, OSError):
                pass
        
        search_recursive(root_path, 0)
    
    def _extract_code_context(self, file_path: str, line_number: int) -> dict:
        """提取代码上下文 - 返回多层次的代码信息"""
        context_lines = self.config["search"].get("context_lines", 5)
        
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
            
            # 基本上下文(±5行)
            start_line = max(1, line_number - context_lines)
            end_line = min(len(lines), line_number + context_lines)
            
            basic_context = ""
            for i in range(start_line - 1, end_line):
                line_content = lines[i].rstrip('\n')
                marker = " -> " if (i + 1) == line_number else "    "
                basic_context += f"{i + 1:4d}{marker}{line_content}\n"
            
            # 扩展上下文(±15行)
            extended_start = max(1, line_number - 15)
            extended_end = min(len(lines), line_number + 15)
            
            extended_context = ""
            for i in range(extended_start - 1, extended_end):
                line_content = lines[i].rstrip('\n')
                marker = " -> " if (i + 1) == line_number else "    "
                extended_context += f"{i + 1:4d}{marker}{line_content}\n"
            
            # 查找方法边界
            method_info = self._find_method_boundaries(lines, line_number)
            
            # 查找imports和类信息
            file_info = self._extract_file_info(lines)
            
            return {
                "basic_context": basic_context.strip(),
                "extended_context": extended_context.strip(),
                "method_info": method_info,
                "file_info": file_info,
                "total_lines": len(lines)
            }
        except Exception as e:
            return {
                "basic_context": f"读取文件失败: {str(e)}",
                "extended_context": "",
                "method_info": {},
                "file_info": {},
                "total_lines": 0
            }
    
    def _find_method_boundaries(self, lines: list, error_line: int) -> dict:
        """查找包含错误行的方法边界"""
        method_start = None
        method_end = None
        method_signature = ""
        method_name = ""
        
        # 向上查找方法开始 - 支持多行方法签名
        method_sig_lines = []
        found_method = False
        
        for i in range(error_line - 1, -1, -1):
            line = lines[i].strip()
            
            # 如果已经找到方法开始，继续收集签名行
            if found_method:
                method_sig_lines.insert(0, line)
                # 检查是否是方法签名的开始（包含访问修饰符）
                if any(keyword in line for keyword in ['public ', 'private ', 'protected ', 'static ', '@']):
                    if not line.startswith('@'):  # 跳过注解
                        method_start = i + 1
                        break
                continue
            
            # 寻找方法开始的标志
            if '(' in line and ')' in line:
                # 检查下一行是否有开大括号
                next_line_idx = i + 1
                if next_line_idx < len(lines):
                    next_line = lines[next_line_idx].strip()
                    if next_line.startswith('{') or line.endswith('{'):
                        found_method = True
                        method_sig_lines.append(line)
                        
                        # 提取方法名
                        if '(' in line:
                            before_paren = line[:line.find('(')]
                            method_parts = before_paren.split()
                            if method_parts:
                                method_name = method_parts[-1]
        
        # 组合完整的方法签名
        if method_sig_lines:
            method_signature = ' '.join(method_sig_lines)
        
        # 向下查找方法结束
        if method_start:
            brace_count = 0
            in_method = False
            
            for i in range(method_start - 1, len(lines)):
                line = lines[i]
                
                # 计算大括号
                open_braces = line.count('{')
                close_braces = line.count('}')
                
                if open_braces > 0:
                    in_method = True
                    
                brace_count += open_braces - close_braces
                
                # 方法结束
                if in_method and brace_count == 0 and i > method_start - 1:
                    method_end = i + 1
                    break
        
        # 提取完整方法代码
        method_code = ""
        if method_start and method_end:
            for i in range(method_start - 1, method_end):
                line_content = lines[i].rstrip('\n')
                marker = " -> " if (i + 1) == error_line else "    "
                method_code += f"{i + 1:4d}{marker}{line_content}\n"
        
        return {
            "method_start_line": method_start,
            "method_end_line": method_end,
            "method_signature": method_signature.strip(),
            "method_name": method_name,
            "method_code": method_code.strip(),
            "method_lines": method_end - method_start + 1 if method_start and method_end else 0
        }
    
    def _extract_file_info(self, lines: list) -> dict:
        """提取文件级信息：包声明、imports、类信息"""
        package = ""
        imports = []
        class_info = {}
        
        for i, line in enumerate(lines[:50]):  # 只检查前50行
            line = line.strip()
            
            # 包声明
            if line.startswith('package '):
                package = line.replace('package ', '').replace(';', '').strip()
            
            # import语句
            elif line.startswith('import '):
                imports.append(line.replace('import ', '').replace(';', '').strip())
            
            # 类声明
            elif any(keyword in line for keyword in ['class ', 'interface ', 'enum ']):
                if 'class ' in line:
                    class_name = line.split('class ')[1].split()[0].split('<')[0]
                    class_info = {
                        "name": class_name,
                        "line": i + 1,
                        "signature": line
                    }
                    break
        
        return {
            "package": package,
            "imports": imports[:10],  # 只保留前10个import
            "class_info": class_info
        }
    
    def locate(self, stack_trace: str) -> dict:
        """主要的代码定位方法"""
        # 确定项目
        project_name = self._determine_project(stack_trace)
        project_config = self._get_project_config(project_name)
        
        print(f"定位代码 - 使用项目: {project_name}")
        
        # 解析堆栈跟踪
        all_calls = self._parse_stack_trace(stack_trace)
        
        if not all_calls:
            return {"error": "未找到可解析的堆栈信息"}
        
        # 优先查找我们服务的调用栈帧
        our_service_calls = []
        other_calls = []
        
        package_prefixes = project_config.get("package_prefixes", [])
        for call_info in all_calls:
            is_our_service = any(prefix in call_info.get('full_method', '') for prefix in package_prefixes)
            if is_our_service:
                our_service_calls.append(call_info)
            else:
                other_calls.append(call_info)
        
        # 优先处理我们服务的调用栈帧
        prioritized_calls = our_service_calls + other_calls
        
        # 找到第一个可定位的调用
        for call_info in prioritized_calls:
            file_path = self._find_source_file(call_info, project_config)
            
            if file_path:
                root_path = project_config.get("root_path", ".")
                code_info = self._extract_code_context(file_path, call_info['line_number'])
                
                result = {
                    "success": True,
                    "file": file_path,
                    "relative_file": os.path.relpath(file_path, root_path),
                    "language": call_info['language'],
                    "method": call_info['method_name'],
                    "class": call_info['class_name'],
                    "line": call_info['line_number'],
                    
                    # 兼容原有格式
                    "code": code_info.get("basic_context", ""),
                    
                    # 增强的代码信息
                    "code_context": {
                        "basic": code_info.get("basic_context", ""),
                        "extended": code_info.get("extended_context", ""),
                        "method": code_info.get("method_info", {}),
                        "file_info": code_info.get("file_info", {}),
                        "total_lines": code_info.get("total_lines", 0)
                    },
                    
                    # 原始异常栈信息
                    "stack_trace": {
                        "original": stack_trace,
                        "parsed_calls": all_calls
                    },
                    
                    # 项目信息
                    "project_info": {
                        "project_name": project_name,
                        "app_id": project_config.get("app_id", "unknown"),
                        "root_path": root_path,
                        "discovered_modules": self._discover_modules(project_config),
                        "config": {
                            "context_lines": self.config["search"].get("context_lines", 5),
                            "language_config": self.config["languages"].get(call_info['language'], {})
                        }
                    }
                }
                
                return result
        
        # 没有找到任何文件
        return {
            "error": "未找到任何源文件",
            "parsed_calls": all_calls,
            "discovered_modules": self._discover_modules()
        }

# 保持向后兼容
def run(input: dict) -> dict:
    """向后兼容的入口函数"""
    stack_trace = input.get("stacktrace", input.get("stack_trace", ""))
    config_path = input.get("config_path")
    
    locator = CodeLocator(config_path)
    return locator.locate(stack_trace)