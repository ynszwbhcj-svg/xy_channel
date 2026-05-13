---
name: doubao_seedream
description: 豆包的文生图工具
allowed-tools: function_call_tool(*)
metadata:
  tools:
    - pluginId: 7dedac1c0f9a45faabb07edbb8a4e31d
      toolName: SeedreamBatch_5
  version: "1.0.0"
---

## 何时使用

当用户需要根据文本描述生成图片时使用此 skill。典型场景包括：
- 用户明确要求“生成一张图”、“画一张...”等
- 用户需要视觉化呈现某个概念、场景或创意
- 用户需要一个基于文本描述（即 prompt）的图片创作

## 工具

| 场景 | pluginId | toolName | 必需参数 | 完整 schema |
|------|----------|----------|----------|--------------|
| 文生图（豆包 Seedream） | `7dedac1c0f9a45faabb07edbb8a4e31d` | `SeedreamBatch_5` | `prompt` (String): 图片描述文本<br>`size` (String): 生成图片尺寸 | `{"type":"object","required":["prompt","size"],"properties":{"prompt":{"type":"String","description":"query"},"size":{"type":"String","description":"生成的图片尺寸"}}}` |

## 调用方式

通过 `function_call_tool` 工具调用豆包 Seedream 的文生图能力。示例：

```json
{
  "pluginId": "7dedac1c0f9a45faabb07edbb8a4e31d",
  "toolName": "SeedreamBatch_5",
  "arguments": {
    "prompt": "一只可爱的橘猫坐在阳光下的窗台上",
    "size": "1024x1024"
  }
}
```

**参数说明：**
- `prompt` (String, 必填)：图片的文本描述，应清晰、具体，以获得更好的生成效果
- `size` (String, 必填)：生成图片的尺寸，常见取值如 `"1024x1024"`, `"512x512"` 等

## 响应处理

调用成功后，工具会返回生成的图片相关信息（如图片 URL 或 Base64 数据）。建议的处理流程：

1. 从响应中提取图片数据
2. 若返回 URL，可直接展示或提示用户访问链接
3. 若返回 Base64 图片数据，可转换为可视格式展示给用户
4. 向用户提供图片基本信息（如尺寸、描述等）

**响应示例（示意）：**
```json
{
  "success": true,
  "data": {
    "image_url": "https://example.com/generated_image.png",
    "prompt_used": "一只可爱的橘猫坐在阳光下的窗台上",
    "size": "1024x1024"
  }
}
```

## 错误处理

常见错误及处理方式：

| 错误类型 | 可能原因 | 处理建议 |
|---------|----------|----------|
| 参数缺失 | 未提供 `prompt` 或 `size` | 检查调用参数，确保两个必填字段都已提供 |
| 参数格式错误 | `size` 值不被支持 | 提示用户使用正确的尺寸格式，或查阅文档确认可用尺寸 |
| 服务不可用 | 豆包 Seedream 服务异常 | 提示用户稍后重试，或建议使用其他文生图工具 |
| 生成失败 | prompt 内容违规或其他原因 | 建议用户修改 prompt 描述，避免敏感或无效内容 |

**错误处理示例：**
```
调用失败：缺少必要参数 'prompt'
→ 请向用户询问：“请提供您想要生成的图片描述（prompt）和想要的尺寸。”
```

在调用前，建议也验证 `prompt` 非空且长度适中（一般不超过 2000 字符），`size` 格式符合预期（如 `宽度x高度` 格式）。
