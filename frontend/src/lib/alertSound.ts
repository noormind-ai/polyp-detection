/** Tier 3's voice. A short two-tone chirp that then holds, synthesised on the
 *  spot -- no asset to ship, no network, and nothing to fail at the one moment
 *  it matters.
 *
 *  This is start/stop rather than a fire-and-forget beep because the alert now
 *  has to be interruptible: the rule is "sound when a box appears, for at most
 *  the operator's chosen duration", so a lesion that leaves the screen 200 ms
 *  into a 2 s alert must silence it immediately rather than keep announcing
 *  something that is no longer on the video.
 *
 *  One voice per view, each owning its own AudioContext -- the room view and
 *  the spectator view mute independently, and a shared context would mean
 *  muting one silenced both. */

// The chirp: two blips, 880 then 1245 Hz, and then 1245 held underneath.
const BLIP_HZ = [880, 1245];
const BLIP_S = 0.09;
const BLIP_GAIN = 0.18;
// The hold is quieter than the chirp that introduced it -- it is there to say
// "this is still on screen", not to keep demanding attention for the whole
// duration.
const HOLD_GAIN = 0.08;
// Every gain change is a ramp, never a step: a step on a gain node clicks, and
// a click in a procedure room reads as equipment trouble. That mattered when
// the beep only ever ended on its own; it matters more now that it can be cut
// off mid-tone.
const ATTACK_S = 0.012;
const RELEASE_S = 0.025;
const CHIRP_S = BLIP_HZ.length * BLIP_S;

export interface AlertVoice {
  /** Sound the alert, for at most `durationMs`. Restarts if already sounding. */
  start: (durationMs: number) => void;
  /** Silence it now, with a release ramp so the cut cannot click. */
  stop: () => void;
}

export function createAlertVoice(): AlertVoice {
  let ctx: AudioContext | null = null;
  // Master gain for whatever is currently sounding. Everything routes through
  // it, so one ramp on this node silences the chirp and the hold together
  // without having to know which of them is mid-flight.
  let master: GainNode | null = null;
  let voices: OscillatorNode[] = [];

  function context(): AudioContext | null {
    if (ctx) return ctx;
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  }

  /** Drop our handles and free the nodes. The oscillators have already been
   *  told when to stop; this just makes sure nothing is left connected. */
  function release(at: number) {
    const stopping = voices;
    const dying = master;
    voices = [];
    master = null;
    stopping.forEach((o) => { try { o.stop(at); } catch { /* already stopped */ } });
    if (!dying || !ctx) return;
    const ms = Math.max(0, (at - ctx.currentTime) * 1000) + 50;
    setTimeout(() => { try { dying.disconnect(); } catch { /* already gone */ } }, ms);
  }

  function silence() {
    const c = ctx;
    if (!c || !master) return;
    const now = c.currentTime;
    const g = master.gain;
    // Read the value back before cancelling: otherwise the ramp starts from the
    // last *scheduled* value rather than where the signal actually is, and that
    // jump is the click this is all trying to avoid.
    const current = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.linearRampToValueAtTime(0, now + RELEASE_S);
    release(now + RELEASE_S + 0.01);
  }

  return {
    start(durationMs: number) {
      try {
        const c = context();
        if (!c) return;
        if (c.state === "suspended") void c.resume();
        // Re-triggered while still sounding: release the old voice rather than
        // let two chirps pile up on the same output.
        if (master) silence();

        const t0 = c.currentTime;
        // Never shorter than a single blip -- below that there is no alert
        // left, just a click.
        const total = Math.max(BLIP_S, durationMs / 1000);
        const until = t0 + total;
        const bus = c.createGain();
        bus.gain.value = 1;
        bus.connect(c.destination);
        master = bus;

        BLIP_HZ.forEach((hz, i) => {
          const s = t0 + i * BLIP_S;
          // A blip that would start past the end of a very short alert is
          // simply not scheduled: better a clipped chirp than one that outlives
          // the duration the operator asked for.
          if (s >= until) return;
          const end = Math.min(s + BLIP_S, until);
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = "sine";
          osc.frequency.value = hz;
          gain.gain.setValueAtTime(0, s);
          gain.gain.linearRampToValueAtTime(BLIP_GAIN, s + ATTACK_S);
          gain.gain.linearRampToValueAtTime(0, Math.max(s + ATTACK_S, end - 0.01));
          osc.connect(gain).connect(bus);
          osc.start(s);
          osc.stop(end);
          voices.push(osc);
        });

        // The hold picks up where the chirp left off and runs to the end of the
        // duration, releasing itself. Only worth creating if there is actually
        // time left after the chirp — at the shortest settings there is not.
        const holdFrom = t0 + CHIRP_S;
        if (until > holdFrom + ATTACK_S + RELEASE_S) {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = "sine";
          osc.frequency.value = BLIP_HZ[BLIP_HZ.length - 1];
          gain.gain.setValueAtTime(0, holdFrom);
          gain.gain.linearRampToValueAtTime(HOLD_GAIN, holdFrom + ATTACK_S);
          gain.gain.setValueAtTime(HOLD_GAIN, until - RELEASE_S);
          gain.gain.linearRampToValueAtTime(0, until);
          osc.connect(gain).connect(bus);
          osc.start(holdFrom);
          osc.stop(until + 0.01);
          voices.push(osc);
        }

        // The envelopes above are scheduled on the audio clock, so the duration
        // itself is sample-accurate and does not drift with a busy main thread
        // (during live inference it always is). This timer only drops the
        // handles afterwards — and only if this is still the sound that is
        // playing, so a re-trigger in the meantime is not cut short by the
        // previous one's cleanup.
        setTimeout(() => { if (master === bus) release(c.currentTime); }, total * 1000 + 60);
      } catch { /* an alert that cannot sound must never break the live loop */ }
    },

    stop() {
      try { silence(); } catch { /* ditto */ }
    },
  };
}
