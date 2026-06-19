// Canvas renderer — the art piece.
//
// Motion model: every fix is stamped with its local arrival time and pushed to a
// per-aircraft history. We render the world RENDER_DELAY_MS in the past and
// *interpolate* between the two surrounding real fixes (rather than extrapolating
// into the future). Interpolating between known points is buttery smooth and
// removes the once-per-second "snap" you get from naive dead-reckoning. The small
// added latency is irrelevant for an ambient ceiling piece.
//
// Visual language: pure black, luminous altitude-graded glyphs, comet trails that
// taper and fade, and restrained typography that fades in only for the nearest few.

import {
  llToMeters,
  project,
  pxPerMeter,
  deadReckon,
  rangeMeters,
  metersToMiles,
  EMERGENCY_SQUAWKS,
  type Aircraft,
  type Config,
  type Meters,
  type Point,
} from "@shared/index.js";
//mport { AIRPORTS } from "./airports.js";
import { classifyGlyph, drawAircraftGlyph, GLYPH_SCALE } from "./aircraftGlyph.js";
import { computeSky, type Sky, type Tle } from "./celestial.js";
import { ASTERISMS } from "./stars.js";
import type { Airport, AirportGeometry } from "@shared/index.js";
import type { MetarInfo } from "@shared/index.js";
import tzLookup from "tz-lookup";

/** How far in the past we render, ms. Just over the ~1 Hz fix interval. */
const RENDER_DELAY_MS = 1150;

interface Sample {
  t: number; // performance.now() at arrival
  m: Meters;
  track?: number;
  gs?: number;
}

interface Track {
  ac: Aircraft;
  history: Sample[];
  firstSeen: number;
  lastSeen: number;
  hasPos: boolean;
  /** Smoothed appearance alpha (fade in on spawn, out when stale). */
  life: number;

  smoothedHeading?: number;
  prevGroundSpeedKt?: number;
  surfaceState?: "landing_roll" | "departure_roll" | "taxi" | "airborne" | "unknown";
}

type ProjOpts = Parameters<typeof project>[1];

// Altitude colour ramp — warm low, cool high. Tuned to glow on black.
const ALT_STOPS: [number, [number, number, number]][] = [
  [0, [255, 138, 61]], // amber (ground / pattern)
  [4000, [255, 198, 92]], // gold
  [10000, [120, 224, 196]], // teal
  [20000, [110, 178, 255]], // sky blue
  [30000, [150, 150, 255]], // periwinkle
  [40000, [232, 236, 255]], // near-white
];

