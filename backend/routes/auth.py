"""Login / registration routes, and the dependency that gates GPU uploads.

Only the upload paths are gated — see backend/auth.py for why live camera,
screen share and the bundled demos are deliberately open.
"""

import logging

from fastapi import APIRouter, Cookie, Depends, Form, HTTPException, Request
from fastapi.responses import JSONResponse

from backend import auth

log = logging.getLogger("auth")

router = APIRouter()


def current_user(polyp_session: str = Cookie(default="")) -> str | None:
    return auth.read_session(polyp_session) if polyp_session else None


def require_user(user: str | None = Depends(current_user)) -> str:
    """Gate for anything that spends GPU on a user-supplied video."""
    if not user:
        raise HTTPException(
            status_code=401,
            detail="برای بارگذاری ویدیو باید وارد شوید. Sign in to upload a video.",
        )
    return user


def _session_response(username: str, request: Request) -> JSONResponse:
    resp = JSONResponse({"ok": True, "user": username})
    resp.set_cookie(
        auth.COOKIE_NAME,
        auth.issue_session(username),
        max_age=auth.SESSION_HOURS * 3600,
        httponly=True,                     # JS cannot read it -> XSS can't steal it
        samesite="lax",                    # not sent on cross-site POSTs
        # Behind nginx the app itself sees http, so trust the proxy's header —
        # without this the cookie is issued without Secure on the real https site.
        secure=request.headers.get("x-forwarded-proto", request.url.scheme) == "https",
        path="/",
    )
    return resp


@router.post("/login")
def do_login(request: Request, username: str = Form(...), password: str = Form(...)):
    if not auth.check_login(username.strip(), password):
        # One message for both wrong-user and wrong-password: saying which was
        # wrong tells an attacker which usernames exist.
        raise HTTPException(status_code=401,
                            detail="نام کاربری یا رمز عبور نادرست است. Incorrect username or password.")
    return _session_response(username.strip(), request)


@router.post("/register")
def do_register(request: Request, username: str = Form(...), password: str = Form(...),
                invite: str = Form(default="")):
    try:
        auth.register_user(username, password, invite)
    except auth.RegisterError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Sign the new account straight in — making someone register and then
    # immediately type the same credentials again is pointless friction.
    return _session_response(username.strip(), request)


@router.post("/logout")
def do_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME, path="/")
    return resp


@router.get("/me")
def whoami(user: str | None = Depends(current_user)):
    """Who is signed in, and what the login form needs to render."""
    return {
        "user": user,
        "registration_open": auth.REGISTRATION_OPEN,
        "invite_required": bool(auth.INVITE_CODE),
    }
