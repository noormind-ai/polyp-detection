/**
 * Study-level results for every detector we have evaluated on our own corpus.
 *
 * These are NOT the numbers a model reports on its own training benchmark. Every
 * row is the same evaluation: 108 colonoscopy studies from this deployment's
 * archive, scored against what the endoscopist's report said, at conf >= 0.70
 * with a study called positive at >= 3 frames. That is why a model can look
 * strong on Kvasir and unremarkable here.
 *
 * `noisy` is a separate, frame-level test on the 339 frames the review panel
 * marked noisy and never called a polyp. Their true label is "no polyp", so
 * every detection there is wrong by construction. It is kept apart from the
 * study numbers on purpose: a study needs 3 frames to be called positive, so a
 * lone spurious box costs no study -- but it does cost the operator's attention.
 *
 * Generated from the eval outputs, see documents/fov-crop-ablation.md.
 * Regenerate rather than hand-edit: the point of publishing them is that they
 * are the measured numbers, not the chosen ones.
 */

export interface CurvePoint {
  conf: number; recall: number; fpPerClean: number; alerted: number; clean: number;
}

/** Sensitivity within one slice of the positives -- by lesion size or shape. */
export interface Slice { label: string; found: number; total: number; pct: number }

/** False alarms on frames a reviewer called noisy. Every fire here is an error. */
export interface NoisyResult {
  frames: number;
  /** Panel frames arrive already tightly cropped, so the border crop is a no-op
   *  on this set and cannot be judged by it. Measured, not assumed. */
  preCropped: boolean;
  meanConf: number;
  curve: { conf: number; framesFired: number; pct: number }[];
}

export interface ModelResult {
  key: string; label: string; deployed: boolean; note: string;
  tp: number; fn: number; fp: number; tn: number;
  precision: number; recall: number; f1: number;
  specificity: number; npv: number; youden: number;
  aucMaxConf: number; aucFrames05: number; aucFrames07: number;
  studies: number; positives: number; negatives: number; frames: number;
  bySize: Slice[]; byMorphology: Slice[]; curve: CurvePoint[];
  noisy?: NoisyResult;
}

