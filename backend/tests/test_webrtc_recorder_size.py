"""The server recording is sized to what the browser says it sends, not to
the first frame, which Chrome sends smaller while a connection ramps up."""
from backend.services.webrtc_recorder import recording_size


def test_declared_size_wins_over_a_smaller_first_frame():
    # 960x540 sent; Chrome's first frames arrive at 640x360.
    assert recording_size((960, 540), 640, 360) == (960, 540)


def test_no_declared_size_falls_back_to_the_first_frame():
    assert recording_size(None, 640, 360) == (640, 360)
    assert recording_size((None, None), 640, 360) == (640, 360)


def test_junk_or_absurd_sizes_are_ignored():
    assert recording_size(("x", 540), 640, 360) == (640, 360)
    assert recording_size((0, 540), 640, 360) == (640, 360)
    assert recording_size((100000, 540), 640, 360) == (640, 360)


def test_sizes_are_even_for_h264():
    assert recording_size((721, 577), 640, 360) == (720, 576)
    assert recording_size(None, 641, 361) == (640, 360)
