import errno
import re

from app.enmus.task_status_enums import TaskStatus


STAGE_HINTS = {
    TaskStatus.PARSING: ("解析链接", "请确认所选平台和链接匹配，并检查原视频是否可播放。"),
    TaskStatus.CONFIGURING_MODEL: ("配置 AI 模型", "请检查所选模型、供应商的 API Key 和接口地址。"),
    TaskStatus.DOWNLOADING: ("下载音视频", "请确认原视频可播放，再检查该平台的 Cookie 和下载代理。"),
    TaskStatus.TRANSCRIBING: ("音频转写", "请检查音频是否可播放，以及设置中的转写引擎和模型是否就绪。"),
    TaskStatus.SUMMARIZING: ("AI 总结", "请检查模型供应商的连通性、额度和所选模型。"),
    TaskStatus.FORMATTING: ("整理笔记", "请重试生成，或调整原片截图和跳转选项。"),
    TaskStatus.SAVING: ("保存笔记", "请检查笔记目录的写入权限和磁盘空间。"),
}


def describe_task_failure(stage: TaskStatus, error: Exception) -> str:
    """生成用户可见的提示，不把上游响应、凭据或完整 URL 带到前端。"""
    label, hint = STAGE_HINTS[stage]
    raw = str(error).lower()
    status = getattr(error, "status_code", None) or getattr(getattr(error, "response", None), "status_code", None)
    if not status and (match := re.search(r"(?:http error|http status|status code)\s*[:=]?\s*(\d{3})", raw)):
        status = int(match[1])

    if getattr(error, "errno", None) == errno.ENOSPC:
        hint = "磁盘空间不足，请释放空间后重试。"
    elif isinstance(error, PermissionError):
        hint = "没有读取或写入所需文件的权限。"
    elif stage == TaskStatus.DOWNLOADING and isinstance(error, FileNotFoundError):
        hint = "找不到媒体文件。请重新上传本地视频，或确认原视频链接仍可播放。"
    elif "api key" in raw and "未配置" in raw:
        hint = "API Key 未配置，请先到设置中填写。"
    elif status == 402:
        hint = "服务返回 402，请检查 API 账户余额或额度。"
    elif status in (401, 403, 412):
        if stage == TaskStatus.DOWNLOADING:
            hint = f"视频平台拒绝访问（HTTP {status}）。请检查登录 Cookie、视频权限和代理。"
        else:
            hint = f"服务拒绝访问（HTTP {status}）。请检查 API Key 和使用权限。"
    elif status == 429:
        hint = "服务请求过于频繁或达到额度上限，请稍后重试并检查额度。"
    elif stage == TaskStatus.SUMMARIZING and status in (400, 404, 422):
        hint = f"供应商拒绝模型请求（HTTP {status}）。请检查模型名、接口地址及模型是否支持所选功能。"
    elif stage == TaskStatus.DOWNLOADING and ("no video formats" in raw or "无法下载小红书" in raw):
        hint = "未取得可用的视频流。请确认原视频可播放，再检查该平台的 Cookie。"
    elif raw in ("转写器未返回结果", "ai 模型未返回笔记内容"):
        hint = f"{error}。{hint}"
    elif "timeout" in raw or "timed out" in raw or "超时" in raw:
        hint = "请求超时，请检查网络或代理后重试。"

    return f"{label}失败：{hint}"
