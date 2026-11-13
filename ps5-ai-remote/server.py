"""Web server: serves the phone UI and forwards requests to the PS5 agent.

Run on a computer that is on the same home network as the PS5:
    python server.py
then open http://<computer-ip>:8000 on your phone.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import secrets
import sys
from pathlib import Path

import uvicorn
import yaml
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from agent import PS5Agent
from budget import Budget
from ps5 import PS5, PS5Error

HERE = Path(__file__).resolve().parent
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def load_config() -> dict:
    path = Path(os.environ.get("PS5_CONFIG", HERE / "config.yaml"))
    if not path.exists():
        raise SystemExit(f"Missing {path}. Copy config.example.yaml to config.yaml and fill it in.")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


config = load_config()
ps5 = PS5(config["ps5_host"], config["psn_user"], enable_video=config.get("screenshots", True))
budget = Budget(HERE / "usage.json", config.get("monthly_budget_usd", 15))
agent = PS5Agent(ps5, budget, shortcuts=config.get("shortcuts") or {})
ACCESS_TOKEN = str(config.get("access_token") or "")

app = FastAPI(title="PS5 AI Remote")


def check_token(x_token: str = Header(default=""), token: str = Query(default="")) -> None:
    if ACCESS_TOKEN and not secrets.compare_digest(x_token or token, ACCESS_TOKEN):
        raise HTTPException(status_code=401, detail="bad token")


class Command(BaseModel):
    text: str


class Press(BaseModel):
    buttons: list[str]


@app.get("/")
def index() -> FileResponse:
    return FileResponse(HERE / "static" / "index.html")


@app.post("/api/command", dependencies=[Depends(check_token)])
async def command(cmd: Command) -> dict:
    text = cmd.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty command")
    return await agent.handle(text)


class Decision(BaseModel):
    id: str


@app.post("/api/approve", dependencies=[Depends(check_token)])
async def approve(d: Decision) -> dict:
    try:
        return await agent.approve(d.id)
    except PS5Error as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/reject", dependencies=[Depends(check_token)])
async def reject(d: Decision) -> dict:
    try:
        return await agent.reject(d.id)
    except PS5Error as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/press", dependencies=[Depends(check_token)])
async def press(req: Press) -> dict:
    """Direct button presses from the on-screen remote, no AI involved."""
    try:
        return await ps5.press(req.buttons)
    except PS5Error as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/status", dependencies=[Depends(check_token)])
async def status() -> dict:
    return {**await ps5.status(), "spent_usd": round(budget.spent(), 2), "budget_usd": budget.limit}


@app.post("/api/reset", dependencies=[Depends(check_token)])
async def reset() -> dict:
    agent.reset()
    return {"ok": True}


@app.on_event("shutdown")
def shutdown() -> None:
    ps5.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0", help="use 127.0.0.1 when serving through `tailscale serve`")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cert", help="TLS certificate (enables HTTPS, needed for the browser microphone)")
    parser.add_argument("--key", help="TLS private key")
    args = parser.parse_args()
    server = uvicorn.Server(
        uvicorn.Config(app, host=args.host, port=args.port, ssl_certfile=args.cert, ssl_keyfile=args.key)
    )
    # Remote Play's UDP sockets need the selector loop on Windows (the default Proactor loop breaks them).
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    with asyncio.Runner(loop_factory=loop_factory) as runner:
        runner.run(server.serve())
