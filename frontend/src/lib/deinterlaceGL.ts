"use client";

/**
 * The deinterlacer menu, on the GPU.
 *
 * Analog carries no flag saying how (or whether) it is interlaced, so capture
 * software cannot choose for you -- it ships a default and offers a list.
 * This is that list. The two best entries are browser implementations of the
 * algorithms ffmpeg made standard:
 *
 *   weave     do nothing. Combs on motion, keeps every real scanline.
 *   bob       keep one field, line-double it. Never combs, halves detail.
 *   blend     average the fields. No comb, but motion ghosts.
 *   adaptive  per-pixel: still -> weave, moving -> interpolate. Our default.
 *   yadif     edge-directed spatial interpolation, clamped against the
 *             previous frame. ffmpeg's workhorse.
 *   bwdif     yadif's successor: a 6-tap cubic vertical filter instead of a
 *             2-tap average, so reconstructed lines keep more detail.
 *
 * QTGMC -- the quality ceiling -- is deliberately absent: it is motion-
 * COMPENSATED, needs several passes over a window of frames, and runs at
 * seconds per frame. It belongs to an offline transcode of a saved file, not
 * to a live panel, and claiming otherwise in a dropdown would be a lie.
 *
 * Orientation note: nothing is flipped at upload. The fragment shader
 * converts gl_FragCoord (origin bottom-left) into an image row index (origin
 * top-left) itself, because every algorithm here is about ROW PARITY and a
 * flipped upload silently swaps which field is which.
 */

export type DeintMode = "weave" | "bob" | "blend" | "adaptive" | "legacy" | "yadif" | "bwdif";

export const DEINT_MODES: Array<{ key: DeintMode; label: string; hint: string }> = [
  { key: "adaptive", label: "Motion-adaptive (default)", hint: "Still areas keep every scanline; only moving ones are rebuilt." },
  { key: "bwdif", label: "Bwdif-style (best quality)", hint: "Cubic edge-directed reconstruction — ffmpeg's current standard." },
  { key: "yadif", label: "Yadif-style", hint: "Edge-directed, clamped against the previous frame. The classic." },
  { key: "blend", label: "Blend fields", hint: "Averages both fields: no combing, but motion ghosts." },
  { key: "legacy", label: "Motion-adaptive (original)", hint: "The CPU implementation this app shipped before the GPU set — kept so the new ones can be compared against what the clinic has been seeing." },
  { key: "bob", label: "Bob (discard a field)", hint: "Cannot comb. Costs half the vertical resolution." },
  { key: "weave", label: "Off (raw signal)", hint: "No processing — shows the combing as the card sends it." },
];

// legacy never reaches a shader (see process()), but the map must be total.
const MODE_ID: Record<DeintMode, number> = { weave: 0, bob: 1, blend: 2, adaptive: 3, legacy: 3, yadif: 4, bwdif: 5 };

