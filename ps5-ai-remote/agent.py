"""Claude agent that turns natural-language requests (Hebrew or English) into PS5 actions."""
from __future__ import annotations

import base64
import json
import logging
import time

import anthropic

from ps5 import BUTTONS, PS5, PS5Error

_LOGGER = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
MAX_STEPS = 30          # hard cap on tool calls per request, bounds cost
HISTORY_IDLE_SEC = 600  # start a fresh conversation after 10 minutes of silence
HISTORY_MAX_MSGS = 60

SYSTEM_PROMPT = """You control the user's PlayStation 5 over the local network using the tools provided.
The user speaks Hebrew or English. Always answer in the user's language, in one or two short sentences.

How the PS5 UI works:
- PS button: opens the control center; pressing PS twice quickly or holding returns to the Home screen.
  From inside a game, a single PS press shows the control center at the bottom; press CROSS on "Home" to leave.
- Home screen: a horizontal row of recently played game tiles at the top. LEFT/RIGHT moves between tiles,
  CROSS opens the selected one. The far-right tile of the row is the Game Library (all installed games).
- CROSS = select/confirm, CIRCLE = back/cancel, OPTIONS = more options for the focused item.

How to work:
- Check status first when it matters (is the console on? which app is running?). If the requested game is
  already running, say so instead of pressing buttons.
- If the console is off and the user wants to play, wake it first.
- Prefer a saved shortcut when one matches the request.
- When you can look at the screen, look before navigating and again after a few presses to confirm where you are.
  Press a few buttons at a time, then verify; don't fire long blind sequences.
- When you can't see the screen, use the status's running_app to confirm a game actually launched.
- Never buy anything, accept purchases or subscriptions, delete data, or change system settings.
  If the user asks for that, explain you won't do it from here.
- If something fails twice, stop and tell the user what went wrong instead of looping."""


def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


class PS5Agent:
    def __init__(self, ps5: PS5, shortcuts: dict[str, list[str]] | None = None):
        self.ps5 = ps5
        self.shortcuts = {k.lower(): v for k, v in (shortcuts or {}).items()}
        self.client = anthropic.AsyncAnthropic()  # async: a blocking call would stall the Remote Play loop
        self.messages: list = []
        self.last_activity = 0.0
        self.tools = self._build_tools()

    def _build_tools(self) -> list[dict]:
        tools = [
            _tool("get_status", "Get whether the PS5 is on and which game/app is running.", {}, []),
            _tool("wake_console", "Turn the PS5 on from rest mode.", {}, []),
            _tool("standby_console", "Put the PS5 into rest mode. Only when the user asks to turn it off.", {}, []),
            _tool(
                "press_buttons",
                "Press DualSense buttons in order, like tapping them on the controller.",
                {
                    "buttons": {
                        "type": "array",
                        "items": {"type": "string", "enum": BUTTONS},
                        "description": "Buttons to tap, in order. Keep it to about 1-8 presses per call.",
                    },
                    "delay_ms": {
                        "type": "integer",
                        "description": "Pause between presses in ms. Use 350 normally, 1000+ while menus load.",
                    },
                },
                ["buttons", "delay_ms"],
            ),
        ]
        if self.ps5.enable_video:
            tools.append(_tool("look_at_screen", "Take a screenshot of what the PS5 is showing right now.", {}, []))
        if self.shortcuts:
            tools.append(
                _tool(
                    "run_shortcut",
                    "Run a saved button sequence the user configured. Available: " + ", ".join(sorted(self.shortcuts)),
                    {"name": {"type": "string", "enum": sorted(self.shortcuts)}},
                    ["name"],
                )
            )
        # Cache the stable prefix (tools + system) across requests.
        tools[-1]["cache_control"] = {"type": "ephemeral"}
        return tools

    async def _run_tool(self, name: str, args: dict):
        """Return tool_result content: a string, or a list of content blocks for images."""
        if name == "get_status":
            return json.dumps(await self.ps5.status())
        if name == "wake_console":
            return json.dumps(await self.ps5.wake())
        if name == "standby_console":
            return json.dumps(await self.ps5.standby())
        if name == "press_buttons":
            return json.dumps(await self.ps5.press(args["buttons"], delay_ms=max(100, args["delay_ms"])))
        if name == "run_shortcut":
            seq = self.shortcuts[args["name"]]
            await self.ps5.wake()
            return json.dumps(await self.ps5.press(seq, delay_ms=600))
        if name == "look_at_screen":
            jpeg = await self.ps5.screenshot_jpeg()
            return [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(jpeg).decode()},
                },
                {"type": "text", "text": "Current PS5 screen."},
            ]
        raise PS5Error(f"Unknown tool {name}")

    def reset(self) -> None:
        self.messages = []

    async def handle(self, text: str) -> dict:
        """Run one user request to completion. Returns the reply and a log of actions taken."""
        now = time.time()
        if now - self.last_activity > HISTORY_IDLE_SEC or len(self.messages) > HISTORY_MAX_MSGS:
            self.messages = []  # start a new conversation; never edit an existing one in place
        self.last_activity = now

        self.messages.append({"role": "user", "content": text})
        actions: list[dict] = []

        for _ in range(MAX_STEPS):
            response = await self.client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                output_config={"effort": "low"},  # simple control task: favour speed
                system=SYSTEM_PROMPT,
                tools=self.tools,
                messages=self.messages,
            )
            # Append the full content (thinking blocks included) so the conversation stays valid.
            self.messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "refusal":
                return {"reply": "הבקשה נדחתה.", "actions": actions}
            if response.stop_reason == "pause_turn":
                continue
            if response.stop_reason != "tool_use":
                reply = "".join(b.text for b in response.content if b.type == "text").strip()
                return {"reply": reply or "בוצע.", "actions": actions}

            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                entry = {"tool": block.name, "input": block.input}
                try:
                    content = await self._run_tool(block.name, block.input)
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": content})
                    entry["ok"] = True
                except Exception as exc:  # noqa: BLE001 - report every failure back to the model
                    _LOGGER.exception("tool %s failed", block.name)
                    results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": str(exc), "is_error": True}
                    )
                    entry.update(ok=False, error=str(exc))
                actions.append(entry)
            self.messages.append({"role": "user", "content": results})

        self.messages = []  # a capped, half-finished run is not worth continuing
        return {"reply": "עצרתי אחרי יותר מדי צעדים. נסה לנסח את הבקשה אחרת.", "actions": actions}
