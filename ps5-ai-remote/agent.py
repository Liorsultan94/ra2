"""Claude agent that turns natural-language requests (Hebrew or English) into PS5 actions.

Anything that spends in-game currency or commits a trade goes through propose_action:
the agent describes the step and the exact buttons, and nothing is pressed until the
user taps "approve" on the phone. What gets approved is exactly what gets pressed.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid

import anthropic

from ps5 import BUTTONS, PS5, PS5Error

_LOGGER = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
MAX_STEPS = 40          # hard cap on model calls per request, bounds cost
HISTORY_IDLE_SEC = 900  # start a fresh conversation after 15 minutes of silence
HISTORY_MAX_MSGS = 80

SYSTEM_PROMPT = """You control the user's PlayStation 5 over the local network using the tools provided.
The user speaks Hebrew or English. Always answer in the user's language, briefly (one to three sentences).

How the PS5 UI works:
- PS button opens the control center. From inside a game, press PS, then use the "Home" icon, or press PS
  and CROSS on Home to leave. Pressing PS from the control center goes to the Home screen.
- Home screen: a horizontal row of recently played game tiles at the top. LEFT/RIGHT moves between tiles,
  CROSS opens the selected one. The far-right tile of the row is the Game Library (all installed games).
- CROSS = select/confirm, CIRCLE = back/cancel, OPTIONS = more options, R1/L1 = switch tabs.

How to work:
- Check status first when it matters (is the console on? which app is running?). If the requested game is
  already running, don't relaunch it.
- If the console is off and the user wants to do something, wake it first.
- Prefer a saved shortcut when one matches the request.
- When you can look at the screen, look before navigating and again after every few presses.
  Press a few buttons at a time, then verify. Games take time to load: use wait_seconds instead of pressing
  buttons while a loading screen or intro video is showing (intros can often be skipped with CROSS or OPTIONS).
- When you can't see the screen, use the status's running_app to confirm a game actually launched.
- If something fails twice, stop and tell the user what went wrong instead of looping.

Money, trades and purchases (very important):
- Never press the button that confirms a purchase, bid, buy-now, listing, sale, pack opening, or anything that
  spends or commits VC, MT, PlayStation Store money, or cards. Navigating to those screens and reading them is fine.
- For such a step, use propose_action with a clear Hebrew summary (what item, what price, buy or sell) and the
  exact buttons that would commit it, then end your turn and wait. The user approves or rejects on the phone.
- One proposal at a time. Never run repeated or automated trading loops (refresh-and-snipe, mass listing,
  auto-bidding): this breaks the game's rules and can get the user's account banned. If asked, explain that
  briefly and offer to show prices and propose single actions instead.
- Never buy anything on the PlayStation Store, change system settings, or delete data.

NBA 2K24 MyTeam:
- Launch NBA 2K24 from Home. After the intro/press-start screens, the main menu has a MyTeam option;
  inside MyTeam, the store/packs and the Auction House (market) are separate menu sections.
