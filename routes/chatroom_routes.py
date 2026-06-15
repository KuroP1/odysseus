"""Chat Room routes — human-only, real-time group chat over WebSocket.

No AI is involved: this is a plain people-to-people room. Messages live in
server memory only (the last ``MAX_HISTORY`` are kept) — nothing is written to
disk or the database, so a restart starts the room fresh by design.

The room is reachable over a Cloudflare Tunnel so remote participants can join
the same conversation as local users. WebSocket connections are NOT processed
by ``AuthMiddleware`` (a Starlette ``BaseHTTPMiddleware``, which only sees
http-scope requests), so a tunnelled visitor joins simply by picking a display
name — matching the "anyone with the link can chat" intent. All history is
delivered over the socket on join, so there is no auth-gated REST surface here.
"""

import json
import logging
import os
from collections import deque
from datetime import datetime, timezone

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from core.middleware import require_admin
from routes.auth_routes import SESSION_COOKIE
from src.upload_handler import is_valid_upload_id

logger = logging.getLogger(__name__)

# Whether auth is on. When false (single-user / AUTH_ENABLED=false) the room is
# open, matching the rest of the app; otherwise a valid session is required.
_AUTH_ENABLED = os.getenv("AUTH_ENABLED", "true").lower() != "false"

# Keep only the most recent messages in memory (per the no-DB requirement).
MAX_HISTORY = 100
MAX_NAME_LEN = 32
MAX_MSG_LEN = 2000


def _clean_name(raw) -> str:
    name = str(raw or "").strip().replace("\n", " ")[:MAX_NAME_LEN]
    return name or "Anonymous"


def _clean_text(raw) -> str:
    return str(raw or "").strip()[:MAX_MSG_LEN]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChatRoom:
    """Tracks connected members and the rolling message history.

    All access happens on the asyncio event loop (single-threaded), so plain
    dict/deque mutations are safe without an explicit lock; broadcasts iterate
    over a snapshot so a disconnect mid-loop can't corrupt iteration.
    """

    def __init__(self):
        self._members: dict[WebSocket, str] = {}      # ws -> display name
        self._history: deque = deque(maxlen=MAX_HISTORY)

    def online(self) -> list[str]:
        """Unique display names, in first-seen order."""
        names: list[str] = []
        for n in self._members.values():
            if n not in names:
                names.append(n)
        return names

    async def _send(self, ws: WebSocket, payload: dict) -> None:
        try:
            await ws.send_json(payload)
        except Exception:
            # Drop sends to a half-closed socket; the receive loop will clean up.
            pass

    async def broadcast(self, payload: dict) -> None:
        for ws in list(self._members.keys()):
            await self._send(ws, payload)

    async def add(self, ws: WebSocket, name: str) -> None:
        self._members[ws] = name
        # Backfill the newcomer with the recent conversation first…
        await self._send(ws, {"type": "history", "messages": list(self._history)})
        # …then tell everyone (incl. the newcomer) about the updated roster.
        await self.broadcast({
            "type": "presence", "event": "join",
            "username": name, "online": self.online(),
        })

    async def remove(self, ws: WebSocket) -> None:
        name = self._members.pop(ws, None)
        if name is not None:
            await self.broadcast({
                "type": "presence", "event": "leave",
                "username": name, "online": self.online(),
            })

    async def clear(self) -> None:
        """Drop all in-memory history and tell every client to empty its list."""
        self._history.clear()
        await self.broadcast({"type": "clear"})

    async def post(self, ws: WebSocket, text: str, image: str | None = None) -> None:
        msg = {
            "type": "message",
            "username": self._members.get(ws, "Anonymous"),
            "text": text,
            "ts": _now_iso(),
        }
        # image is an already-validated upload id (see the WS handler). The
        # client renders it as /api/upload/<id>; we never echo arbitrary URLs.
        if image:
            msg["image"] = image
        self._history.append(msg)
        await self.broadcast(msg)


def setup_chatroom_routes() -> APIRouter:
    router = APIRouter()
    room = ChatRoom()

    @router.post("/api/chatroom/clear")
    async def chatroom_clear(request: Request):
        # Admin-only. Unauthenticated tunnel visitors (no session cookie) are
        # already rejected with 401 by AuthMiddleware before reaching here;
        # require_admin then 403s any logged-in non-admin. Clearing broadcasts
        # a "clear" event so every connected client empties its message list.
        require_admin(request)
        await room.clear()
        return {"status": "cleared"}

    @router.websocket("/ws/chatroom")
    async def chatroom_ws(ws: WebSocket):
        await ws.accept()
        # Require a logged-in session. WebSockets bypass AuthMiddleware (it only
        # sees http-scope requests), so we validate the session cookie here.
        # Accept first, then send a clear error frame + close(1008) so the
        # client can show "sign in" instead of silently looping reconnects.
        if _AUTH_ENABLED:
            auth_mgr = getattr(ws.app.state, "auth_manager", None)
            token = ws.cookies.get(SESSION_COOKIE)
            if not auth_mgr or not auth_mgr.validate_token(token):
                try:
                    await ws.send_json({"type": "error", "reason": "auth"})
                    await ws.close(code=1008)
                except Exception:
                    pass
                return
        joined = False
        try:
            while True:
                # Parse manually so a single malformed frame doesn't tear down
                # the whole connection — we just skip it and keep listening.
                raw = await ws.receive_text()
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                mtype = data.get("type")
                if mtype == "join" and not joined:
                    await room.add(ws, _clean_name(data.get("username")))
                    joined = True
                elif mtype == "message" and joined:
                    text = _clean_text(data.get("text"))
                    # Optional image: accept ONLY our own upload-id format so a
                    # crafted frame can't make clients load an arbitrary URL.
                    image = data.get("image")
                    image = str(image) if image is not None else None
                    if image and not is_valid_upload_id(image):
                        image = None
                    if text or image:
                        await room.post(ws, text, image)
                # Any other frame (or a message before join) is ignored.
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.debug("chatroom ws closed on error: %s", e)
        finally:
            if joined:
                await room.remove(ws)

    return router
