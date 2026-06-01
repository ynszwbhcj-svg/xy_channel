#!/usr/bin/env python3
"""
CSPL API 客户端 - Python 版本
用于调用 CSPL 安全检测 API
"""

import json
import os
import secrets
from typing import Dict, Any, Optional
from datetime import datetime

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    exit(1)


# 常量定义
ENV_FILE_PATH = "/home/sandbox/.openclaw/.xiaoyienv"
API_URL_SUFFIX = "/celia-claw/v1/rest-api/skill/execute"
DEFAULT_TIMEOUT = 5000  # 毫秒
HTTP_STATUS_BAD_REQUEST = 400

# 静态配置
CSPL_STATIC_CONFIG = {
    "skill_id": "skill-scope",
    "request_from": "openclaw",
    "text_source": "question",
    "action": "TOOL_OUTPUT_SCAN",
}


def generate_trace_id() -> str:
    """生成随机的 trace ID"""
    return secrets.token_hex(16)


def read_env_file(file_path: str = ENV_FILE_PATH) -> Dict[str, str]:
    """读取环境变量文件"""
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"[CSPL] 环境变量文件不存在: {file_path}")

    env_vars = {}
    with open(file_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            if '=' in line:
                key, value = line.split('=', 1)
                env_vars[key.strip()] = value.strip()

    return env_vars


def build_headers(uid: str, api_key: str, trace_id: Optional[str] = None) -> Dict[str, str]:
    """构建请求头"""
    if trace_id is None:
        trace_id = generate_trace_id()

    return {
        "x-hag-trace-id": trace_id,
        "x-uid": uid,
        "x-api-key": api_key,
        "x-request-from": CSPL_STATIC_CONFIG["request_from"],
        "x-skill-id": CSPL_STATIC_CONFIG["skill_id"],
        "content-type": "application/json",
    }


def build_payload(question_text: str) -> Dict[str, str]:
    """构建请求体"""
    return {
        "questionText": question_text,
        "textSource": CSPL_STATIC_CONFIG["text_source"],
        "action": CSPL_STATIC_CONFIG["action"],
    }


def log_request(url: str, headers: Dict[str, str], payload: Dict[str, str]) -> None:
    """打印请求信息"""
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    print(f"[{timestamp}] [CSPL API] ==================== 发起请求 ====================")
    print(f"[{timestamp}] [CSPL API] URL: {url}")
    print(f"[{timestamp}] [CSPL API] Method: POST")
    print(f"[{timestamp}] [CSPL API] Headers:")
    print(f"[{timestamp}] [CSPL API]   - x-hag-trace-id: {headers['x-hag-trace-id']}")
    print(f"[{timestamp}] [CSPL API]   - x-uid: {headers['x-uid']}")

    # 隐藏 API Key 敏感信息
    api_key = headers['x-api-key']
    masked_key = f"***{api_key[-8:]}" if len(api_key) > 8 else "***"
    print(f"[{timestamp}] [CSPL API]   - x-api-key: {masked_key}")

    print(f"[{timestamp}] [CSPL API]   - x-request-from: {headers['x-request-from']}")
    print(f"[{timestamp}] [CSPL API]   - x-skill-id: {headers['x-skill-id']}")
    print(f"[{timestamp}] [CSPL API]   - content-type: {headers['content-type']}")
    print(f"[{timestamp}] [CSPL API] Body:")

    # 截断过长的内容
    question_text = payload['questionText']
    preview = question_text[:100] + "..." if len(question_text) > 100 else question_text
    print(f"[{timestamp}] [CSPL API]   - questionText: {preview}")
    print(f"[{timestamp}] [CSPL API]   - textSource: {payload['textSource']}")
    print(f"[{timestamp}] [CSPL API]   - action: {payload['action']}")
    print(f"[{timestamp}] [CSPL API] =================================================")


def log_response(response: requests.Response, success: bool = True) -> None:
    """打印响应信息"""
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    print(f"[{timestamp}] [CSPL API] Response Status: {response.status_code}")
    print(f"[{timestamp}] [CSPL API] Response Headers: {json.dumps(dict(response.headers))}")

    if success:
        print(f"[{timestamp}] [CSPL API] ✅ 请求成功")
        # 截断过长的响应
        body = response.text
        preview = body[:200] + "..." if len(body) > 200 else body
        print(f"[{timestamp}] [CSPL API] Response Body: {preview}")
    else:
        print(f"[{timestamp}] [CSPL API] ❌ 请求失败")
        print(f"[{timestamp}] [CSPL API] Response Body: {response.text}")

    print(f"[{timestamp}] [CSPL API] =================================================")


def parse_response(response: requests.Response) -> Dict[str, Any]:
    """解析响应"""
    if not response.text or not response.text.strip():
        raise ValueError("[CSPL] API 响应为空")

    data = response.json()

    # 检查错误码
    if data.get('retCode') and data['retCode'] != '0':
        raise ValueError(f"[CSPL] API 错误: {data.get('retMsg', 'unknown')}")

    if not data.get('retCode') and data.get('code'):
        raise ValueError(f"[CSPL] 后端错误: {data.get('desc', 'unknown')}")

    return data


def call_cspl_api(
    question_text: str,
    uid: Optional[str] = None,
    api_key: Optional[str] = None,
    service_url: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    env_file: str = ENV_FILE_PATH
) -> Dict[str, Any]:
    """
    调用 CSPL API

    Args:
        question_text: 要检测的文本内容
        uid: 用户 ID（可选，默认从环境文件读取）
        api_key: API 密钥（可选，默认从环境文件读取）
        service_url: 服务 URL（可选，默认从环境文件读取）
        timeout: 超时时间（毫秒）
        env_file: 环境变量文件路径

    Returns:
        API 响应的 JSON 数据

    Raises:
        FileNotFoundError: 环境变量文件不存在
        ValueError: 缺少必要的配置参数或 API 返回错误
        requests.Timeout: 请求超时
        requests.RequestException: 其他请求错误
    """
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    # 如果未提供配置，从环境文件读取
    if uid is None or api_key is None or service_url is None:
        try:
            env_vars = read_env_file(env_file)
            uid = uid or env_vars.get('PERSONAL-UID')
            api_key = api_key or env_vars.get('PERSONAL-API-KEY')
            service_url = service_url or env_vars.get('SERVICE_URL')
        except Exception as e:
            raise ValueError(f"[CSPL] 读取环境变量失败: {e}")

    # 验证必要参数
    if not uid:
        raise ValueError("[CSPL] 缺少 uid 参数")
    if not api_key:
        raise ValueError("[CSPL] 缺少 api_key 参数")
    if not service_url:
        raise ValueError("[CSPL] 缺少 service_url 参数")

    # 构建完整 URL
    url = f"{service_url}{API_URL_SUFFIX}"

    # 构建请求
    headers = build_headers(uid, api_key)
    payload = build_payload(question_text)

    # 打印请求日志
    log_request(url, headers, payload)

    try:
        # 发送请求（timeout 转换为秒）
        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=timeout / 1000.0
        )

        # 检查 HTTP 状态码
        if response.status_code >= HTTP_STATUS_BAD_REQUEST:
            log_response(response, success=False)
            raise ValueError(f"[CSPL] HTTP 错误: {response.status_code}")

        # 解析响应
        result = parse_response(response)
        log_response(response, success=True)

        return result

    except requests.Timeout:
        print(f"[{timestamp}] [CSPL API] ⏰ 请求超时 ({timeout}ms)")
        raise
    except requests.RequestException as e:
        print(f"[{timestamp}] [CSPL API] ❌ 请求错误: {e}")
        raise


def main():
    """命令行入口示例"""
    import sys

    if len(sys.argv) < 2:
        print("用法: python cspl_client.py <question_text> [timeout_ms]")
        print("示例: python cspl_client.py '测试文本' 10000")
        sys.exit(1)

    question_text = sys.argv[1]
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_TIMEOUT

    try:
        result = call_cspl_api(question_text, uid='420086000107623357',api_key='SK-1F22EB33ACD82FBAE46266AD90C02398',service_url='https://hag-drcn.op.dbankcloud.com',timeout=timeout)
        print("\n✅ 调用成功!")
        print(f"结果: {json.dumps(result, indent=2, ensure_ascii=False)}")
    except Exception as e:
        print(f"\n❌ 调用失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
