"""Monthly spending cap for Claude API calls, tracked in a small JSON file next to the app.

Costs are estimated from each response's token usage at Claude Opus 5.5 list prices.
This is a safety net, not a bill: the authoritative numbers are in console.anthropic.com.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path

# USD per million tokens (Claude Opus 5.5).
PRICE_INPUT = 4.00
PRICE_OUTPUT = 20.00
PRICE_CACHE_WRITE = 5.00   # 5-minute cache writes: 1.25x input
PRICE_CACHE_READ = 0.20


class Budget:
    def __init__(self, path: Path, monthly_limit_usd: float):
        self.path = path
        self.limit = float(monthly_limit_usd)
        self._lock = threading.Lock()

    @staticmethod
    def _month() -> str:
        return datetime.now().strftime("%Y-%m")

    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def spent(self) -> float:
        return float(self._load().get(self._month(), 0.0))

    def exceeded(self) -> bool:
        return self.limit > 0 and self.spent() >= self.limit

    @staticmethod
    def cost(usage) -> float:
        def n(name: str) -> int:
            return int(getattr(usage, name, 0) or 0)

        return (
            n("input_tokens") * PRICE_INPUT
            + n("output_tokens") * PRICE_OUTPUT
            + n("cache_creation_input_tokens") * PRICE_CACHE_WRITE
            + n("cache_read_input_tokens") * PRICE_CACHE_READ
        ) / 1_000_000

    def record(self, usage) -> float:
        amount = self.cost(usage)
        with self._lock:
            data = self._load()
            month = self._month()
            data[month] = round(float(data.get(month, 0.0)) + amount, 6)
            self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return amount
