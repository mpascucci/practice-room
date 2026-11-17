// Pitch shifter AudioWorklet (no dependencies): changes the pitch without changing the speed.
// Method: a delay line read by two taps half a window apart. The delay of each tap slides linearly, which reads
// the audio faster or slower than it is written (= pitch ratio), and a Hann window fades each tap out as its
// delay wraps around, so the two taps always sum to unit gain. Window ~60 ms: fine for practice use, with the
// usual granular "chorus" colour on sustained notes at large shifts. At ratio 1 the signal passes through
// untouched (after a 10 ms crossfade), so transpose 0 sounds exactly like the plain player.

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.W = Math.round(sampleRate * 0.06);                      // window (max delay) in samples
    this.N = 1 << Math.ceil(Math.log2(this.W + 8));              // delay line length, a power of two
    this.mask = this.N - 1;
    this.bufs = [new Float32Array(this.N), new Float32Array(this.N)];
    this.w = 0;                                                  // write index
    this.phase = 0;                                              // 0..1, position of tap 1 in the window
    this.mix = 0;                                                // 0 = dry (bypass) .. 1 = shifted
    this.mixStep = 1 / (0.01 * sampleRate);
  }

  read(buf, pos) {
    const i = Math.floor(pos), f = pos - i, m = this.mask;
    return buf[i & m] * (1 - f) + buf[(i + 1) & m] * f;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length, chs = output.length;
    const r = parameters.pitch[0];
    const target = Math.abs(r - 1) < 1e-4 ? 0 : 1;
    const dp = (1 - r) / this.W;
    const { W, mask, bufs } = this;
    let { w, phase, mix } = this;

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < chs; c++) {
        const src = input.length ? input[Math.min(c, input.length - 1)] : null;
        bufs[c][w] = src ? src[i] : 0;
      }
      if (mix < target) mix = Math.min(target, mix + this.mixStep);
      else if (mix > target) mix = Math.max(target, mix - this.mixStep);

      if (mix > 0) {
        const p1 = phase, p2 = phase >= 0.5 ? phase - 0.5 : phase + 0.5;
        const s1 = Math.sin(Math.PI * p1), s2 = Math.sin(Math.PI * p2);
        const g1 = s1 * s1, g2 = s2 * s2;                        // Hann windows, g1 + g2 = 1
        const d1 = p1 * W, d2 = p2 * W;
        for (let c = 0; c < chs; c++) {
          const dry = bufs[c][w];
          const wet = g1 * this.read(bufs[c], w - d1) + g2 * this.read(bufs[c], w - d2);
          output[c][i] = dry * (1 - mix) + wet * mix;
        }
      } else {
        for (let c = 0; c < chs; c++) output[c][i] = bufs[c][w];
      }

      w = (w + 1) & mask;
      phase += dp;
      if (phase >= 1) phase -= 1; else if (phase < 0) phase += 1;
    }
    this.w = w; this.phase = phase; this.mix = mix;
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifter);
