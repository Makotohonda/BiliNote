import hashlib
import json
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from urllib.parse import urljoin, urlsplit

import requests

from app.downloaders.base import QUALITY_MAP
from app.models.audio_model import AudioDownloadResult
from app.services.constant import SUPPORT_PLATFORM_MAP
from app.utils.path_helper import get_data_dir
from app.utils.url_parser import extract_video_id, is_xiaohongshu_video_url, normalize_video_url
from ffmpeg_helper import ensure_ffmpeg_or_raise


HOSTS = {
    "bilibili": {"bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"},
    "youtube": {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"},
    "douyin": {"douyin.com", "www.douyin.com", "v.douyin.com", "m.douyin.com", "iesdouyin.com", "www.iesdouyin.com"},
    "kuaishou": {"kuaishou.com", "www.kuaishou.com", "v.kuaishou.com", "m.gifshow.com"},
    "xiaohongshu": {"xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com"},
}
_DOWNLOAD_LOCKS = [Lock() for _ in range(32)]
SHORT_HOSTS = {"b23.tv", "v.douyin.com", "v.kuaishou.com"}


def normalize_download_link(url: str, platform: str | None = None) -> tuple[str, str]:
    parts = urlsplit(url.strip())
    host = parts.hostname
    detected = next((name for name, domains in HOSTS.items() if host in domains), None)
    if (not detected or (platform and platform != detected) or parts.scheme not in ("https", "http")
            or parts.username is not None or parts.password is not None or parts.port is not None):
        raise ValueError("请填写与所选平台匹配的视频链接。")
    url = parts._replace(fragment="").geturl()
    if detected == "bilibili":
        if host in SHORT_HOSTS and not re.fullmatch(r"/[a-zA-Z0-9_-]+/?", parts.path):
            raise ValueError("无法识别哔哩哔哩分享短链。")
        url = normalize_video_url(url)
        if host not in SHORT_HOSTS and not re.match(r"https://www\.bilibili\.com/video/BV[0-9A-Za-z]+", url):
            if not re.fullmatch(r"/video/av\d+/?", parts.path, re.IGNORECASE):
                raise ValueError("无法识别哔哩哔哩视频 ID。")
            url = parts._replace(netloc="www.bilibili.com", scheme="https", fragment="").geturl()
    elif detected == "youtube":
        video_id = extract_video_id(url, detected)
        if not video_id:
            raise ValueError("无法识别 YouTube 视频 ID。")
        url = f"https://www.youtube.com/watch?v={video_id}"
    elif detected == "xiaohongshu" and not is_xiaohongshu_video_url(url):
        raise ValueError("请填写小红书视频页链接或分享短链。")
    elif detected in ("douyin", "kuaishou"):
        if host in SHORT_HOSTS:
            allowed = re.fullmatch(r"/[0-9A-Za-z_-]+/?", parts.path)
        else:
            pattern = r"/(?:share/)?video/(\d+)/?" if detected == "douyin" else r"/short-video/[0-9A-Za-z_-]+/?"
            allowed = re.fullmatch(pattern, parts.path)
        if not allowed:
            raise ValueError("无法识别该平台的视频页链接或分享短链。")
        if host not in SHORT_HOSTS:
            url = f"https://www.douyin.com/video/{allowed[1]}" if detected == "douyin" else f"https://www.kuaishou.com{parts.path.rstrip('/')}"
    return url, detected


def _resolve_short_link(url: str, platform: str) -> str:
    for _ in range(4):
        if urlsplit(url).hostname not in SHORT_HOSTS:
            return url
        with requests.get(url, allow_redirects=False, stream=True, timeout=15) as response:
            if not response.is_redirect:
                break
            url, _ = normalize_download_link(urljoin(url, response.headers["Location"]), platform)
    raise ValueError("无法解析视频分享短链，请复制跳转后的完整视频链接。")


def downloaded_video_path(key: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("无效的视频编号")
    return Path(get_data_dir()) / "videos" / key / "video.mp4"


def _make_playable(source: Path, target: Path) -> float:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)],
        check=True, capture_output=True, text=True,
    )
    info = json.loads(probe.stdout)
    video = next((stream for stream in info["streams"] if stream["codec_type"] == "video"), None)
    audio = next((stream for stream in info["streams"] if stream["codec_type"] == "audio"), None)
    if video is None:
        raise ValueError("下载结果不包含视频画面。")
    copy_video = video["codec_name"] == "h264" and video.get("pix_fmt") == "yuv420p"
    video_codec = ["-c:v", "copy"] if copy_video else [
        "-c:v", "libx264", "-preset", "veryfast",
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p",
    ]
    audio_codec = "copy" if audio and audio["codec_name"] == "aac" else "aac"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
         *video_codec, "-c:a", audio_codec, "-movflags", "+faststart", str(target)],
        check=True,
    )
    return float(info["format"].get("duration") or 0)


def prepare_downloaded_video(video_url: str, platform: str | None = None) -> AudioDownloadResult:
    url, platform = normalize_download_link(video_url, platform)
    url = _resolve_short_link(url, platform)
    key = hashlib.sha256(f"{platform}:{url}".encode()).hexdigest()
    path = downloaded_video_path(key)
    directory = path.parent
    directory.parent.mkdir(parents=True, exist_ok=True)

    with _DOWNLOAD_LOCKS[int(key[:2], 16) % len(_DOWNLOAD_LOCKS)]:
        if not path.is_file():
            ensure_ffmpeg_or_raise()
            with TemporaryDirectory(dir=directory.parent, prefix=".download-") as temp:
                work = Path(temp)
                source_info: dict = {}
                downloader = SUPPORT_PLATFORM_MAP[platform]
                source = Path(downloader.download_video(url, output_dir=temp, metadata=source_info))
                ready = work / "ready"
                ready.mkdir()
                duration = _make_playable(source, ready / path.name)
                info = {
                    "title": source_info.get("title") or source.stem,
                    "duration": duration,
                    "cover_url": source_info.get("thumbnail"),
                    "video_id": str(source_info.get("id") or key),
                    "raw_info": {field: source_info[field] for field in ("description", "tags", "uploader")
                                 if source_info.get(field)},
                }
                (ready / "info.json").write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
                try:
                    ready.rename(directory)
                except OSError:
                    if not path.is_file() or not (directory / "info.json").is_file():
                        raise
        info = json.loads((directory / "info.json").read_text(encoding="utf-8"))

    return AudioDownloadResult(
        **info, file_path="", platform=platform, video_path=str(path),
        playback_url=f"/downloaded_video/{key}.mp4",
    )


def extract_downloaded_audio(video_path: str, quality: str, directory: Path, task_id: str) -> str:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{task_id}.mp3"
    if not target.is_file():
        with TemporaryDirectory(dir=directory) as temp:
            audio = Path(temp) / "audio.mp3"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-i", video_path, "-map", "0:a:0", "-vn",
                 "-c:a", "libmp3lame", "-b:a", f"{QUALITY_MAP[quality]}k", str(audio)],
                check=True,
            )
            audio.replace(target)
    return str(target)