function altRamp(alt: number): [number, number, number] {
  if (alt <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (alt <= ALT_STOPS[i][0]) {
      const [a0, c0] = ALT_STOPS[i - 1];
      const [a1, c1] = ALT_STOPS[i];
      const f = (alt - a0) / (a1 - a0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}

const rgba = (c: [number, number, number], a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

interface Visible {
  tr: Track;
  m: Meters;
  p: Point;
  heading: number;
  rangeMi: number;
  alpha: number;
  color: [number, number, number];
  emergency: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private tracks = new Map<string, Track>();
  private raf = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private prevFrame = 0;
  /** When the next frame is due (ms, rAF clock), for the maxFps cap.
   *  0 = uninitialized; set on the first capped frame. */
  private nextFrameDue = 0;
  /** Current frame time in seconds, for animating props/rotors. */
  private frameT = 0;

  // Sky layer state.
  private tles: Tle[] = [];
  private sky: Sky = { stars: [], sats: [] };
  private skyComputedAt = 0;
  private skyOffsetUsed = NaN;

constructor(
  private canvas: HTMLCanvasElement,
  private getConfig: () => Config,
  private getAirports: () => Airport[],
  private getGeometries: () => AirportGeometry[],
  private getMetar: () => MetarInfo | null
) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
  }

  start(): void {
    void this.fetchTles();
    setInterval(() => void this.fetchTles(), 3600_000);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // Cap to maxFps via an accumulator: advance a running "due" time by whole
      // frame intervals so the cadence stays anchored to a schedule (even
      // pacing, no drift) rather than to actual draw timestamps. fps <= 0 means
      // uncapped — draw on every rAF tick.
      const fps = this.getConfig().maxFps;
      if (fps > 0) {
        const interval = 1000 / fps;
        if (this.nextFrameDue === 0) this.nextFrameDue = now;
        if (now < this.nextFrameDue) return; // not due yet — skip this tick
        this.nextFrameDue += interval;
        // If we've fallen more than a frame behind (e.g. tab was backgrounded
        // or a draw stalled), resync to avoid a burst of catch-up frames.
        if (now - this.nextFrameDue > interval) this.nextFrameDue = now + interval;
      } else {
        this.nextFrameDue = 0; // reset so re-enabling the cap starts clean
      }
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private async fetchTles(): Promise<void> {
    try {
      const res = await fetch("/api/tle");
      if (res.ok) this.tles = (await res.json()) as Tle[];
    } catch {
      /* keep whatever we had */
    }
  }
  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Feed a fresh snapshot. Stamps each fix with local arrival time. */
  update(aircraft: Aircraft[]): void {
    const cfg = this.getConfig();
    const now = performance.now();
    for (const ac of aircraft) {
      if (!this.passesFilter(ac, cfg)) continue;
      const hasPos = ac.lat != null && ac.lon != null;
      const m = hasPos
        ? llToMeters(ac.lat!, ac.lon!, cfg.centerLat, cfg.centerLon)
        : { east: 0, north: 0 };
      let tr = this.tracks.get(ac.hex);
      if (!tr) {
        tr = { ac, history: [], firstSeen: now, lastSeen: now, hasPos, life: 0 };
        this.tracks.set(ac.hex, tr);
      }
      tr.ac = ac;
      tr.lastSeen = now;
      tr.hasPos = hasPos;
      if (hasPos) {
        const last = tr.history[tr.history.length - 1];
        // Dedup identical fixes (source sometimes repeats a position).
        if (!last || last.m.east !== m.east || last.m.north !== m.north) {
          tr.history.push({ t: now, m, track: ac.track, gs: ac.gs });
        }
      }
    }
  }

  private passesFilter(ac: Aircraft, cfg: Config): boolean {
    if (cfg.hideOnGround && ac.onGround) return false;
    const alt = ac.altBaro ?? ac.altGeom;
    if (alt != null) {
      if (alt < cfg.minAltitudeFt) return false;
      if (alt > cfg.maxAltitudeFt) return false;
    }
    return true;
  }

  /** Interpolate a track's position at render time `tt` (perf clock). */
  private sampleAt(tr: Track, tt: number, cfg: Config): Meters | null {
    const h = tr.history;
    if (h.length === 0) return null;
    if (tt <= h[0].t) return h[0].m;
    const lastS = h[h.length - 1];
    if (tt >= lastS.t) {
      // Beyond newest fix — extrapolate gently, capped.
      const dt = Math.min((tt - lastS.t) / 1000, cfg.maxExtrapolationSec);
      return cfg.interpolate ? deadReckon(lastS.m, lastS.track, lastS.gs, dt) : lastS.m;
    }
    // Find the bracketing pair.
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= tt && tt <= h[i].t) {
        const a = h[i - 1];
        const b = h[i];
        const f = (tt - a.t) / Math.max(1, b.t - a.t);
        return {
          east: a.m.east + (b.m.east - a.m.east) * f,
          north: a.m.north + (b.m.north - a.m.north) * f,
        };
      }
    }
    return lastS.m;
  }

  private draw(): void {
    const cfg = this.getConfig();
    const ctx = this.ctx;
    const now = performance.now();
    const frameDt = this.prevFrame ? (now - this.prevFrame) / 1000 : 0.016;
    this.prevFrame = now;
    this.frameT = now / 1000;

    if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h) {
      this.resize();
    }

    ctx.fillStyle = cfg.palette.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const pxPerM = pxPerMeter(this.w, this.h, cfg.radiusMiles);
    const proj: ProjOpts = {
      rotationDeg: cfg.rotationDeg,
      mirrorX: cfg.mirrorX,
      mirrorY: cfg.mirrorY,
      pxPerM,
      screenW: this.w,
      screenH: this.h,
    };

    this.updateSky(cfg, now);
    this.drawSky(cfg, proj);
    this.drawOverlays(cfg, proj);
    if (cfg.showAirport) {
  this.drawAirportGeometry(cfg, proj);
  this.drawAirport(cfg, proj);
  if (cfg.showGroundVehicles && cfg.radiusMiles <= 6) {
    this.drawGroundVehicles(cfg, proj);
  }
}

    const tt = now - RENDER_DELAY_MS;
    const visible: Visible[] = [];

    for (const [hex, tr] of this.tracks) {
      const stale = (now - tr.lastSeen) / 1000;
      if (stale > cfg.staleSec) {
        this.tracks.delete(hex);
        continue;
      }
      // Trim history to the trail window (+ a little headroom for interp).
      const keep = Math.max(cfg.trailSeconds, 6) * 1000 + 4000;
      while (tr.history.length > 2 && now - tr.history[0].t > keep) tr.history.shift();

      // Fade in on spawn, fade out as it goes stale.
      const target = stale > cfg.staleSec * 0.5 ? 0 : 1;
      tr.life += (target - tr.life) * Math.min(1, frameDt * 3.5);

      if (!tr.hasPos) continue;
      const m = this.sampleAt(tr, tt, cfg);
      if (!m) continue;

      const rangeMi = metersToMiles(rangeMeters(m));
      if (rangeMi > cfg.radiusMiles * 1.08) continue;

      const p = project(m, proj);

const rawHeading = this.screenHeading(tr, tt, proj);
const heading = this.smoothScreenHeading(tr, rawHeading);

tr.surfaceState = this.classifySurfaceRoll(tr.ac, tr);

const edgeFade = clamp01((cfg.radiusMiles - rangeMi) / (cfg.radiusMiles * 0.14));
      const alpha = clamp01(edgeFade) * tr.life * cfg.brightness;
      const alt = tr.ac.altBaro ?? tr.ac.altGeom ?? 0;
      //const color = cfg.altitudeColor ? altRamp(alt) : hexToRgb(cfg.palette.glyph);
      let color = cfg.altitudeColor
  ? altRamp(alt)
  : hexToRgb(cfg.palette.glyph);

const op = this.classifyOperation(tr.ac, cfg);

if (op === "ground") {
  color = [255, 220, 120];
}
else if (op === "arrival") {
  color = [90, 255, 140];
}
else if (op === "departure") {
  color = [80, 210, 255];
}

if (tr.surfaceState === "landing_roll") {
  color = [120, 255, 160];
}
else if (tr.surfaceState === "departure_roll") {
  color = [90, 210, 255];
}
      const emergency = cfg.highlightEmergency && !!tr.ac.squawk && EMERGENCY_SQUAWKS.has(tr.ac.squawk);

      visible.push({ tr, m, p, heading, rangeMi, alpha, color, emergency });
    }

    // Nearest last so it paints on top.
    visible.sort((a, b) => b.rangeMi - a.rangeMi);

    // Trails + glyphs for everyone.
    if (cfg.showDestArc) for (const v of visible) this.drawDestArc(cfg, proj, v);
    for (const v of visible) this.drawTrail(cfg, proj, v, tt);
    for (const v of visible) {
  this.drawGlyph(cfg, v);
}

// Labels: nearest are at the END after the sort.
const byNear = [...visible].reverse(); // nearest first
this.drawLabels(cfg, byNear);

// Draw roll tags last so labels do not hide them.
for (const v of visible) {
  this.drawSurfaceStateTag(cfg, v);
}
    this.drawLandingQueue(cfg);
    if (cfg.theme === "focus" && byNear.length) this.drawDetailPanel(cfg, byNear[0]);
  }

  /**
   * Run `draw` with the canvas rotated by `labelRotationDeg` around an anchor,
   * so text reads upright from where the viewer lies without moving the field.
   */
  private withLabelRotation(cfg: Config, ax: number, ay: number, draw: () => void): void {
    if (!cfg.labelRotationDeg) {
      draw();
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate((cfg.labelRotationDeg * Math.PI) / 180);
    ctx.translate(-ax, -ay);
    draw();
    ctx.restore();
  }


 private getLikelyActiveRunwayLabel(): string | null {
  const metar = this.getMetar();

  if (
    metar?.icao == null ||
    metar.windDirDeg == null ||
    metar.windSpeedKt == null ||
    metar.windSpeedKt < 3
  ) {
    return null;
  }

  const airport = this
    .getAirports()
    .find((a) => a.icao === metar.icao);

  if (!airport) return null;

  let bestRunway: string | null = null;
  let bestDiff = Infinity;

  for (const runway of airport.runways) {
    const candidates = [
      runway.leIdent,
      runway.heIdent,
    ];

    for (const ident of candidates) {
      const match = ident.match(/^(\d{2})([LCR])?$/);
      if (!match) continue;

      const number = match[1];
      const suffix = match[2] ?? "";

      const heading =
        number === "36"
          ? 360
          : Number(number) * 10;

      const diff = Math.abs(
        ((heading - metar.windDirDeg + 540) % 360) - 180
      );

      if (diff < bestDiff) {
        bestDiff = diff;
        bestRunway = number + suffix;
      }
    }
  }

  return bestDiff <= 35 ? bestRunway : null;
}

private classifyOperation(
  ac: Aircraft,
  cfg: Config,
): "arrival" | "departure" | "ground" | "unknown" {
  if (ac.onGround) return "ground";

  if (ac.originLat != null && ac.originLon != null) {
    const originNear =
      greatCircleMiles(
        cfg.centerLat,
        cfg.centerLon,
        ac.originLat,
        ac.originLon,
      ) < 45;

    if (originNear) return "departure";
  }

  if (ac.destLat != null && ac.destLon != null) {
    const destNear =
      greatCircleMiles(
        cfg.centerLat,
        cfg.centerLon,
        ac.destLat,
        ac.destLon,
      ) < 45;

    if (destNear) return "arrival";
  }

  const vr = ac.baroRate ?? 0;

  if (vr < -300) return "arrival";
  if (vr > 300) return "departure";

  return "unknown";
}

private smoothAngleRad(
  current: number,
  target: number,
  factor: number,
): number {
  const diff =
    Math.atan2(
      Math.sin(target - current),
      Math.cos(target - current),
    );

  return current + diff * factor;
}

private smoothScreenHeading(
  tr: Track,
  rawHeading: number,
): number {
  if (tr.smoothedHeading == null) {
    tr.smoothedHeading = rawHeading;
    return rawHeading;
  }

  tr.smoothedHeading = this.smoothAngleRad(
    tr.smoothedHeading,
    rawHeading,
    0.12,
  );

  return tr.smoothedHeading;
}

private classifySurfaceRoll(
  ac: Aircraft,
  tr: Track,
): Track["surfaceState"] {
  const gs = ac.gs ?? 0;
  const prevGs = tr.prevGroundSpeedKt ?? gs;
  const vr = ac.baroRate ?? 0;

  tr.prevGroundSpeedKt = gs;

  if (!ac.onGround) {
    return "airborne";
  }

  const accelerating = gs > prevGs + 1;
  const decelerating = gs < prevGs - 1;

  // Aircraft moving fast on ground and still accelerating = takeoff roll.
  if (gs >= 18 && accelerating) {
    return "departure_roll";
  }

  // Aircraft moving fast on ground and slowing down = landing roll.
  if (gs >= 18 && decelerating) {
    return "landing_roll";
  }

  // Fallback: fast ground movement is probably runway roll, not taxi.
  if (gs >= 45) {
    return vr < 0 ? "landing_roll" : "departure_roll";
  }

  if (gs <= 17) {
    return "taxi";
  }

  return "unknown";
}

  private screenHeading(tr: Track, tt: number, proj: ProjOpts): number {
    const a = this.sampleAt(tr, tt - 400, this.getConfig());
    const b = this.sampleAt(tr, tt + 400, this.getConfig());
    if (a && b) {
      const pa = project(a, proj);
      const pb = project(b, proj);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 0.5) {
        return Math.atan2(pb.y - pa.y, pb.x - pa.x);
      }
    }
    // Fallback: use reported track through the projection.
    const m = this.sampleAt(tr, tt, this.getConfig());
    if (m && tr.ac.track != null) {
      const ahead = deadReckon(m, tr.ac.track, 120, 1);
      const p0 = project(m, proj);
      const p1 = project(ahead, proj);
      return Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    return 0;
  }

  // --- overlays: whisper-quiet rings + compass ---
  private drawOverlays(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;

    if (cfg.rangeRings) {
      ctx.save();
      for (let mi = 1; mi <= Math.floor(cfg.radiusMiles); mi++) {
        const r = mi * 1609.34 * proj.pxPerM;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.5 * cfg.brightness);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 7]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Center mark.
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.7 * cfg.brightness);
      ctx.fill();
      ctx.restore();
    }

    if (cfg.compass) {
      ctx.save();
      const R = (Math.min(this.w, this.h) / 2) * 0.965;
      ctx.font = `300 12px ${cfg.fonts.label}`;
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.32 * cfg.brightness);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      try {
        ctx.letterSpacing = "3px";
      } catch {
        /* older browsers */
      }
      for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as [string, number][]) {
        const dir: Meters = {
          east: Math.sin((deg * Math.PI) / 180) * 1e6,
          north: Math.cos((deg * Math.PI) / 180) * 1e6,
        };
        const p = project(dir, { ...proj, pxPerM: R / 1e6 });
        this.withLabelRotation(cfg, p.x, p.y, () => ctx.fillText(label, p.x, p.y));
      }
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    }
  }

