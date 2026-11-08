from io import StringIO
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
import yt_dlp

from app.downloaders.base import Downloader, DownloadQuality, QUALITY_MAP, YDL_RETRY_OPTS
from app.models.notes_model import AudioDownloadResult
from app.services.cookie_manager import CookieConfigManager
from app.services.proxy_config_manager import ProxyConfigManager
from app.utils.path_helper import get_data_dir
from app.utils.url_parser import XIAOHONGSHU_SHORT_URL, XIAOHONGSHU_VIDEO_URL


class XiaohongshuDownloader(Downloader):
    @staticmethod
    def _resolve_url(url: str, proxy: str | None) -> str:
        proxies = {"http": proxy, "https": proxy} if proxy else None
        for _ in range(4):
            if XIAOHONGSHU_VIDEO_URL.fullmatch(url):
                # yt-dlp 的小红书解析器要求 www 主机名。保留分享链接的访问参数。
                return urlsplit(url)._replace(scheme="https", netloc="www.xiaohongshu.com", fragment="").geturl()
            if not XIAOHONGSHU_SHORT_URL.fullmatch(url):
                break

            url = urlsplit(url)._replace(scheme="https", fragment="").geturl()
            with requests.get(url, allow_redirects=False, stream=True, timeout=15, proxies=proxies) as response:
                if not response.is_redirect:
                    break
                url = urljoin(url, response.headers["Location"])

        raise ValueError("无法解析小红书视频链接，请重新复制视频的分享链接")

    def _extract(self, video_url, output_dir, media_kind, media_options, *, download=True):
        proxy = ProxyConfigManager().get_proxy_url()
        url = self._resolve_url(video_url, proxy)
        destination = Path(output_dir or get_data_dir())
        destination.mkdir(parents=True, exist_ok=True)
        options = {
            **YDL_RETRY_OPTS,
            "allowed_extractors": ["XiaoHongShu"],
            "outtmpl": str(destination / f"xiaohongshu-%(id)s-{media_kind}.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            **media_options,
        }
        if proxy:
            options["proxy"] = proxy

        cookie = CookieConfigManager().get("xiaohongshu") or ""
        # 让 Cookie jar 按域名发送凭据，避免把 Cookie 附到短链或视频 CDN 请求上。
        cookie_file = StringIO()
        cookie_file.write("# Netscape HTTP Cookie File\n")
        for pair in cookie.split(";"):
            name, separator, value = pair.strip().partition("=")
            if separator and name and not any(char in pair for char in "\t\r\n"):
                cookie_file.write(f".xiaohongshu.com\tTRUE\t/\tTRUE\t0\t{name}\t{value}\n")
        cookie_file.seek(0)

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.cookiejar.load(cookie_file)
            try:
                info = ydl.extract_info(url, download=download)
            except yt_dlp.utils.DownloadError as exc:
                raise RuntimeError(
                    "无法下载小红书视频，请确认分享链接可播放，并检查「下载配置」中的小红书 Cookie"
                ) from exc
            return info, Path(ydl.prepare_filename(info))

    def download(
        self,
        video_url: str,
        output_dir: str | None = None,
        quality: DownloadQuality = DownloadQuality.fast,
        need_video: bool = False,
        skip_download: bool = False,
    ) -> AudioDownloadResult:
        options = {"format": "bestaudio/best"}
        if skip_download:
            options["ignore_no_formats_error"] = True
        else:
            options["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": QUALITY_MAP[quality],
            }]

        info, media_path = self._extract(video_url, output_dir, "audio", options, download=not skip_download)
        audio_path = media_path.with_suffix(".mp3")
        if not skip_download and not audio_path.is_file():
            raise FileNotFoundError(f"小红书音频文件未生成: {audio_path}")

        return AudioDownloadResult(
            file_path="" if skip_download else str(audio_path),
            title=info.get("title") or info["id"],
            duration=info.get("duration") or 0,
            cover_url=info.get("thumbnail"),
            platform="xiaohongshu",
            video_id=info["id"],
            raw_info={key: info[key] for key in ("description", "tags", "uploader") if info.get(key)},
        )

    def download_video(self, video_url: str, output_dir: str | None = None, metadata: dict | None = None) -> str:
        info, video_path = self._extract(video_url, output_dir, "video", {"format": "best[ext=mp4]/best"})
        if metadata is not None:
            metadata.update(info)
        if not video_path.is_file():
            raise FileNotFoundError(f"小红书视频文件未生成: {video_path}")
        return str(video_path)
