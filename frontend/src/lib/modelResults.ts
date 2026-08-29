/**
 * Study-level results for every detector we have evaluated on our own corpus.
 *
 * These are NOT the numbers a model reports on its own training benchmark.
 * Every row here is the same evaluation: 108 colonoscopy studies from this
 * deployment's archive, scored against what the endoscopist's report said, at
 * conf >= 0.70 with a study called positive at >= 3 frames. That is why a model
 * can look strong on Kvasir and unremarkable here.
 *
 * Generated from the eval outputs described in documents/fov-crop-ablation.md.
 * Regenerate rather than hand-edit: the point of publishing them is that they
 * are the measured numbers, not the chosen ones.
 */

export interface CurvePoint {
  conf: number;
  recall: number;        // % of report-positive studies caught
  fpPerClean: number;    // false-positive frames per clean procedure
  alerted: number;       // clean studies that raised at least one alert
  clean: number;
}

export interface ModelResult {
  key: string;
  label: string;
  deployed: boolean;
  note: string;
  tp: number; fn: number; fp: number; tn: number;
  precision: number; recall: number; f1: number;
  specificity: number; npv: number; youden: number;
  aucMaxConf: number;   // threshold-free: the honest way to compare two models
  aucFrames07: number;
  studies: number; positives: number; frames: number;
  curve: CurvePoint[];
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
    "aucFrames07": 0.893,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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
    "note": "Deployed. Kvasir-SEG fine-tune, run at the resolution the browser sends, with the black border cropped off first."
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
    "aucFrames07": 0.85,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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
    "note": "The same model and resolution without the crop \u2014 13.5% of every frame is black border, and the pixel budget is spent on it."
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
    "aucFrames07": 0.878,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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
    "note": "The original baseline, run at 640px. Four times the compute of 320 for the same accuracy the crop recovers."
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
    "aucFrames07": 0.88,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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
    "note": "Trained on a pooled 6-dataset corpus. Best ranking of any model tried, but it ties on recall and costs more to run."
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
    "aucFrames07": 0.858,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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
    "aucFrames07": 0.758,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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
    "aucFrames07": 0.642,
    "studies": 108,
    "positives": 31,
    "frames": 7166,
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

/** Shown first, and the one the product actually runs. */
export const DEFAULT_MODEL_KEY = "yolov5m-crop-320";