private drawGroundVehicles(
  cfg: Config,
  proj: ProjOpts,
): void {
  const allGeometries = this.getGeometries();
const geometries = cfg.showPrimaryAirportOnly
  ? allGeometries.slice(0, 1)
  : allGeometries;

if (!geometries.length) return;

  const taxiways: [number, number][][] = [];

  for (const geo of geometries) {
    for (const feature of geo.features) {
      const aeroway = feature.properties?.aeroway;
      const geom = feature.geometry;

      if (
        aeroway === "taxiway" &&
        geom.type === "LineString"
      ) {
        taxiways.push(
          geom.coordinates as [number, number][]
        );
      }
    }
  }

  if (!taxiways.length) return;

  const ctx = this.ctx;
  const vehicleCount = Math.min(18, taxiways.length);
  const t = this.frameT;

  ctx.save();

  for (let i = 0; i < vehicleCount; i++) {
    const line = taxiways[i % taxiways.length];

    if (line.length < 2) continue;

    const segIndex = Math.floor((i * 7) % (line.length - 1));

    const a = line[segIndex];
    const b = line[segIndex + 1];

    const phase = (t * (0.04 + i * 0.003) + i * 0.17) % 1;

    const lon = a[0] + (b[0] - a[0]) * phase;
    const lat = a[1] + (b[1] - a[1]) * phase;

    const p = this.toScreen([lat, lon], cfg, proj);

    const color =
      i % 3 === 0
        ? rgba([255, 210, 80], 0.85 * cfg.brightness)
        : i % 3 === 1
          ? rgba([120, 190, 255], 0.75 * cfg.brightness)
          : rgba([245, 245, 245], 0.75 * cfg.brightness);

    const heading = Math.atan2(
      b[1] - a[1],
      b[0] - a[0],
    );

    this.drawGroundVehicleIcon(
      p.x,
      p.y,
      heading,
      i % 3,
      color,
      cfg,
    );
  }

  ctx.restore();
}


private drawGroundVehicleIcon(
  x: number,
  y: number,
  heading: number,
  kind: number,
  color: string,
  cfg: Config,
): void {
  const ctx = this.ctx;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);

  ctx.shadowColor = color;
  ctx.shadowBlur = 3;
  ctx.fillStyle = color;
  ctx.strokeStyle = rgba([0, 0, 0], 0.65 * cfg.brightness);
  ctx.lineWidth = 0.7;

  if (kind === 0) {
    // Baggage cart / small service car
    ctx.beginPath();
    ctx.roundRect(-5, -2.5, 10, 5, 1.5);
    ctx.fill();
    ctx.stroke();
  } else if (kind === 1) {
    // Airport bus
    ctx.beginPath();
    ctx.roundRect(-8, -3, 16, 6, 1.5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rgba([0, 0, 0], 0.45 * cfg.brightness);
    ctx.fillRect(-5.5, -1.8, 2, 3.6);
ctx.fillRect(-2.5, -1.8, 2, 3.6);
ctx.fillRect(0.5, -1.8, 2, 3.6);
ctx.fillRect(3.5, -1.8, 2, 3.6);
  } else {
    // Pushback tug / truck
    ctx.beginPath();
    ctx.roundRect(-4, -2, 8, 4, 1);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rgba([255, 255, 255], 0.7 * cfg.brightness);
    ctx.fillRect(1.2, -1.3, 1.8, 2.6);
  }

  // Wheels
  ctx.fillStyle = rgba([10, 10, 15], 0.9 * cfg.brightness);
  ctx.beginPath();
  ctx.arc(-4, -3.2, 1.1, 0, Math.PI * 2);
ctx.arc(4, -3.2, 1.1, 0, Math.PI * 2);
ctx.arc(-4, 3.2, 1.1, 0, Math.PI * 2);
ctx.arc(4, 3.2, 1.1, 0, Math.PI * 2);
  ctx.arc(2.2, -2.1, 0.7, 0, Math.PI * 2);
  ctx.arc(-2.2, 2.1, 0.7, 0, Math.PI * 2);
  ctx.arc(2.2, 2.1, 0.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

private drawAirportGeometry(cfg: Config, proj: ProjOpts): void {
  const allGeometries = this.getGeometries();
const geometries = cfg.showPrimaryAirportOnly
  ? allGeometries.slice(0, 1)
  : allGeometries;

if (!geometries.length) return;

  const night =
  cfg.showAirportLighting &&
  this.isNightAtAirport(cfg);



  for (const geo of geometries) {
  for (const feature of geo.features) {
    const aeroway = feature.properties?.aeroway;
    const geom = feature.geometry;

    if (geom.type === "LineString") {
      const coords = geom.coordinates as [number, number][];

      if (aeroway === "taxiway") {
        this.drawOsmLine(
          coords,
          cfg,
          proj,
          night
            ? rgba([70, 130, 255], 0.55 * cfg.brightness)
            : rgba([120, 140, 170], 0.35 * cfg.brightness),
          night ? 2.5 : 2,
        );
      }

      if (aeroway === "runway") {
  this.drawOsmLine(
    coords,
    cfg,
    proj,
    night
      ? rgba([230, 240, 255], 0.75 * cfg.brightness)
      : rgba([170, 200, 240], 0.45 * cfg.brightness),
    night ? 5 : 4,
  );

  if (night) {
    this.drawRunwayEdgeLights(
      coords,
      cfg,
      proj,
    );
  }
}
    }

    if (geom.type === "Point") {
      if (!cfg.showGates) {
        continue;
      }

      const coord = geom.coordinates as [number, number];

      const label = String(
        feature.properties?.ref ??
        feature.properties?.name ??
        ""
      );

      if (aeroway === "gate") {
        this.drawOsmPoint(
          coord,
          cfg,
          proj,
          night
            ? rgba([80, 220, 255], 0.9 * cfg.brightness)
            : rgba([0, 255, 255], 0.75 * cfg.brightness),
          4,
          label,
        );
      }

      if (aeroway === "parking_position") {
        this.drawOsmPoint(
          coord,
          cfg,
          proj,
          night
            ? rgba([255, 210, 100], 0.9 * cfg.brightness)
            : rgba([255, 220, 120], 0.75 * cfg.brightness),
          2.5,
          label,
        );
      }

      if (aeroway === "helipad") {
  this.drawHelipadPoint(
    coord,
    cfg,
    proj,
  );

  this.drawOsmFeatureLabel(
    feature.properties?.name,
    coord,
    cfg,
    proj,
  );
}
    }

    if (geom.type === "Polygon") {
      const rings = geom.coordinates as [number, number][][];

      if (aeroway === "apron") {
        this.drawOsmPolygon(
          rings,
          cfg,
          proj,
          night
            ? rgba([60, 80, 120], 0.32 * cfg.brightness)
            : rgba([90, 105, 130], 0.22 * cfg.brightness),
        );
      }

      if (aeroway === "helipad") {
  this.drawOsmPolygon(
    rings,
    cfg,
    proj,
    rgba([110, 210, 170], 0.24 * cfg.brightness),
  );

  const first = rings[0]?.[0];

  if (first) {
    const labelCoord: [number, number] = [
      first[0],
      first[1],
    ];

    this.drawOsmFeatureLabel(
      feature.properties?.name,
      labelCoord,
      cfg,
      proj,
    );
  }
}

      if (aeroway === "terminal") {
        this.drawOsmPolygon(
          rings,
          cfg,
          proj,
          night
            ? rgba([255, 210, 120], 0.28 * cfg.brightness)
            : rgba([150, 170, 210], 0.25 * cfg.brightness),
        );
      }
    }

    if (geom.type === "MultiPolygon") {
      const polygons = geom.coordinates as [number, number][][][];

      for (const rings of polygons) {
        if (aeroway === "apron") {
          this.drawOsmPolygon(
            rings,
            cfg,
            proj,
            night
              ? rgba([60, 80, 120], 0.32 * cfg.brightness)
              : rgba([90, 105, 130], 0.22 * cfg.brightness),
          );
        }

        if (aeroway === "helipad") {
  this.drawOsmPolygon(
    rings,
    cfg,
    proj,
    rgba([110, 210, 170], 0.24 * cfg.brightness),
  );

  const first = rings[0]?.[0];

  if (first) {
    const labelCoord: [number, number] = [
      first[0],
      first[1],
    ];

    this.drawOsmFeatureLabel(
      feature.properties?.name,
      labelCoord,
      cfg,
      proj,
    );
  }
}

        if (aeroway === "terminal") {
          this.drawOsmPolygon(
            rings,
            cfg,
            proj,
            night
              ? rgba([255, 210, 120], 0.28 * cfg.brightness)
              : rgba([150, 170, 210], 0.25 * cfg.brightness),
          );
        }
      }
    }
  }
}
}

private drawHelipadPoint(
  coord: [number, number],
  cfg: Config,
  proj: ProjOpts,
): void {
  const [lon, lat] = coord;
  const p = this.toScreen([lat, lon], cfg, proj);

  const ctx = this.ctx;

  ctx.save();

  ctx.strokeStyle = rgba([120, 255, 180], 0.9 * cfg.brightness);
  ctx.fillStyle = rgba([120, 255, 180], 0.16 * cfg.brightness);
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = `700 9px ${cfg.fonts.label}`;
  ctx.fillStyle = rgba([230, 255, 240], 0.95 * cfg.brightness);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("H", p.x, p.y);

  ctx.restore();
}


private drawOsmFeatureLabel(
  label: unknown,
  coord: [number, number],
  cfg: Config,
  proj: ProjOpts,
): void {
  if (!label) return;

  const [lon, lat] = coord;
  const p = this.toScreen([lat, lon], cfg, proj);

  const ctx = this.ctx;

  ctx.save();
  ctx.font = `500 10px ${cfg.fonts.label}`;
  ctx.fillStyle = rgba([230, 245, 255], 0.75 * cfg.brightness);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  ctx.fillText(
    String(label),
    p.x,
    p.y + 9,
  );

  ctx.restore();
}

private drawOsmPoint(
  coord: [number, number],
  cfg: Config,
  proj: ProjOpts,
  fill: string,
  radius: number,
  label?: string,
): void {
  const [lon, lat] = coord;
  const p = this.toScreen([lat, lon], cfg, proj);

  const ctx = this.ctx;

  ctx.save();

  ctx.fillStyle = fill;
  ctx.strokeStyle = rgba([220, 240, 255], 0.7 * cfg.brightness);
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (label) {
    ctx.font = "10px sans-serif";
    ctx.fillStyle = rgba([220, 240, 255], 0.85 * cfg.brightness);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, p.x + radius + 3, p.y);
  }

  ctx.restore();
}

private drawOsmLine(
  coords: [number, number][],
  cfg: Config,
  proj: ProjOpts,
  stroke: string,
  width: number,
): void {
  if (coords.length < 2) return;

  const ctx = this.ctx;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();

  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const p = this.toScreen([lat, lon], cfg, proj);

    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }

  ctx.stroke();
  ctx.restore();
}