export const MODEL_RESULTS: ModelResult[] = [
  {
    "tp": 24,
    "fn": 7,
    "fp": 5,
    "tn": 72,
    "precision": 82.8,
    "recall": 77.4,
    "f1": 0.8,
    "specificity": 93.5,
    "npv": 91.1,
    "youden": 0.709,
    "aucMaxConf": 0.87,
    "aucFrames05": 0.848,
    "aucFrames07": 0.893,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 9,
        "total": 15,
        "pct": 60
      },
      {
        "label": "6-9mm",
        "found": 5,
        "total": 5,
        "pct": 100
      },
      {
        "label": ">=10mm",
        "found": 6,
        "total": 6,
        "pct": 100
      },
      {
        "label": "size not stated",
        "found": 4,
        "total": 5,
        "pct": 80
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 17,
        "total": 24,
        "pct": 71
      },
      {
        "label": "not stated",
        "found": 7,
        "total": 7,
        "pct": 100
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 100.0,
        "fpPerClean": 5.58,
        "alerted": 76,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 96.8,
        "fpPerClean": 3.86,
        "alerted": 74,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 96.8,
        "fpPerClean": 2.65,
        "alerted": 67,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 93.5,
        "fpPerClean": 1.62,
        "alerted": 58,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 93.5,
        "fpPerClean": 0.82,
        "alerted": 39,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 80.6,
        "fpPerClean": 0.29,
        "alerted": 18,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 45.2,
        "fpPerClean": 0.03,
        "alerted": 2,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 9.7,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "yolov5m-crop-320",
    "label": "YOLOv5m \u00b7 320px \u00b7 border cropped",
    "deployed": true,
    "note": "Deployed. Kvasir-SEG fine-tune, run at the resolution the browser sends, with the black border cropped off first.",
    "noisy": {
      "frames": 339,
      "preCropped": true,
      "meanConf": 0.1105,
      "curve": [
        {
          "conf": 0.3,
          "framesFired": 52,
          "pct": 15.3
        },
        {
          "conf": 0.4,
          "framesFired": 39,
          "pct": 11.5
        },
        {
          "conf": 0.5,
          "framesFired": 30,
          "pct": 8.8
        },
        {
          "conf": 0.6,
          "framesFired": 21,
          "pct": 6.2
        },
        {
          "conf": 0.7,
          "framesFired": 13,
          "pct": 3.8
        },
        {
          "conf": 0.8,
          "framesFired": 4,
          "pct": 1.2
        },
        {
          "conf": 0.9,
          "framesFired": 1,
          "pct": 0.3
        },
        {
          "conf": 0.95,
          "framesFired": 0,
          "pct": 0.0
        }
      ]
    }
  },
  {
    "tp": 18,
    "fn": 13,
    "fp": 3,
    "tn": 74,
    "precision": 85.7,
    "recall": 58.1,
    "f1": 0.692,
    "specificity": 96.1,
    "npv": 85.1,
    "youden": 0.542,
    "aucMaxConf": 0.855,
    "aucFrames05": 0.813,
    "aucFrames07": 0.85,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 6,
        "total": 15,
        "pct": 40
      },
      {
        "label": "6-9mm",
        "found": 4,
        "total": 5,
        "pct": 80
      },
      {
        "label": ">=10mm",
        "found": 5,
        "total": 6,
        "pct": 83
      },
      {
        "label": "size not stated",
        "found": 3,
        "total": 5,
        "pct": 60
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 13,
        "total": 24,
        "pct": 54
      },
      {
        "label": "not stated",
        "found": 5,
        "total": 7,
        "pct": 71
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 100.0,
        "fpPerClean": 4.45,
        "alerted": 72,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 96.8,
        "fpPerClean": 2.99,
        "alerted": 68,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 93.5,
        "fpPerClean": 2.04,
        "alerted": 61,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 87.1,
        "fpPerClean": 1.17,
        "alerted": 48,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 87.1,
        "fpPerClean": 0.73,
        "alerted": 37,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 80.6,
        "fpPerClean": 0.26,
        "alerted": 17,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 45.2,
        "fpPerClean": 0.01,
        "alerted": 1,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 9.7,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "yolov5m-320",
    "label": "YOLOv5m \u00b7 320px \u00b7 no crop",
    "deployed": false,
    "note": "The same model and resolution without the crop \u2014 13.5% of every frame is black border, and the pixel budget is spent on it.",
    "noisy": {
      "frames": 339,
      "preCropped": true,
      "meanConf": 0.1105,
      "curve": [
        {
          "conf": 0.3,
          "framesFired": 52,
          "pct": 15.3
        },
        {
          "conf": 0.4,
          "framesFired": 39,
          "pct": 11.5
        },
        {
          "conf": 0.5,
          "framesFired": 30,
          "pct": 8.8
        },
        {
          "conf": 0.6,
          "framesFired": 21,
          "pct": 6.2
        },
        {
          "conf": 0.7,
          "framesFired": 13,
          "pct": 3.8
        },
        {
          "conf": 0.8,
          "framesFired": 4,
          "pct": 1.2
        },
        {
          "conf": 0.9,
          "framesFired": 1,
          "pct": 0.3
        },
        {
          "conf": 0.95,
          "framesFired": 0,
          "pct": 0.0
        }
      ]
    }
  },
  {
    "tp": 24,
    "fn": 7,
    "fp": 5,
    "tn": 72,
    "precision": 82.8,
    "recall": 77.4,
    "f1": 0.8,
    "specificity": 93.5,
    "npv": 91.1,
    "youden": 0.709,
    "aucMaxConf": 0.862,
    "aucFrames05": 0.853,
    "aucFrames07": 0.878,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 11,
        "total": 15,
        "pct": 73
      },
      {
        "label": "6-9mm",
        "found": 3,
        "total": 5,
        "pct": 60
      },
      {
        "label": ">=10mm",
        "found": 6,
        "total": 6,
        "pct": 100
      },
      {
        "label": "size not stated",
        "found": 4,
        "total": 5,
        "pct": 80
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 18,
        "total": 24,
        "pct": 75
      },
      {
        "label": "not stated",
        "found": 6,
        "total": 7,
        "pct": 86
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 96.8,
        "fpPerClean": 5.78,
        "alerted": 76,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 96.8,
        "fpPerClean": 4.1,
        "alerted": 75,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 96.8,
        "fpPerClean": 2.78,
        "alerted": 66,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 93.5,
        "fpPerClean": 1.61,
        "alerted": 59,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 90.3,
        "fpPerClean": 0.94,
        "alerted": 44,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 80.6,
        "fpPerClean": 0.36,
        "alerted": 23,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 61.3,
        "fpPerClean": 0.06,
        "alerted": 5,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 16.1,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "yolov5m-640",
    "label": "YOLOv5m \u00b7 640px",
    "deployed": false,
    "note": "The original baseline, run at 640px. Four times the compute of 320 for the same accuracy the crop recovers.",
    "noisy": {
      "frames": 339,
      "preCropped": true,
      "meanConf": 0.1063,
      "curve": [
        {
          "conf": 0.3,
          "framesFired": 44,
          "pct": 13.0
        },
        {
          "conf": 0.4,
          "framesFired": 30,
          "pct": 8.8
        },
        {
          "conf": 0.5,
          "framesFired": 25,
          "pct": 7.4
        },
        {
          "conf": 0.6,
          "framesFired": 20,
          "pct": 5.9
        },
        {
          "conf": 0.7,
          "framesFired": 10,
          "pct": 2.9
        },
        {
          "conf": 0.8,
          "framesFired": 6,
          "pct": 1.8
        },
        {
          "conf": 0.9,
          "framesFired": 1,
          "pct": 0.3
        },
        {
          "conf": 0.95,
          "framesFired": 0,
          "pct": 0.0
        }
      ]
    }
  },
  {
    "tp": 24,
    "fn": 7,
    "fp": 7,
    "tn": 70,
    "precision": 77.4,
    "recall": 77.4,
    "f1": 0.774,
    "specificity": 90.9,
    "npv": 90.9,
    "youden": 0.683,
    "aucMaxConf": 0.912,
    "aucFrames05": 0.894,
    "aucFrames07": 0.88,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 10,
        "total": 15,
        "pct": 67
      },
      {
        "label": "6-9mm",
        "found": 4,
        "total": 5,
        "pct": 80
      },
      {
        "label": ">=10mm",
        "found": 6,
        "total": 6,
        "pct": 100
      },
      {
        "label": "size not stated",
        "found": 4,
        "total": 5,
        "pct": 80
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 18,
        "total": 24,
        "pct": 75
      },
      {
        "label": "not stated",
        "found": 6,
        "total": 7,
        "pct": 86
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 100.0,
        "fpPerClean": 5.96,
        "alerted": 76,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 100.0,
        "fpPerClean": 4.04,
        "alerted": 70,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 100.0,
        "fpPerClean": 2.78,
        "alerted": 65,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 96.8,
        "fpPerClean": 1.91,
        "alerted": 59,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 96.8,
        "fpPerClean": 1.18,
        "alerted": 52,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 90.3,
        "fpPerClean": 0.32,
        "alerted": 21,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 29.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 3.2,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "yolo11m-multi",
    "label": "YOLO11m \u00b7 6-dataset fine-tune",
    "deployed": false,
    "note": "Trained on a pooled 6-dataset corpus. Best ranking of any model tried, but it ties on recall and costs more to run.",
    "noisy": {
      "frames": 339,
      "preCropped": true,
      "meanConf": 0.0903,
      "curve": [
        {
          "conf": 0.3,
          "framesFired": 36,
          "pct": 10.6
        },
        {
          "conf": 0.4,
          "framesFired": 28,
          "pct": 8.3
        },
        {
          "conf": 0.5,
          "framesFired": 19,
          "pct": 5.6
        },
        {
          "conf": 0.6,
          "framesFired": 11,
          "pct": 3.2
        },
        {
          "conf": 0.7,
          "framesFired": 3,
          "pct": 0.9
        },
        {
          "conf": 0.8,
          "framesFired": 2,
          "pct": 0.6
        },
        {
          "conf": 0.9,
          "framesFired": 0,
          "pct": 0.0
        },
        {
          "conf": 0.95,
          "framesFired": 0,
          "pct": 0.0
        }
      ]
    }
  },
  {
    "tp": 22,
    "fn": 9,
    "fp": 11,
    "tn": 66,
    "precision": 66.7,
    "recall": 71.0,
    "f1": 0.688,
    "specificity": 85.7,
    "npv": 88.0,
    "youden": 0.567,
    "aucMaxConf": 0.846,
    "aucFrames05": 0.789,
    "aucFrames07": 0.858,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 8,
        "total": 15,
        "pct": 53
      },
      {
        "label": "6-9mm",
        "found": 4,
        "total": 5,
        "pct": 80
      },
      {
        "label": ">=10mm",
        "found": 6,
        "total": 6,
        "pct": 100
      },
      {
        "label": "size not stated",
        "found": 4,
        "total": 5,
        "pct": 80
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 16,
        "total": 24,
        "pct": 67
      },
      {
        "label": "not stated",
        "found": 6,
        "total": 7,
        "pct": 86
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 100.0,
        "fpPerClean": 7.35,
        "alerted": 74,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 96.8,
        "fpPerClean": 5.22,
        "alerted": 72,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 93.5,
        "fpPerClean": 3.65,
        "alerted": 62,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 93.5,
        "fpPerClean": 2.32,
        "alerted": 56,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 93.5,
        "fpPerClean": 1.16,
        "alerted": 41,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 80.6,
        "fpPerClean": 0.4,
        "alerted": 21,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 25.8,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 0.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "yolo11n",
    "label": "YOLO11n \u00b7 nano",
    "deployed": false,
    "note": "Nano-class model. Fast enough for anything, but it misses roughly a third of the studies."
  },
  {
    "tp": 6,
    "fn": 25,
    "fp": 0,
    "tn": 77,
    "precision": 100.0,
    "recall": 19.4,
    "f1": 0.324,
    "specificity": 100.0,
    "npv": 75.5,
    "youden": 0.194,
    "aucMaxConf": 0.882,
    "aucFrames05": 0.871,
    "aucFrames07": 0.758,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 1,
        "total": 15,
        "pct": 7
      },
      {
        "label": "6-9mm",
        "found": 2,
        "total": 5,
        "pct": 40
      },
      {
        "label": ">=10mm",
        "found": 3,
        "total": 6,
        "pct": 50
      },
      {
        "label": "size not stated",
        "found": 0,
        "total": 5,
        "pct": 0
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 6,
        "total": 24,
        "pct": 25
      },
      {
        "label": "not stated",
        "found": 0,
        "total": 7,
        "pct": 0
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 90.3,
        "fpPerClean": 1.17,
        "alerted": 46,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 90.3,
        "fpPerClean": 0.71,
        "alerted": 29,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 83.9,
        "fpPerClean": 0.36,
        "alerted": 20,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 74.2,
        "fpPerClean": 0.12,
        "alerted": 8,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 54.8,
        "fpPerClean": 0.04,
        "alerted": 3,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 22.6,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 0.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 0.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "yolo11n-320",
    "label": "YOLO11n \u00b7 nano \u00b7 320px",
    "deployed": false,
    "note": "Nano at deployment resolution. Never wrong when it fires, and almost never fires."
  },
  {
    "tp": 3,
    "fn": 28,
    "fp": 4,
    "tn": 73,
    "precision": 42.9,
    "recall": 9.7,
    "f1": 0.158,
    "specificity": 94.8,
    "npv": 72.3,
    "youden": 0.045,
    "aucMaxConf": 0.739,
    "aucFrames05": 0.756,
    "aucFrames07": 0.642,
    "studies": 108,
    "positives": 31,
    "negatives": 77,
    "frames": 7166,
    "bySize": [
      {
        "label": "<=5mm",
        "found": 1,
        "total": 15,
        "pct": 7
      },
      {
        "label": "6-9mm",
        "found": 0,
        "total": 5,
        "pct": 0
      },
      {
        "label": ">=10mm",
        "found": 1,
        "total": 6,
        "pct": 17
      },
      {
        "label": "size not stated",
        "found": 1,
        "total": 5,
        "pct": 20
      }
    ],
    "byMorphology": [
      {
        "label": "sessile",
        "found": 2,
        "total": 24,
        "pct": 8
      },
      {
        "label": "not stated",
        "found": 1,
        "total": 7,
        "pct": 14
      }
    ],
    "curve": [
      {
        "conf": 0.3,
        "recall": 100.0,
        "fpPerClean": 40.55,
        "alerted": 77,
        "clean": 77
      },
      {
        "conf": 0.4,
        "recall": 100.0,
        "fpPerClean": 19.56,
        "alerted": 77,
        "clean": 77
      },
      {
        "conf": 0.5,
        "recall": 100.0,
        "fpPerClean": 7.68,
        "alerted": 77,
        "clean": 77
      },
      {
        "conf": 0.6,
        "recall": 96.8,
        "fpPerClean": 2.14,
        "alerted": 67,
        "clean": 77
      },
      {
        "conf": 0.7,
        "recall": 48.4,
        "fpPerClean": 0.35,
        "alerted": 15,
        "clean": 77
      },
      {
        "conf": 0.8,
        "recall": 0.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      },
      {
        "conf": 0.9,
        "recall": 0.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      },
      {
        "conf": 0.95,
        "recall": 0.0,
        "fpPerClean": 0.0,
        "alerted": 0,
        "clean": 77
      }
    ],
    "key": "rtdetr-r18",
    "label": "RT-DETR-R18",
    "deployed": false,
    "note": "Transformer detector, evaluated for comparison. Not competitive on this corpus."
  }
];

export const DEFAULT_MODEL_KEY = "yolov5m-crop-320";
export const DEPLOYED = MODEL_RESULTS.find((m) => m.deployed) ?? MODEL_RESULTS[0];
