import cv2, time
from backend.services import frame_gate as fg

im = cv2.imread("/home/fati/noormind/clinical-validation/data/images/61/6158f7ac3aefec2c2e49.jpg")
print("native", im.shape)


def t(fn, n=300):
    for _ in range(5):
        fn()
    s = time.perf_counter()
    for _ in range(n):
        fn()
    return (time.perf_counter() - s) / n * 1000


print("_prep            %.2f ms" % t(lambda: fg._prep(im)))
bgr, g = fg._prep(im)
for n in fg._ALL:
    f = fg._ALL[n]
    arg = bgr if n in fg.NEEDS_COLOUR else g
    mark = "  <- in KEEP" if n in fg.KEEP else ""
    print("%-10s       %.2f ms%s" % (n, t(lambda: f(arg)), mark))
print("check() KEEP=4   %.2f ms" % t(lambda: fg.check(im)))
