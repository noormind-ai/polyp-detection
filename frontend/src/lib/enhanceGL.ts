"use client";

/**
 * The enhancement chain on the GPU.
 *
 * The first implementation did denoise and unsharp as per-pixel JavaScript
 * over ImageData. It worked and it was measurably too slow: 720x480 is
 * 345,600 pixels, the unsharp pass alone is nine taps on three channels
 * (~9M operations a frame), and with getImageData/putImageData on top it
 * cost tens of milliseconds inside the frame callback -- which is a visible
 * lag, because the paint loop waits for it.
 *
 * Here the same two passes are fragment shaders: pass 1 denoises into a
 * framebuffer, pass 2 unsharps that result onto the visible canvas. Order
 * matters -- sharpening first would amplify exactly the noise the denoiser
 * is about to average away. Two passes rather than one because the unsharp
 * blur taps must read the DENOISED neighbours, which only exist once pass 1
 * has run.
 *
 * Falls back to the CPU implementation (lib/enhance.ts) when WebGL2 is
 * unavailable; the caller decides, since the two need different contexts on
 * the target canvas.
 */

export interface GLEnhanceParams { denoise: number; sharpen: number }

export interface GLEnhancer {
  /** Draw `src` enhanced onto the canvas this was created with. Returns the
   *  GPU-side wall time in ms (one number: the passes are not separable
   *  without a pipeline stall, and the total is what the operator feels). */
  process(src: TexImageSource, w: number, h: number, params: GLEnhanceParams): number;
  reset(): void;
  dispose(): void;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Motion-gated temporal average. Still pixels converge on the mean of the
// last few frames (noise cancels); moving pixels pass through untouched, so
// detail in motion is never smeared.
const FRAG_DENOISE = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform float uK;        // 0 = no history, 0.75 = ~4-frame memory
uniform float uGate;     // luma delta (0..1) above which a pixel is "moving"
uniform bool uHasPrev;
out vec4 fragColor;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 cur = texture(uSrc, vUV).rgb;
  if (!uHasPrev || uK <= 0.0) { fragColor = vec4(cur, 1.0); return; }
  vec3 prev = texture(uPrev, vUV).rgb;
  float moving = step(uGate, abs(luma(cur) - luma(prev)));
  fragColor = vec4(mix(mix(cur, prev, uK), cur, moving), 1.0);
}`;

// Unsharp mask: subtract a 3x3 box blur, add the difference back.
const FRAG_SHARPEN = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uAmount;
out vec4 fragColor;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  if (uAmount <= 0.0) { fragColor = vec4(c, 1.0); return; }
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += texture(uTex, vUV + vec2(float(x), float(y)) * uTexel).rgb;
    }
  }
  vec3 blur = sum / 9.0;
  fragColor = vec4(clamp(c + uAmount * (c - blur), 0.0, 1.0), 1.0);
}`;

const MOTION_GATE = 22 / 255;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) ?? "program link failed");
  }
  return p;
}

function makeTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

/** Returns null when WebGL2 isn't available — the caller falls back to CPU. */
export function createGLEnhancer(canvas: HTMLCanvasElement): GLEnhancer | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false,
                                           preserveDrawingBuffer: true });
  if (!gl) return null;

  let progDenoise: WebGLProgram, progSharpen: WebGLProgram;
  try {
    progDenoise = compile(gl, VERT, FRAG_DENOISE);
    progSharpen = compile(gl, VERT, FRAG_SHARPEN);
  } catch {
    return null;
  }

  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  for (const p of [progDenoise, progSharpen]) {
    const loc = gl.getAttribLocation(p, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  const texSrc = makeTexture(gl);
  const texPrev = makeTexture(gl);     // last denoised output (temporal history)
  const texMid = makeTexture(gl);      // denoise output, sharpen input
  const fbo = gl.createFramebuffer()!;
  let sized = { w: 0, h: 0 };
  let hasPrev = false;

  function resize(w: number, h: number) {
    if (sized.w === w && sized.h === h) return;
    canvas.width = w;
    canvas.height = h;
    for (const t of [texPrev, texMid]) {
      gl!.bindTexture(gl!.TEXTURE_2D, t);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    }
    sized = { w, h };
    hasPrev = false;    // history measured against a different geometry is noise
  }

  function process(src: TexImageSource, w: number, h: number, params: GLEnhanceParams): number {
    if (!w || !h) return 0;
    const t0 = performance.now();
    resize(w, h);
    gl!.viewport(0, 0, w, h);

    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, texSrc);
    // A canvas has its origin top-left, a GL texture bottom-left. Upload
    // without this and every pass is correct while the picture is upside
    // down -- which is exactly how it shipped the first time. Flipping at
    // upload keeps one orientation for the whole pipeline, including the
    // framebuffer copy that carries temporal history.
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, src);
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);

    // ---- pass 1: denoise into texMid ----
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, texMid, 0);
    gl!.useProgram(progDenoise);
    gl!.uniform1i(gl!.getUniformLocation(progDenoise, "uSrc"), 0);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, texPrev);
    gl!.uniform1i(gl!.getUniformLocation(progDenoise, "uPrev"), 1);
    gl!.uniform1f(gl!.getUniformLocation(progDenoise, "uK"), 0.75 * Math.max(0, Math.min(1, params.denoise)));
    gl!.uniform1f(gl!.getUniformLocation(progDenoise, "uGate"), MOTION_GATE);
    gl!.uniform1i(gl!.getUniformLocation(progDenoise, "uHasPrev"), hasPrev ? 1 : 0);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    // History for the next frame is the denoised result, not the raw input:
    // recursive averaging converges on the true signal faster.
    gl!.bindTexture(gl!.TEXTURE_2D, texPrev);
    gl!.copyTexImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, 0, 0, w, h, 0);
    hasPrev = true;

    // ---- pass 2: unsharp texMid onto the canvas ----
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.useProgram(progSharpen);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, texMid);
    gl!.uniform1i(gl!.getUniformLocation(progSharpen, "uTex"), 0);
    gl!.uniform2f(gl!.getUniformLocation(progSharpen, "uTexel"), 1 / w, 1 / h);
    gl!.uniform1f(gl!.getUniformLocation(progSharpen, "uAmount"), 0.8 * Math.max(0, Math.min(1, params.sharpen)));
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    return Math.round((performance.now() - t0) * 100) / 100;
  }

  return {
    process,
    reset() { hasPrev = false; },
    dispose() {
      gl.deleteProgram(progDenoise);
      gl.deleteProgram(progSharpen);
      [texSrc, texPrev, texMid].forEach((t) => gl.deleteTexture(t));
      gl.deleteFramebuffer(fbo);
      gl.deleteBuffer(quad);
    },
  };
}