- Menus vary with updates, so rely on screenshots rather than memorized paths.
- When the user asks what is in the store or market, navigate there and describe what you see (items, prices,
  the user's VC/MT balance if visible). Do not buy anything without propose_action."""


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


BUTTON_LIST_SCHEMA = {"type": "array", "items": {"type": "string", "enum": BUTTONS}}


class PS5Agent:
    def __init__(self, ps5: PS5, shortcuts: dict[str, list[str]] | None = None):
        self.ps5 = ps5
        self.shortcuts = {k.lower(): v for k, v in (shortcuts or {}).items()}
        self.client = anthropic.AsyncAnthropic()  # async: a blocking call would stall the Remote Play loop
        self.messages: list = []
        self.last_activity = 0.0
        self.pending: dict | None = None        # action waiting for the user's approval
        self.last_screenshot: str | None = None  # base64 JPEG, shown on the phone
        self._lock = asyncio.Lock()
        self.tools = self._build_tools()

    def _build_tools(self) -> list[dict]:
        tools = [
            _tool("get_status", "Get whether the PS5 is on and which game/app is running.", {}, []),
            _tool("wake_console", "Turn the PS5 on from rest mode.", {}, []),
            _tool("standby_console", "Put the PS5 into rest mode. Only when the user asks to turn it off.", {}, []),
            _tool(
                "press_buttons",
                "Tap DualSense buttons in order. Never use this to confirm a purchase, bid, sale or listing: "
                "use propose_action for that.",
                {
                    "buttons": {**BUTTON_LIST_SCHEMA, "description": "Buttons to tap, in order. About 1-8 per call."},
                    "delay_ms": {
                        "type": "integer",
                        "description": "Pause between presses in ms. 350 normally, 1000+ while menus load.",
                    },
                },
                ["buttons", "delay_ms"],
            ),
            _tool(
                "wait_seconds",
                "Wait while the game or a menu loads.",
                {"seconds": {"type": "integer", "description": "1-30"}},
                ["seconds"],
            ),
            _tool(
                "propose_action",
                "Ask the user to approve a step that spends currency or commits a trade (buy, bid, sell, list, "
                "open pack). Shows the summary and current screen on the phone. After calling this, end your turn.",
                {
                    "summary": {
                        "type": "string",
                        "description": "Hebrew, for the user: what will happen, which item, what price.",
                    },
                    "buttons": {**BUTTON_LIST_SCHEMA, "description": "Exact buttons that commit the action."},
                },
                ["summary", "buttons"],
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
        tools[-1]["cache_control"] = {"type": "ephemeral"}  # cache the stable prefix (tools + system)
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
        if name == "wait_seconds":
            await asyncio.sleep(min(30, max(1, args["seconds"])))
            return "done"
        if name == "run_shortcut":
            seq = self.shortcuts[args["name"]]
            await self.ps5.wake()
            return json.dumps(await self.ps5.press(seq, delay_ms=600))
        if name == "propose_action":
            if self.ps5.enable_video:
                try:
                    self.last_screenshot = base64.b64encode(await self.ps5.screenshot_jpeg()).decode()
                except PS5Error:
                    pass
            self.pending = {
                "id": uuid.uuid4().hex[:8],
                "summary": args["summary"],
                "buttons": [b.upper() for b in args["buttons"]],
                "screenshot": self.last_screenshot,
            }
            return "Shown to the user. Nothing was pressed. End your turn now and wait for their answer."
        if name == "look_at_screen":
            data = base64.b64encode(await self.ps5.screenshot_jpeg()).decode()
            self.last_screenshot = data
            return [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                {"type": "text", "text": "Current PS5 screen."},
            ]
        raise PS5Error(f"Unknown tool {name}")

    def reset(self) -> None:
        self.messages = []
        self.pending = None

    # ---- approval flow ---------------------------------------------------
    async def approve(self, pending_id: str) -> dict:
        pending = self._take_pending(pending_id)
        try:
            await self.ps5.press(pending["buttons"], delay_ms=600)
        except PS5Error as exc:
            return await self.handle(f"[המשתמש אישר את \"{pending['summary']}\", אבל הלחיצה נכשלה: {exc}]")
        return await self.handle(
            f"[המשתמש אישר: \"{pending['summary']}\". הכפתורים {' '.join(pending['buttons'])} נלחצו. "
            "תבדוק במסך מה קרה ותדווח בקצרה.]"
        )

    async def reject(self, pending_id: str) -> dict:
        pending = self._take_pending(pending_id)
        return await self.handle(f"[המשתמש דחה: \"{pending['summary']}\". לא נלחץ כלום. אל תציע את זה שוב.]")

    def _take_pending(self, pending_id: str) -> dict:
        if not self.pending or self.pending["id"] != pending_id:
            raise PS5Error("This approval is no longer valid")
        pending, self.pending = self.pending, None
        return pending

    # ---- main loop -----------------------------------------------------------
    async def handle(self, text: str) -> dict:
        async with self._lock:
            return await self._handle(text)

    async def _handle(self, text: str) -> dict:
        now = time.time()
        if now - self.last_activity > HISTORY_IDLE_SEC or len(self.messages) > HISTORY_MAX_MSGS:
            self.messages = []  # start a new conversation; never edit an existing one in place
            self.pending = None
        self.last_activity = now
        self.last_screenshot = None

        self.messages.append({"role": "user", "content": text})
        actions: list[dict] = []

        def result(reply: str) -> dict:
            pending = None
            if self.pending:
                pending = {k: self.pending[k] for k in ("id", "summary", "buttons")}
            return {"reply": reply, "actions": actions, "pending": pending, "screenshot": self.last_screenshot}

        for _ in range(MAX_STEPS):
            response = await self.client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                output_config={"effort": "low"},  # menu navigation: favour speed
                system=SYSTEM_PROMPT,
                tools=self.tools,
                messages=self.messages,
            )
            # Append the full content (thinking blocks included) so the conversation stays valid.
            self.messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "refusal":
                return result("הבקשה נדחתה.")
            if response.stop_reason == "pause_turn":
                continue
            if response.stop_reason != "tool_use":
                reply = "".join(b.text for b in response.content if b.type == "text").strip()
                return result(reply or "בוצע.")

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
        self.pending = None
        return result("עצרתי אחרי יותר מדי צעדים. נסה לנסח את הבקשה אחרת.")