private drawRunwayEdgeLights(
  coords: [number, number][],
  cfg: Config,
  proj: ProjOpts,
): void {
  if (coords.length < 2) return;

  const ctx = this.ctx;

  const points = coords.map(([lon, lat]) =>
    this.toScreen([lat, lon], cfg, proj)
  );

  const start = points[0];
  const end = points[points.length - 1];

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);

  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;

  const nx = -uy;
  const ny = ux;

  const spacingPx = 24;
  const offsetPx = 6;
  const radiusPx = 1.35;

  ctx.save();

  for (let d = spacingPx; d < len - spacingPx; d += spacingPx) {
    const x = start.x + ux * d;
    const y = start.y + uy * d;

    const localPulse =
      this.dynamicLightAlpha(
        cfg,
        d * 0.025,
      );

    const color = rgba(
      [210, 235, 255],
      localPulse * cfg.brightness,
    );

    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 3;

    ctx.beginPath();
    ctx.arc(
      x + nx * offsetPx,
      y + ny * offsetPx,
      radiusPx,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    ctx.beginPath();
    ctx.arc(
      x - nx * offsetPx,
      y - ny * offsetPx,
      radiusPx,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  ctx.restore();
}

private drawOsmPolygon(
  rings: [number, number][][],
  cfg: Config,
  proj: ProjOpts,
  fill: string,
): void {
  if (!rings.length) return;

  const ctx = this.ctx;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = rgba([130, 150, 180], 0.25 * cfg.brightness);
  ctx.lineWidth = 1;

  ctx.beginPath();

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const p = this.toScreen([lat, lon], cfg, proj);

      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }

    ctx.closePath();
  }

  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

  // --- airport: runways at true geographic position ---
private drawAirport(cfg: Config, proj: ProjOpts): void {
  const ctx = this.ctx;
  const rwyRgb: [number, number, number] = [150, 180, 220];
  const allAirports = this.getAirports();
const airports = cfg.showPrimaryAirportOnly
  ? allAirports.slice(0, 1)
  : allAirports;

  if (!airports.length) return;

  const activeRunway = this.getLikelyActiveRunwayLabel();

  for (const ap of airports) {
    let cx = 0;
    let cy = 0;
    let n = 0;

    for (const r of ap.runways) {
      const a = this.toScreen(r.le, cfg, proj);
      const b = this.toScreen(r.he, cfg, proj);

      const wpx = Math.max(
        2.5,
        r.widthFt * 0.3048 * proj.pxPerM * 1.4,
      );

      ctx.save();
      ctx.lineCap = "butt";

      const isActiveRunway =
  r.leIdent === activeRunway ||
  r.heIdent === activeRunway;

ctx.strokeStyle = isActiveRunway
  ? rgba(rwyRgb, 0.16 * cfg.brightness)
  : rgba(rwyRgb, 0.05 * cfg.brightness);

ctx.lineWidth = wpx;

ctx.beginPath();
ctx.moveTo(a.x, a.y);
ctx.lineTo(b.x, b.y);
ctx.stroke();

ctx.strokeStyle = isActiveRunway
  ? rgba([210, 226, 255], 0.22 * cfg.brightness)
  : rgba([210, 226, 255], 0.10 * cfg.brightness);

ctx.lineWidth = 1;
ctx.setLineDash([6, 6]);

ctx.beginPath();
ctx.moveTo(a.x, a.y);
ctx.lineTo(b.x, b.y);
ctx.stroke();

      ctx.restore();

      this.drawRunwayLabel(r.leIdent, r.le, cfg, proj);
      this.drawRunwayLabel(r.heIdent, r.he, cfg, proj);

      

if (activeRunway) {
  if (r.leIdent === activeRunway) {
    this.drawFinalApproachFunnel(
      r.le,
      r.he,
      cfg,
      proj,
    );
  }

  if (r.heIdent === activeRunway) {
    this.drawFinalApproachFunnel(
      r.he,
      r.le,
      cfg,
      proj,
    );
  }
}

if (
  activeRunway &&
  cfg.showAirportLighting &&
  this.isNightAtAirport(cfg)
) {
  if (r.leIdent === activeRunway) {
    this.drawPapiLights(
  r.le,
  r.he,
  cfg,
  proj,
  this.getPapiWhiteCount(r.le, r.he, cfg),
);
    this.drawApproachLights(r.le, r.he, cfg, proj);
  }

  if (r.heIdent === activeRunway) {
    this.drawPapiLights(
  r.he,
  r.le,
  cfg,
  proj,
  this.getPapiWhiteCount(r.he, r.le, cfg),
);
    this.drawApproachLights(r.he, r.le, cfg, proj);
  }
}

      cx += (a.x + b.x) / 2;
      cy += (a.y + b.y) / 2;
      n++;
    }

    if (n) {
      cx /= n;
      cy /= n;

      ctx.save();
      ctx.font = `300 13px ${cfg.fonts.label}`;
      ctx.fillStyle = rgba(rwyRgb, 0.5 * cfg.brightness);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      try {
        ctx.letterSpacing = "4px";
      } catch {
        /* noop */
      }

      ctx.fillText(ap.name, cx, cy);

      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }

      ctx.restore();
    }
  }

  if (activeRunway) {
    ctx.save();
    ctx.font = `600 14px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba([120, 255, 170], 0.9 * cfg.brightness);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.fillText(
      `ACTIVE RWY ${activeRunway}`,
      16,
      cfg.showHud ? 42 : 16,
    );

    ctx.restore();
  }
}

private dynamicLightAlpha(
  cfg: Config,
  phase = 0,
): number {
  if (!cfg.showDynamicLighting) {
    return 1;
  }

  return (
    0.65 +
    0.25 *
      Math.sin(
        this.frameT * 2.2 + phase,
      )
  );
}

private airportLightScale(cfg: Config): number {
  if (cfg.radiusMiles > 11) return 0;

  if (cfg.radiusMiles <= 3) return 1.4;

  return 1.4 - ((cfg.radiusMiles - 3) / 8) * 1.05;
}

  private drawRunwayLabel(
  label: string,
  coord: [number, number],
  cfg: Config,
  proj: ProjOpts,
): void {
  if (!label) return;

  const p = this.toScreen(coord, cfg, proj);
  const ctx = this.ctx;

  ctx.save();

  ctx.font = `700 11px ${cfg.fonts.label}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.strokeStyle = rgba([0, 0, 0], 0.85 * cfg.brightness);
  ctx.lineWidth = 3;
  ctx.strokeText(label, p.x, p.y);

  ctx.fillStyle = rgba([235, 245, 255], 0.95 * cfg.brightness);
  ctx.fillText(label, p.x, p.y);

  ctx.restore();
}

private drawPapiLights(
  threshold: [number, number],
  oppositeEnd: [number, number],
  cfg: Config,
  proj: ProjOpts,
  whiteCount: number
): void {
  const ctx = this.ctx;

  const a = this.toScreen(threshold, cfg, proj);
  const b = this.toScreen(oppositeEnd, cfg, proj);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);

  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;

  const nx = -uy;
  const ny = ux;

  const scale = this.airportLightScale(cfg);
  if (scale <= 0) return;

const along = 18 * scale;
const side = 18 * scale;
const spacing = 5 * scale;
const radius = 2.2 * scale;

  const baseX = a.x + ux * along + nx * side;
  const baseY = a.y + uy * along + ny * side;

  ctx.save();
  ctx.shadowBlur = 5;

  for (let i = 0; i < 4; i++) {
    const x = baseX + nx * i * spacing;
    const y = baseY + ny * i * spacing;

    const isWhite = i < whiteCount;

    const pulse =
  this.dynamicLightAlpha(
    cfg,
    i * 0.6,
  );

const color = isWhite
  ? rgba(
      [255, 255, 255],
      pulse * cfg.brightness,
    )
  : rgba(
      [255, 60, 60],
      pulse * cfg.brightness,
    );

    ctx.fillStyle = color;
    ctx.shadowColor = color;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

private isAircraftInApproachFunnel(
  ac: Aircraft,
  threshold: [number, number],
  oppositeEnd: [number, number],
  cfg: Config,
): boolean {
  if (ac.lat == null || ac.lon == null) return false;

  const thresholdM = llToMeters(
    threshold[0],
    threshold[1],
    cfg.centerLat,
    cfg.centerLon,
  );

  const oppositeM = llToMeters(
    oppositeEnd[0],
    oppositeEnd[1],
    cfg.centerLat,
    cfg.centerLon,
  );

  const acM = llToMeters(
    ac.lat,
    ac.lon,
    cfg.centerLat,
    cfg.centerLon,
  );

  const runwayDx = oppositeM.east - thresholdM.east;
  const runwayDy = oppositeM.north - thresholdM.north;
  const runwayLen = Math.hypot(runwayDx, runwayDy);

  if (runwayLen < 1) return false;

  // Direction outside the landing threshold.
  const approachUx = -runwayDx / runwayLen;
  const approachUy = -runwayDy / runwayLen;

  const dx = acM.east - thresholdM.east;
  const dy = acM.north - thresholdM.north;

  const distanceAlongFinal =
    dx * approachUx +
    dy * approachUy;

  // Aircraft must be before the runway threshold, not behind/on runway.
  if (distanceAlongFinal < 500 || distanceAlongFinal > 14000) {
    return false;
  }

  const lateralOffset =
    Math.abs(
      dx * -approachUy +
      dy * approachUx,
    );

  // Funnel widens with distance.
  const allowedOffset =
    250 + distanceAlongFinal * 0.10;

  if (lateralOffset > allowedOffset) {
    return false;
  }

  const vr = ac.baroRate ?? 0;

  // Prefer descending/stable aircraft, reject clear climb-outs.
  if (vr > 400) {
    return false;
  }

  return true;
}

private getPapiWhiteCount(
  threshold: [number, number],
  oppositeEnd: [number, number],
  cfg: Config,
): number {
  const thresholdM = llToMeters(
    threshold[0],
    threshold[1],
    cfg.centerLat,
    cfg.centerLon,
  );

  let best:
    | { distanceM: number; angleDeg: number }
    | null = null;

  for (const tr of this.tracks.values()) {
    const ac = tr.ac;

    if (ac.onGround) continue;
    if (ac.lat == null || ac.lon == null) continue;

    const op = this.classifyOperation(ac, cfg);
    if (op !== "arrival") continue;

    if (
      !this.isAircraftInApproachFunnel(
        ac,
        threshold,
        oppositeEnd,
        cfg,
      )
    ) {
      continue;
    }

    const altFt = ac.altGeom ?? ac.altBaro;
    if (altFt == null) continue;

    const acM = llToMeters(
      ac.lat,
      ac.lon,
      cfg.centerLat,
      cfg.centerLon,
    );

    const dx = acM.east - thresholdM.east;
    const dy = acM.north - thresholdM.north;

    const distanceM = Math.hypot(dx, dy);

    if (distanceM < 300 || distanceM > 14000) continue;

    const angleRad = Math.atan2(
      altFt * 0.3048,
      distanceM,
    );

    const angleDeg =
      angleRad * 180 / Math.PI;

    if (
      !best ||
      distanceM < best.distanceM
    ) {
      best = {
        distanceM,
        angleDeg,
      };
    }
  }

  if (!best) {
    return 2;
  }

  if (best.angleDeg >= 3.5) return 4;
  if (best.angleDeg >= 3.2) return 3;
  if (best.angleDeg >= 2.8) return 2;
  if (best.angleDeg >= 2.5) return 1;

  return 0;
}



private drawFinalApproachFunnel(
  threshold: [number, number],
  oppositeEnd: [number, number],
  cfg: Config,
  proj: ProjOpts,
): void {
  if (cfg.radiusMiles > 12) return;

  const ctx = this.ctx;

  const a = this.toScreen(threshold, cfg, proj);
  const b = this.toScreen(oppositeEnd, cfg, proj);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);

  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;

  // Extend outside the threshold, opposite runway direction.
  const ox = -ux;
  const oy = -uy;

  const nx = -uy;
  const ny = ux;

  const funnelLength = Math.min(260, len * 1.15);
  const nearWidth = 10;
  const farWidth = 95;

  const nearX = a.x + ox * 20;
  const nearY = a.y + oy * 20;

  const farX = a.x + ox * funnelLength;
  const farY = a.y + oy * funnelLength;

  ctx.save();

  // Very faint filled approach cone.
  ctx.beginPath();
  ctx.moveTo(nearX + nx * nearWidth, nearY + ny * nearWidth);
  ctx.lineTo(farX + nx * farWidth, farY + ny * farWidth);
  ctx.lineTo(farX - nx * farWidth, farY - ny * farWidth);
  ctx.lineTo(nearX - nx * nearWidth, nearY - ny * nearWidth);
  ctx.closePath();

  ctx.fillStyle = rgba([120, 255, 170], 0.035 * cfg.brightness);
  ctx.fill();

  // Faint side guide lines.
  ctx.strokeStyle = rgba([120, 255, 170], 0.10 * cfg.brightness);
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 10]);

  ctx.beginPath();
  ctx.moveTo(nearX + nx * nearWidth, nearY + ny * nearWidth);
  ctx.lineTo(farX + nx * farWidth, farY + ny * farWidth);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(nearX - nx * nearWidth, nearY - ny * nearWidth);
  ctx.lineTo(farX - nx * farWidth, farY - ny * farWidth);
  ctx.stroke();

  ctx.setLineDash([]);

  ctx.restore();
}


