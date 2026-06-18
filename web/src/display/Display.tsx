import { useEffect, useRef } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { Renderer } from "./renderer.js";
import type { Airport, AirportGeometry } from "@shared/index.js";
import type { MetarInfo } from "@shared/index.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

export function Display() {
  const { state, conn } = useStream("display");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);

  // Keep the latest config in a ref so the RAF loop always reads fresh values.
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
const airportsRef = useRef<Airport[]>([]);
const geometriesRef = useRef<AirportGeometry[]>([]);
  const metarRef = useRef<MetarInfo | null>(null);
  //const geometryRef = useRef<AirportGeometry | null>(null);

  configRef.current = state.config ?? DEFAULT_CONFIG;

  // Create renderer once.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new Renderer(
  canvasRef.current,
  () => configRef.current,
  () => airportsRef.current,
  () => geometriesRef.current,
  () => metarRef.current
);
    rendererRef.current = r;
    r.start();
    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.stop();
      rendererRef.current = null;
    };
  }, []);


async function loadMetar(icao: string) {
  try {
    const res = await fetch(`/api/metar?icao=${encodeURIComponent(icao)}`);

    if (!res.ok) {
      metarRef.current = null;
      return;
    }

    metarRef.current = await res.json();
  } catch (err) {
    console.warn("[display] Failed to load METAR", err);
    metarRef.current = null;
  }
}

  useEffect(() => {
  async function loadAirportsAndGeometries() {
    try {
      const airportsResponse = await fetch("/api/airports");

      if (!airportsResponse.ok) {
        throw new Error(`Airports HTTP ${airportsResponse.status}`);
      }

      const airports = await airportsResponse.json() as Airport[];
      airportsRef.current = airports;

      const primaryAirport = airports[0];

if (primaryAirport) {
  void loadMetar(primaryAirport.icao);
} else {
  metarRef.current = null;
}

      console.log("Airports Loaded:", airports.map((a) => a.icao));

      const geometries: AirportGeometry[] = [];

      for (const airport of airports) {
        try {
          const geometryResponse = await fetch(
            `/api/airport-geometry?icao=${airport.icao}`
          );

          if (!geometryResponse.ok) {
            continue;
          }

          const geometry = await geometryResponse.json() as AirportGeometry;
          geometries.push(geometry);
        } catch {
          // skip airports without geometry
        }
      }

      geometriesRef.current = geometries;

      console.log(
        "Airport Geometries Loaded:",
        geometries.length
      );
    } catch (err) {
      console.error("Failed loading airports / geometries", err);
      airportsRef.current = [];
      geometriesRef.current = [];
    }
  }

  void loadAirportsAndGeometries();
}, [
  state.config?.centerLat,
  state.config?.centerLon,
  state.config?.radiusMiles,
]);
  // Feed snapshots.
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  // Keyboard calibration (handy when a keyboard is plugged into the Pi).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "r":
          conn.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 });
          break;
        case "R":
          conn.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 });
          break;
        case "m":
          conn.patchConfig({ mirrorX: !c.mirrorX });
          break;
        case "M":
          conn.patchConfig({ mirrorY: !c.mirrorY });
          break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[":
          conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          conn.patchConfig({ showHud: !c.showHud });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const cfg = state.config;
  return (
    <div className="display-root">
      <canvas ref={canvasRef} className="display-canvas" />
      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {cfg.radiusMiles}mi · {cfg.theme}
          </span>
        </div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
    </div>
  );
}
