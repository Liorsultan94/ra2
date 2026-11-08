"""Thin async wrapper around pyremoteplay for controlling a PS5 on the local network.

Wake-up and status go over the PlayStation discovery protocol (UDP). Button presses
and screenshots need a Remote Play session, which is opened lazily on first use and
kept open so later commands are fast.
"""
from __future__ import annotations

import asyncio
import io
import logging

from pyremoteplay import RPDevice

try:  # Screenshots need PyAV + Pillow; everything else works without them.
    from pyremoteplay.receiver import QueueReceiver
    import PIL  # noqa: F401

    HAS_VIDEO = True
except ImportError:  # pragma: no cover - depends on optional deps
    QueueReceiver = None
    HAS_VIDEO = False

_LOGGER = logging.getLogger(__name__)

BUTTONS = [
    "UP", "DOWN", "LEFT", "RIGHT",
    "CROSS", "CIRCLE", "SQUARE", "TRIANGLE",
    "L1", "R1", "L2", "R2", "L3", "R3",
    "OPTIONS", "SHARE", "PS", "TOUCHPAD",
]


class PS5Error(RuntimeError):
    """Raised when the console cannot be reached or controlled."""


class PS5:
    def __init__(self, host: str, user: str, enable_video: bool = True):
        self.host = host
        self.user = user
        self.enable_video = enable_video and HAS_VIDEO
        self.device = RPDevice(host)
        self._receiver = None
        self._lock = asyncio.Lock()

    # ---- status / power -------------------------------------------------
    async def status(self) -> dict:
        data = await self.device.async_get_status()
        if not data:
            return {"reachable": False}
        return {
            "reachable": True,
            "on": self.device.is_on,
            "status": self.device.status_name,
            "running_app": self.device.app_name,
            "running_app_id": self.device.app_id,
            "remote_play_connected": self.device.ready,
        }

    async def wake(self) -> dict:
        await self.device.async_get_status()
        if self.device.is_on:
            return {"ok": True, "message": "already on"}
        self.device.wakeup(user=self.user)
        if not await self.device.async_wait_for_wakeup(timeout=60):
            raise PS5Error("Console did not wake up within 60 seconds")
        return {"ok": True, "message": "console is on"}

    async def standby(self) -> dict:
        async with self._lock:
            await self.device.async_get_status()
            if not self.device.is_on:
                return {"ok": True, "message": "already in standby"}
            ok = await self.device.standby(user=self.user)
            self._close_session()
            if not ok:
                raise PS5Error("Standby command failed")
            return {"ok": True, "message": "console going to standby"}

    # ---- remote play session -------------------------------------------
    async def _ensure_session(self) -> None:
        if self.device.ready:
            return
        await self.wake()
        self._close_session()
        self._receiver = QueueReceiver(max_video_frames=2, max_audio_frames=1) if self.enable_video else None
        session = self.device.create_session(
            self.user, receiver=self._receiver, resolution="720p", fps="low"
        )
        if session is None:
            raise PS5Error(
                f"Could not create a Remote Play session for user '{self.user}'. "
                "Did you register with `python -m pyremoteplay <ip> --register`?"
            )
        if not await self.device.connect():
            raise PS5Error("Remote Play connection failed")
        if not await self.device.async_wait_for_session(timeout=30):
            raise PS5Error("Remote Play session did not become ready")
        self.device.controller.start()

    def _close_session(self) -> None:
        try:
            self.device.controller.disconnect()
            self.device.disconnect()
        except Exception:  # noqa: BLE001 - best-effort cleanup
            _LOGGER.debug("session cleanup failed", exc_info=True)
        self._receiver = None

    # ---- input ----------------------------------------------------------
    async def press(self, buttons: list[str], delay_ms: int = 350, hold_ms: int = 100) -> dict:
        names = [b.upper() for b in buttons]
        bad = [b for b in names if b not in BUTTONS]
        if bad:
            raise PS5Error(f"Unknown buttons: {bad}. Valid: {BUTTONS}")
        async with self._lock:
            await self._ensure_session()
            for name in names:
                await self.device.controller.async_button(name, "tap", delay=hold_ms / 1000)
                await asyncio.sleep(delay_ms / 1000)
        return {"ok": True, "pressed": names}

    async def screenshot_jpeg(self, max_width: int = 960) -> bytes:
        if not self.enable_video:
            raise PS5Error("Screenshots need the optional 'av' and 'pillow' packages")
        async with self._lock:
            await self._ensure_session()
            for _ in range(50):  # wait up to ~5s for the first decoded frame
                frame = self._receiver.get_latest_video_frame() if self._receiver else None
                if frame is not None:
                    break
                await asyncio.sleep(0.1)
            else:
                raise PS5Error("No video frame received from the console")
        image = frame.to_image()
        if image.width > max_width:
            image = image.resize((max_width, int(image.height * max_width / image.width)))
        buf = io.BytesIO()
        image.convert("RGB").save(buf, format="JPEG", quality=80)
        return buf.getvalue()

    def close(self) -> None:
        self._close_session()