private drawApproachLights(
  threshold: [number, number],
  oppositeEnd: [number, number],
  cfg: Config,
  proj: ProjOpts,
): void {
  const ctx = this.ctx;

  const a = this.toScreen(threshold, cfg, proj);
  const b = this.toScreen(oppositeEnd, cfg, proj);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);

  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;

  // Opposite direction of runway centerline, outside threshold.
  const ox = -ux;
  const oy = -uy;

  const nx = -uy;
  const ny = ux;

  const pulse =
  this.dynamicLightAlpha(cfg);

  const color = rgba(
    [245, 250, 255],
    pulse * cfg.brightness,
  );

  ctx.save();

  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;

  const scale = this.airportLightScale(cfg);
  if (scale <= 0) return;

const spacing = 14 * scale;
const radius = 1.8 * scale;

  // Centerline approach lights.
  for (let i = 1; i <= 12; i++) {
    const d = i * spacing;

    const x = a.x + ox * d;
    const y = a.y + oy * d;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Crossbars for visual runway approach system.
  for (const i of [4, 8, 12]) {
    const d = i * spacing;
    const cx = a.x + ox * d;
    const cy = a.y + oy * d;

    for (let s = -2; s <= 2; s++) {
      const x = cx + nx * s * 6 * scale;
      const y = cy + ny * s * 6 * scale;

      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}


  private toScreen(ll: [number, number], cfg: Config, proj: ProjOpts): Point {
    return project(llToMeters(ll[0], ll[1], cfg.centerLat, cfg.centerLon), proj);
  }

  // --- sky layer (sun / moon / stars / satellites) ---
  private updateSky(cfg: Config, now: number): void {
    const want = cfg.showStars || cfg.showSun || cfg.showMoon || cfg.showSatellites;
    if (!want) {
      this.sky = { stars: [], sats: [] };
      return;
    }
    if (now - this.skyComputedAt < 300 && this.skyOffsetUsed === cfg.skyTimeOffsetMin) return;
    this.skyComputedAt = now;
    this.skyOffsetUsed = cfg.skyTimeOffsetMin;
    const date = new Date(Date.now() + cfg.skyTimeOffsetMin * 60000);
    this.sky = computeSky(date, cfg.centerLat, cfg.centerLon, {
      sun: cfg.showSun,
      moon: cfg.showMoon,
      stars: cfg.showStars,
      satellites: cfg.showSatellites,
      magLimit: cfg.starMagLimit,
      tles: this.tles,
    });
  }

  /** Place an (azimuth, altitude) sky point on the field. Zenith=center, horizon=edge. */
  private projectSky(az: number, alt: number, cfg: Config, proj: ProjOpts): Point {
    const R = cfg.radiusMiles * 1609.34;
    const r = (1 - Math.max(0, alt) / 90) * R;
    const a = (az * Math.PI) / 180;
    return project({ east: Math.sin(a) * r, north: Math.cos(a) * r }, proj);
  }

  private drawSky(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const b = cfg.brightness;

    // Asterism lines (faint) — need star screen points by id.
    if (cfg.showStars && this.sky.stars.length) {
      const pts = new Map<string, Point>();
      for (const s of this.sky.stars) {
        if (s.id) pts.set(s.id, this.projectSky(s.az, s.alt, cfg, proj));
      }
      ctx.save();
      ctx.strokeStyle = `rgba(150,170,220,${0.14 * b})`;
      ctx.lineWidth = 1;
      for (const [a, c] of ASTERISMS) {
        const pa = pts.get(a);
        const pc = pts.get(c);
        if (pa && pc) {
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pc.x, pc.y);
          ctx.stroke();
        }
      }
      ctx.restore();

      // Stars themselves, sized + twinkling by magnitude.
      for (const s of this.sky.stars) {
        const p = pts.get(s.id!)!;
        const mag = s.mag ?? 2;
        const size = Math.max(0.6, 2.6 - mag * 0.7);
        const tw = 0.78 + 0.22 * Math.sin(this.frameT * 3 + s.az);
        const a = clamp01((2.8 - mag) / 3) * b * tw;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(214,224,255,${a})`;
        if (mag < 0.6) {
          ctx.shadowColor = `rgba(200,215,255,${a})`;
          ctx.shadowBlur = size * 3;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (mag < 0.3 && s.name) this.skyLabel(p, s.name, cfg, 0.5 * b);
      }
    }

    if (cfg.showMoon && this.sky.moon && this.sky.moon.alt > -2) {
      this.drawMoon(this.projectSky(this.sky.moon.az, this.sky.moon.alt, cfg, proj),
        this.sky.moon.illum ?? 1, this.sky.moon.waning ?? false, b);
    }
    if (cfg.showSun && this.sky.sun && this.sky.sun.alt > -2) {
      this.drawSun(this.projectSky(this.sky.sun.az, this.sky.sun.alt, cfg, proj), b);
    }
    if (cfg.showSatellites && this.sky.sats.length) {
      for (const sat of this.sky.sats) {
        const p = this.projectSky(sat.az, sat.alt, cfg, proj);
        const iss = sat.kind === "iss";
        ctx.beginPath();
        ctx.arc(p.x, p.y, iss ? 3 : 1.6, 0, Math.PI * 2);
        if (iss) {
          ctx.fillStyle = `rgba(140,255,214,${0.95 * b})`;
          ctx.shadowColor = `rgba(140,255,214,${b})`;
          ctx.shadowBlur = 10;
        } else {
          ctx.fillStyle = `rgba(170,205,255,${0.65 * b})`;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (iss) this.skyLabel({ x: p.x + 6, y: p.y - 6 }, "ISS", cfg, 0.9 * b, "#8CFFD6");
      }
    }
  }

  private drawSun(p: Point, b: number): void {
    const ctx = this.ctx;
    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26);
    g.addColorStop(0, `rgba(255,210,120,${0.9 * b})`);
    g.addColorStop(0.4, `rgba(255,180,80,${0.4 * b})`);
    g.addColorStop(1, "rgba(255,170,70,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,224,150,${b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  

  private drawMoon(p: Point, illum: number, waning: boolean, b: number): void {
    const ctx = this.ctx;
    const r = 8;
    ctx.save();
    // Soft glow.
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
    g.addColorStop(0, `rgba(220,228,245,${0.35 * b})`);
    g.addColorStop(1, "rgba(220,228,245,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    // Dim full disc (earthshine).
    ctx.fillStyle = `rgba(64,72,90,${0.55 * b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Lit region: bright limb semicircle + elliptical terminator.
    ctx.translate(p.x, p.y);
    ctx.scale(waning ? -1 : 1, 1); // bright limb on the right (waxing) / left (waning)
    const rx = r * (1 - 2 * illum); // >0 crescent, <0 gibbous, 0 = half
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.abs(rx), r, 0, Math.PI / 2, -Math.PI / 2, rx > 0);
    ctx.closePath();
    ctx.fillStyle = `rgba(232,238,250,${b})`;
    ctx.fill();
    ctx.restore();
  }

  private skyLabel(p: Point, text: string, cfg: Config, alpha: number, color = "#AEB6C6"): void {
    const ctx = this.ctx;
    this.withLabelRotation(cfg, p.x, p.y, () => {
      ctx.save();
      ctx.font = `300 10px ${cfg.fonts.label}`;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      try {
        ctx.letterSpacing = "1px";
      } catch {
        /* noop */
      }
      ctx.fillText(text, p.x + 5, p.y);
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    });
  }

  // --- window to elsewhere: faint great-circle arc toward destination ---
  private drawDestArc(cfg: Config, proj: ProjOpts, v: Visible): void {
    const ac = v.tr.ac;
    if (ac.lat == null || ac.lon == null || ac.destLat == null || ac.destLon == null) return;
    if (!routePlausible(ac, cfg)) return;
    const brg = bearing(ac.lat, ac.lon, ac.destLat, ac.destLon) * (Math.PI / 180);
    const stepM = cfg.radiusMiles * 1609.34 * 0.5;
    const ahead = project(
      { east: v.m.east + Math.sin(brg) * stepM, north: v.m.north + Math.cos(brg) * stepM },
      proj,
    );
    const dx = ahead.x - v.p.x;
    const dy = ahead.y - v.p.y;
    const len = Math.hypot(dx, dy) || 1;
    const L = Math.min(this.w, this.h) * 0.24;
    const ex = v.p.x + (dx / len) * L;
    const ey = v.p.y + (dy / len) * L;
    const ctx = this.ctx;
    ctx.save();
    const grad = ctx.createLinearGradient(v.p.x, v.p.y, ex, ey);
    grad.addColorStop(0, rgba(v.color, 0.32 * v.alpha));
    grad.addColorStop(1, rgba(v.color, 0));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.3;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(v.p.x, v.p.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
  }

  // --- comet trail ---
  private drawTrail(cfg: Config, proj: ProjOpts, v: Visible, tt: number): void {
    if (cfg.trailSeconds <= 0) return;
    const ctx = this.ctx;
    const h = v.tr.history;
    if (h.length < 2) return;

    // Build the polyline from real fixes within the window, ending at the head.
    const windowMs = cfg.trailSeconds * 1000;
    const pts: { p: Point; age: number }[] = [];
    for (const s of h) {
      if (s.t < tt - windowMs || s.t > tt) continue;
      pts.push({ p: project(s.m, proj), age: (tt - s.t) / windowMs });
    }
    pts.push({ p: v.p, age: 0 });
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = 1 - b.age; // 1 at head, 0 at tail
      ctx.strokeStyle = rgba(v.color, 0.55 * f * v.alpha);
      ctx.lineWidth = 0.7 + 2.2 * f * (cfg.glyphSizePx / 14);
      ctx.beginPath();
      ctx.moveTo(a.p.x, a.p.y);
      ctx.lineTo(b.p.x, b.p.y);
      ctx.stroke();
    }
    ctx.restore();
  }

private getLandingQueue(cfg: Config): Aircraft[] {
  const arrivals: Aircraft[] = [];

  for (const tr of this.tracks.values()) {
    const ac = tr.ac;

    if (ac.onGround) continue;
    if (ac.lat == null || ac.lon == null) continue;

    const op = this.classifyOperation(ac, cfg);
    if (op !== "arrival") continue;

    const dist = greatCircleMiles(
      cfg.centerLat,
      cfg.centerLon,
      ac.lat,
      ac.lon,
    );

    if (dist > 45) continue;

    arrivals.push(ac);
  }

  return arrivals
    .sort((a, b) => {
      const da = greatCircleMiles(cfg.centerLat, cfg.centerLon, a.lat!, a.lon!);
      const db = greatCircleMiles(cfg.centerLat, cfg.centerLon, b.lat!, b.lon!);
      return da - db;
    })
    .slice(0, 5);
}

private drawLandingQueue(cfg: Config): void {
  if (!cfg.showLandingQueue) return;

  const queue = this.getLandingQueue(cfg);
  if (!queue.length) return;

  const ctx = this.ctx;

  ctx.save();

  let y = cfg.showHud ? 78 : 52;

  ctx.font = `600 11px ${cfg.fonts.label}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = rgba([120, 255, 160], 0.95 * cfg.brightness);
  ctx.fillText("LANDING QUEUE", 16, y);

  y += 16;

  ctx.font = `500 11px ${cfg.fonts.label}`;

  for (let i = 0; i < queue.length; i++) {
    const ac = queue[i];

    const dist = greatCircleMiles(
      cfg.centerLat,
      cfg.centerLon,
      ac.lat!,
      ac.lon!,
    );

    const label = ac.flight?.trim() || ac.hex.toUpperCase();

    ctx.fillStyle = rgba([245, 247, 255], 0.86 * cfg.brightness);

    ctx.fillText(
      `${i + 1}. ${label}  ${dist.toFixed(1)} NM`,
      16,
      y,
    );

    y += 14;
  }

  ctx.restore();
}

private drawSurfaceStateTag(
  cfg: Config,
  v: Visible,
): void {
  const state = v.tr.surfaceState;

  if (
    state !== "landing_roll" &&
    state !== "departure_roll"
  ) {
    return;
  }

  const text =
    state === "landing_roll"
      ? "LANDING ROLL"
      : "TAKEOFF ROLL";

  const ctx = this.ctx;

  ctx.save();
  ctx.font = `600 10px ${cfg.fonts.label}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle =
  state === "landing_roll"
    ? rgba([120, 255, 160], 1)
    : rgba([90, 210, 255], 1);
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 5;

  ctx.fillText(
    text,
    v.p.x,
    v.p.y + cfg.glyphSizePx + 18,
  );

  ctx.restore();
}

  // --- glyph: type-aware luminous silhouette ---
  private drawGlyph(cfg: Config, v: Visible): void {
    const ctx = this.ctx;
    const color = v.emergency ? hexToRgb(cfg.palette.warn) : v.color;
    const kind = classifyGlyph(v.tr.ac);
    let zoomScale = 1;



if (cfg.radiusMiles <= 3.5) {
  zoomScale = 0.6;
}

const s =
  cfg.glyphSizePx *
  GLYPH_SCALE[kind] *
  zoomScale;

    ctx.save();
    ctx.translate(v.p.x, v.p.y);
    ctx.rotate(v.heading + Math.PI / 2);

    // Soft halo — restrained so the silhouette reads as an aircraft.
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.7);
    halo.addColorStop(0, rgba(color, 0.16 * v.alpha));
    halo.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, s * 1.7, 0, Math.PI * 2);
    ctx.fill();

    drawAircraftGlyph(ctx, kind, s, color, v.alpha, this.frameT, hexSeed(v.tr.ac.hex));
    ctx.restore();
  }

  // --- labels: restrained typography, nearest only ---
  private placedBoxes: { x: number; y: number; w: number; h: number }[] = [];

  private drawLabels(cfg: Config, nearestFirst: Visible[]): void {
    const limit =
      cfg.labelDensity === "all"
        ? nearestFirst.length
        : cfg.labelDensity === "nearestN"
          ? cfg.nearestN
          : 1;
    this.placedBoxes = [];
    for (let i = 0; i < Math.min(limit, nearestFirst.length); i++) {
      // Nearest labels brightest; gently dim further ones (but keep readable).
      const prom = 1 - i / Math.max(1, nearestFirst.length);
      this.drawLabel(cfg, nearestFirst[i], 0.7 + 0.3 * prom);
    }
  }

  private measureLabel(
    cfg: Config,
    lines: { text: string; kind: "title" | "sub" }[],
  ): { w: number; lh: number; h: number } {
    const ctx = this.ctx;
    const lh = 16;
    let w = 0;
    for (const ln of lines) {
      ctx.font = ln.kind === "title" ? `500 14px ${cfg.fonts.label}` : `400 11px ${cfg.fonts.label}`;
      try {
        ctx.letterSpacing = ln.kind === "title" ? "1.5px" : "0.5px";
      } catch {
        /* noop */
      }
      w = Math.max(w, ctx.measureText(ln.text).width);
    }
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }
    return { w: w + 2, lh, h: lines.length * lh };
  }

  private collides(b: { x: number; y: number; w: number; h: number }): boolean {
    const pad = 3;
    for (const p of this.placedBoxes) {
      if (
        b.x - pad < p.x + p.w &&
        b.x + b.w + pad > p.x &&
        b.y - pad < p.y + p.h &&
        b.y + b.h + pad > p.y
      ) {
        return true;
      }
    }
    return false;
  }


  private isNightAtAirport(cfg: Config): boolean {
  //const hour = new Date().getHours();
  //return hour >= 19 || hour < 6;
  return true
}

  private labelLines(cfg: Config, ac: Aircraft): { text: string; kind: "title" | "sub" }[] {
    const f = cfg.showFields;
    const out: { text: string; kind: "title" | "sub" }[] = [];
    let title = f.flight
  ? ac.flight ?? ac.hex.toUpperCase()
  : ac.airline;

if (
  cfg.showAirlineNames &&
  f.flight &&
  ac.airline
) {
  title = `${title} · ${ac.airline}`;
}
    if (title) out.push({ text: title, kind: "title" });

    const sub: string[] = [];
    if (f.type && (ac.typeName || ac.typeCode)) sub.push(ac.typeName ?? ac.typeCode!);
    const alt = ac.altBaro ?? ac.altGeom;
    if (f.altitude) {
      if (ac.onGround) sub.push("GND");
      else if (alt != null) sub.push(`${alt.toLocaleString("en-US")} ft`);
    }
    if (f.speed && ac.gs != null) sub.push(`${Math.round(ac.gs)} kt`);
    if (sub.length) out.push({ text: sub.join("   "), kind: "sub" });

    if (f.destination && ac.destination && routePlausible(ac, cfg)) {
      const head = ac.origin ? `${ac.origin} → ${ac.destination}` : `→ ${ac.destination}`;
      out.push({ text: ac.destName ? `${head}   ${ac.destName}` : head, kind: "sub" });
      if (cfg.showRouteDetail && ac.destLat != null && ac.destLon != null) {
        const bits: string[] = [`${localTimeAt(ac.destLat, ac.destLon)} local`];
        if (ac.lat != null && ac.lon != null) {
          const mi = Math.round(greatCircleMiles(ac.lat, ac.lon, ac.destLat, ac.destLon));
          if (mi > 1) bits.push(`${mi.toLocaleString("en-US")} mi to go`);
        }
        out.push({ text: bits.join("   ·   "), kind: "sub" });
      }
    }
    if (f.registration && ac.registration) out.push({ text: ac.registration, kind: "sub" });
    return out;
  }

  private drawLabel(cfg: Config, v: Visible, strength: number): void {
    const ctx = this.ctx;
    const lines = this.labelLines(cfg, v.tr.ac);
    if (!lines.length) return;
    const a = v.alpha * strength;
    if (a < 0.04) return;

    const { w, lh, h } = this.measureLabel(cfg, lines);
    const gap = cfg.glyphSizePx * 0.7 + 9;
    const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
      b.x >= 6 && b.x + b.w <= this.w - 6 && b.y >= 6 && b.y + b.h <= this.h - 6;

    // Try four quadrants, then nudge downward, to avoid overlapping other labels.
    const candidates = [
      { x: v.p.x + gap, y: v.p.y - gap - h },
      { x: v.p.x + gap, y: v.p.y + gap },
      { x: v.p.x - gap - w, y: v.p.y - gap - h },
      { x: v.p.x - gap - w, y: v.p.y + gap },
    ];
    let box: { x: number; y: number; w: number; h: number } | null = null;
    for (const c of candidates) {
      const b = { x: c.x, y: c.y, w, h };
      if (onScreen(b) && !this.collides(b)) {
        box = b;
        break;
      }
    }
    if (!box) {
      let b = { x: v.p.x + gap, y: v.p.y - gap - h, w, h };
      for (let k = 0; k < 9 && (this.collides(b) || !onScreen(b)); k++) {
        b = { ...b, y: b.y + lh + 2 };
      }
      box = b;
    }
    box.x = Math.max(6, Math.min(box.x, this.w - 6 - w));
    box.y = Math.max(6, Math.min(box.y, this.h - 6 - h));
    this.placedBoxes.push(box);

    // Hairline leader from glyph to the nearest edge of the label.
    const anchorX = box.x + w / 2 < v.p.x ? box.x + w : box.x;
    const anchorY = Math.max(box.y, Math.min(v.p.y, box.y + h));
    // Rotate the whole label (leader + text) around the glyph so it reads
    // upright from where you lie, without disturbing the field.
    this.withLabelRotation(cfg, v.p.x, v.p.y, () => {
      ctx.save();
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.text), 0.24 * a);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(v.p.x, v.p.y);
      ctx.lineTo(anchorX, anchorY);
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 6;
      let y = box.y;
      for (const ln of lines) {
        if (ln.kind === "title") {
          ctx.font = `500 14px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba([245, 247, 255], a);
          try {
            ctx.letterSpacing = "1.5px";
          } catch {
            /* noop */
          }
        } else {
          ctx.font = `400 11px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.82 * a);
          try {
            ctx.letterSpacing = "0.5px";
          } catch {
            /* noop */
          }
        }
        ctx.fillText(ln.text, box.x, y);
        y += lh;
      }
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    });
  }

  private drawDetailPanel(cfg: Config, v: Visible): void {
    const ac = v.tr.ac;
    const x = 40;
    const y = this.h - 120;
    this.withLabelRotation(cfg, x, y, () => this.drawDetailPanelText(cfg, v, ac, x, y));
  }

  private drawDetailPanelText(cfg: Config, v: Visible, ac: Aircraft, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    try {
      ctx.letterSpacing = "2px";
    } catch {
      /* noop */
    }
    ctx.font = `300 34px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba([245, 247, 255], v.alpha);
    ctx.fillText(ac.flight ?? ac.hex.toUpperCase(), x, y);
    try {
      ctx.letterSpacing = "0.5px";
    } catch {
      /* noop */
    }
    ctx.font = `400 15px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.85 * v.alpha);
    const dpAlt = ac.altBaro ?? ac.altGeom;
    const bits = [
      ac.airline,
      ac.typeName ?? ac.typeCode,
      ac.onGround ? "on ground" : dpAlt != null ? `${dpAlt.toLocaleString("en-US")} ft` : null,
      ac.gs != null ? `${Math.round(ac.gs)} kt` : null,
      ac.origin && ac.destination && routePlausible(ac, cfg) ? `${ac.origin} → ${ac.destination}` : null,
    ].filter(Boolean);
    ctx.fillText(bits.join("    ·    "), x, y + 26);
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }
    ctx.restore();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Stable per-aircraft phase offset (0..2π) so props/rotors aren't all in sync. */
