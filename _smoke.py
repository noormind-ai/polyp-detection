import cv2, time, json
from backend.services import frame_gate as fg
print("KEEP:", fg.KEEP)
print("cuts for:", sorted(fg.CUTS))
im = cv2.imread("/home/fati/noormind/clinical-validation/data/images/61/6158f7ac3aefec2c2e49.jpg")
print(json.dumps(fg.check(im), indent=1))
for _ in range(5): fg.check(im)
t = time.perf_counter()
for _ in range(200): fg.check(im)
print("bank cost: %.2f ms/frame" % ((time.perf_counter()-t)/200*1000))
