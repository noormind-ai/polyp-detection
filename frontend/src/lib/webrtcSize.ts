// Picture size WebRTC mode streams at. Kept apart from LiveCameraPlayer so
// it can be tested with plain `node --test` (see frontend/tests/).

/** The size choice meaning "the source's own size, no browser resize". */
export const WEBRTC_NATIVE = 0;

/** Width to send for a `srcW`-wide source: native, or the picked width
 *  without ever upscaling (stretching a 720px source to 960 only costs
 *  upload, it adds no detail). Even, because H.264 encodes 4:2:0. */
export function webrtcSendWidth(picked: number, srcW: number): number {
  const w = picked === WEBRTC_NATIVE ? srcW : Math.min(picked, srcW);
  return Math.max(2, Math.round(w / 2) * 2);
}

/** Height matching `capW` at the source's aspect ratio, also even. */
export function webrtcSendHeight(capW: number, srcW: number, srcH: number): number {
  return Math.max(2, Math.round((srcH * capW) / srcW / 2) * 2);
}