function hexSeed(hex: string): number {
  let n = 0;
  for (let i = 0; i < hex.length; i++) n = (n * 31 + hex.charCodeAt(i)) % 360;
  return (n / 360) * Math.PI * 2;
}

const DEG = Math.PI / 180;

/** Initial great-circle bearing (deg from North) from point 1 to point 2. */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lon2 - lon1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Great-circle distance in statute miles. */
function greatCircleMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dφ = (lat2 - lat1) * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Longitude-based mean solar time at a place (no DST/tz db) as HH:MM. */
function localTimeAt(
  lat: number | undefined,
  lon: number | undefined,
): string {
  if (lat != null && lon != null) {
    try {
      const timeZone = tzLookup(lat, lon);

      return new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
    } catch {
      // fall through to solar fallback
    }
  }

  if (lon == null) return "--:--";

  const now = new Date();
  const utcMin =
    now.getUTCHours() * 60 +
    now.getUTCMinutes();

  let m = (utcMin + (lon / 15) * 60) % 1440;

  if (m < 0) m += 1440;

  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Cross-track distance (miles) of a point from the great circle p1→p2. */
function crossTrackMiles(
  lat: number, lon: number,
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 3958.8;
  const d13 = greatCircleMiles(lat1, lon1, lat, lon) / R; // angular (rad)
  const θ13 = bearing(lat1, lon1, lat, lon) * DEG;
  const θ12 = bearing(lat1, lon1, lat2, lon2) * DEG;
  return Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12)) * R;
}