export interface GLDeinterlacer {
  /** Render `video` deinterlaced into this instance's canvas; returns the
   *  canvas (ready to draw from) and the time it took. */
  process(video: TexImageSource, w: number, h: number, mode: DeintMode):
    { canvas: HTMLCanvasElement; ms: number } | null;
  reset(): void;
  dispose(): void;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform int uMode;
uniform int uH;
uniform bool uHasPrev;
out vec4 fragColor;

vec3 cur(int x, int y) {
  return texelFetch(uCur, ivec2(x, clamp(y, 0, uH - 1)), 0).rgb;
}
vec3 prv(int x, int y) {
  return texelFetch(uPrev, ivec2(x, clamp(y, 0, uH - 1)), 0).rgb;
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  int x = int(gl_FragCoord.x);
  // gl_FragCoord counts from the bottom; image rows count from the top.
  int y = uH - 1 - int(gl_FragCoord.y);
  vec3 here = cur(x, y);

  // Top field first: rows 0,2,4... are the field we keep.
  bool keepRow = (y % 2) == 0;

  if (uMode == 0) { fragColor = vec4(here, 1.0); return; }            // weave

  if (uMode == 1) {                                                   // bob
    int src = keepRow ? y : y - 1;
    fragColor = vec4(cur(x, src), 1.0);
    return;
  }

  if (uMode == 2) {                                                   // blend
    fragColor = vec4((cur(x, y - 1) + 2.0 * here + cur(x, y + 1)) * 0.25, 1.0);
    return;
  }

  if (uMode == 3) {                                                   // adaptive
    // Comb energy at this pixel: a line that disagrees with BOTH its
    // neighbours while they agree with each other is a moving field edge.
    vec3 a = cur(x, y - 1), b = cur(x, y + 1);
    float combing = abs(luma(here) - luma(a)) + abs(luma(here) - luma(b))
                  - 2.0 * abs(luma(a) - luma(b));
    fragColor = vec4(combing > 0.08 ? (a + b) * 0.5 : here, 1.0);
    return;
  }

  // ---- yadif / bwdif: rebuild only the rows of the other field ----
  if (keepRow) { fragColor = vec4(here, 1.0); return; }

  vec3 a = cur(x, y - 1);     // line above  (kept field)
  vec3 b = cur(x, y + 1);     // line below  (kept field)

  // Edge-directed: try five slopes and take the one whose two samples agree
  // best, so a diagonal edge is reconstructed along the edge, not across it.
  float best = 1e9;
  vec3 spatial = (a + b) * 0.5;
  for (int d = -2; d <= 2; d++) {
    vec3 p = cur(x + d, y - 1);
    vec3 q = cur(x - d, y + 1);
    float score = abs(luma(p) - luma(q))
                + 0.5 * abs(luma(cur(x + d - 1, y - 1)) - luma(cur(x - d - 1, y + 1)))
                + 0.5 * abs(luma(cur(x + d + 1, y - 1)) - luma(cur(x - d + 1, y + 1)))
                + 0.02 * abs(float(d));          // prefer vertical when tied
    if (score < best) { best = score; spatial = (p + q) * 0.5; }
  }

  if (uMode == 5) {
    // Bwdif: a 6-tap cubic through the kept field keeps more real detail
    // than the 2-tap average, where the picture is smooth enough to trust.
    vec3 cubic = (-cur(x, y - 3) + 9.0 * a + 9.0 * b - cur(x, y + 3)) / 16.0;
    vec3 lo = min(a, b) - vec3(0.08);
    vec3 hi = max(a, b) + vec3(0.08);
    cubic = clamp(cubic, lo, hi);               // never overshoot the neighbours
    spatial = mix(spatial, cubic, 0.6);
  }

  // Temporal clamp: the rebuilt pixel may not stray outside what the same
  // position showed one frame ago and what its neighbours show now. This is
  // what stops interpolation inventing edges that were never in the signal.
  if (uHasPrev) {
    vec3 t = prv(x, y);
    vec3 lo = min(min(a, b), t);
    vec3 hi = max(max(a, b), t);
    spatial = clamp(spatial, lo, hi);
  }
  fragColor = vec4(spatial, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const mk = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[deinterlace] shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn("[deinterlace] link:", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

/** Returns null when WebGL2 is unavailable — callers fall back to the simple
 *  CPU modes, which is why those stay in the list. */
export function createGLDeinterlacer(): GLDeinterlacer | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false,
                                           preserveDrawingBuffer: true });
  if (!gl) return null;
  const prog = compile(gl, VERT, FRAG);
  if (!prog) return null;

  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const mkTex = () => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // NEAREST and CLAMP: every algorithm here addresses exact rows, and a
    // filtered sample would blend the two fields before we could separate them.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  };
  const texCur = mkTex(), texPrev = mkTex();
  let sized = { w: 0, h: 0 };
  let hasPrev = false;

  // Only yadif/bwdif's temporal clamp (FRAG's uHasPrev branch) ever reads
  // texPrev -- weave/bob/blend/adaptive's shader branches never call prv().
  // Uploading a full native-resolution frame to the GPU as "history" for a
  // mode that will never read it was pure waste, paid every single video
  // frame regardless of mode. Measured as a real, large cost on the clinic
  // PC's weak GPU once real (not static) content was used to test it.
  const NEEDS_PREV: Partial<Record<DeintMode, true>> = { yadif: true, bwdif: true };

  return {
    process(video, w, h, mode) {
      // The original CPU deinterlacer is not one of these shaders; returning
      // null hands the frame back to the caller's fallback path, which is
      // exactly that implementation. "weave" means no processing by
      // definition -- same reasoning, same fallback, instead of paying for a
      // full GPU upload-and-shader pass just to copy the pixel unchanged.
      if (!w || !h || mode === "legacy" || mode === "weave") return null;
      const t0 = performance.now();
      if (sized.w !== w || sized.h !== h) {
        canvas.width = w; canvas.height = h;
        gl.bindTexture(gl.TEXTURE_2D, texPrev);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        sized = { w, h };
        hasPrev = false;
      }
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texCur);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

      const needsPrev = !!NEEDS_PREV[mode];

      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, "uCur"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texPrev);
      gl.uniform1i(gl.getUniformLocation(prog, "uPrev"), 1);
      gl.uniform1i(gl.getUniformLocation(prog, "uMode"), MODE_ID[mode]);
      gl.uniform1i(gl.getUniformLocation(prog, "uH"), h);
      gl.uniform1i(gl.getUniformLocation(prog, "uHasPrev"), (needsPrev && hasPrev) ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // History is the SOURCE frame, not the output: the temporal clamp asks
      // "what did the signal show here last time", and feeding it our own
      // interpolation instead would make it agree with itself forever. Only
      // worth uploading at all for the one or two modes that will read it.
      if (needsPrev) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, texPrev);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        hasPrev = true;
      } else {
        hasPrev = false;
      }

      return { canvas, ms: Math.round((performance.now() - t0) * 100) / 100 };
    },
    reset() { hasPrev = false; },
    dispose() {
      gl.deleteProgram(prog);
      gl.deleteTexture(texCur);
      gl.deleteTexture(texPrev);
      gl.deleteBuffer(quad);
    },
  };
}
