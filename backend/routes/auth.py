"""Login / registration routes, and the dependency that gates video uploads.

Only the upload paths are gated — see backend/auth.py for why live camera,
screen share and the bundled demos are deliberately open.

This is the whole site's ONE sign-in endpoint. It answers for both kinds of
account — the ones made by the signup form here, and the ones a review-panel
admin issued — so the browser needs a single form no matter who is typing into
it. What differs afterwards is access, not the way in: `review` in the reply
says whether this person may also open /review, and the panel re-decides that
for itself on every single request regardless of what is said here.
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
    role = auth.panel_role(username)
    resp = JSONResponse({"ok": True, "user": username,
                         # Display only, and the browser's cue to go and mint a
                         # panel session too. None for a signup account.
                         "review": role})
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
    username = username.strip()
    status = auth.login_status(username, password)

    if status == auth.MUST_CHANGE_PW:
        # Right password, no session. This is a reviewer still holding the
        # one-time password an admin read out to them, and the answer they need
        # is "now choose your own", not "that was wrong" — which is what this
        # endpoint used to say, leaving them unable to sign in here at all
        # while the very same password worked at /review. 200, because the
        # credentials WERE accepted; the browser sends them to the
        # change-password step and back here afterwards.
        return JSONResponse({
            "ok": False,
            "user": username,
            "action": "change_password",
            "detail": "این حساب با رمز عبور یک‌بارمصرف ساخته شده است. پیش از ادامه، رمز عبور خود را تعیین کنید. "
                      "This account uses a one-time password. Choose your own to continue.",
        })

    if status != auth.OK:
        # One message for both wrong-user and wrong-password: saying which was
        # wrong tells an attacker which usernames exist.
        raise HTTPException(status_code=401,
                            detail="نام کاربری یا رمز عبور نادرست است. Incorrect username or password.")
    return _session_response(username, request)


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


# The video guides, and who may be told they exist.
#
# Server-side because the offline one walks through the clinical review panel,
# which an ordinary account cannot reach. Filtering it in the browser hid the
# card but still shipped the CDN URL inside the page bundle, where anyone could
# read it out and watch the video anyway. The list a client receives is now the
# list it is entitled to.
#
# This is not a secret-grade control -- the files sit on a public CDN and a
# reviewer who has loaded one can pass the link on. It stops the URL being
# discoverable by every account that signs up, which is what was actually wrong.
TUTORIALS = [
    {
        "url": "https://cdn.noormind.me/online-feedback.mp4",
        "title": "Online — feedback during a live session",
        "blurb": "Capturing a frame while the procedure is running: what the AI"
                 " files on its own, and how to flag something it missed.",
    },
    {
        "url": "https://cdn.noormind.me/offline-feedback-tutorial.mp4",
        "title": "Offline — reviewing what was captured",
        "blurb": "Working through the review queue afterwards: confirming or"
                 " rejecting each capture.",
        "reviewer_only": True,
    },
]


@router.get("/tutorials")
def tutorials(user: str | None = Depends(current_user)):
    """The guides this caller may see. Signed out gets nothing at all."""
    if not user:
        return {"tutorials": []}
    reviewer = auth.is_panel_user(user)
    return {"tutorials": [
        {k: v for k, v in t.items() if k != "reviewer_only"}
        for t in TUTORIALS if reviewer or not t.get("reviewer_only")]}


@router.get("/me")
def whoami(user: str | None = Depends(current_user)):
    """Who is signed in, and what the login form needs to render."""
    return {
        "user": user,
        "registration_open": auth.REGISTRATION_OPEN,
        "invite_required": bool(auth.INVITE_CODE),
        # Whether to offer the clinical review panel, and in what capacity.
        # Display only -- the panel authorises against its own users table
        # regardless of what we say here, so an account made by the signup form
        # gains nothing by lying about this.
        "reviewer": auth.is_panel_user(user) if user else False,
        "review_role": auth.panel_role(user) if user else None,
    }