/**
 * Is the adsbdb route consistent with where the plane actually is and what it's
 * doing? adsbdb returns the scheduled route for a callsign, which is sometimes
 * the wrong leg. We reject a route if:
 *  (a) it's geographically impossible — the plane is neither near an endpoint
 *      nor roughly on the great-circle path; or
 *  (b) the plane's vertical trend disagrees — a climbing plane near you just
 *      departed the local airport (so that should be the origin); a descending
 *      one is arriving (the destination).
 */
function routePlausible(ac: Aircraft, cfg: Config): boolean {
  if (ac.lat == null || ac.lon == null) return true;
  const haveCoords = ac.originLat != null || ac.destLat != null;
  if (!haveCoords) return true; // legacy cache without coords — don't hide

  // (a) geographic consistency
  const nearPlane = (la?: number, lo?: number) =>
    la != null && lo != null && greatCircleMiles(ac.lat!, ac.lon!, la, lo) < 80;
  let geomOk = nearPlane(ac.originLat, ac.originLon) || nearPlane(ac.destLat, ac.destLon);
  if (
    !geomOk &&
    ac.originLat != null && ac.originLon != null &&
    ac.destLat != null && ac.destLon != null
  ) {
    geomOk = Math.abs(crossTrackMiles(ac.lat, ac.lon, ac.originLat, ac.originLon, ac.destLat, ac.destLon)) < 130;
  } else if (!geomOk && (ac.originLat == null || ac.destLat == null)) {
    geomOk = true; // only one endpoint known and not near — can't judge, allow
  }
  if (!geomOk) return false;

  // (b) vertical-trend consistency for low, nearby traffic
  const alt = ac.altBaro ?? ac.altGeom;
  const localTraffic = greatCircleMiles(ac.lat, ac.lon, cfg.centerLat, cfg.centerLon) < 30;
  const localAirport = (la?: number, lo?: number) =>
    la != null && lo != null && greatCircleMiles(cfg.centerLat, cfg.centerLon, la, lo) < 45;
  if (localTraffic && alt != null && alt < 12000 && ac.baroRate != null && Math.abs(ac.baroRate) > 250) {
    if (ac.baroRate > 0) {
      if (ac.originLat != null && !localAirport(ac.originLat, ac.originLon)) return false; // departing
    } else {
      if (ac.destLat != null && !localAirport(ac.destLat, ac.destLon)) return false; // arriving
    }
  }
  return true;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}
