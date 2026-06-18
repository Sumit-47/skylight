// Entry point. Wires the config store, data poller, WebSocket hub, REST API,
// and (in production) serves the built web app. Binds 0.0.0.0 so the control
// panel is reachable from your phone on the LAN.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import type { DataSource } from "@shared/index.js";
import { ConfigStore } from "./config-store.js";
import { RouteEnricher } from "./enrich/routes.js";
import { Poller } from "./datasource.js";
import { Hub } from "./hub.js";
import { TleStore } from "./tle.js";
import { loadAirports } from "./airport-loader.js";
import { AirportService } from "./airport-service.js";
import { loadGeometry } from "./osm-loader.js";
import { getMetar } from "./metar-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const WEB_DIST = resolve(__dirname, "../../web/dist");

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SOURCE = (process.env.DATA_SOURCE as DataSource) ?? "radio";
const RADIO_URL =
  process.env.AIRCRAFT_JSON_URL ?? "http://localhost:8080/data/aircraft.json";
const API_URL =
  process.env.API_URL ?? "https://api.airplanes.live/v2/point/{lat}/{lon}/{r}";
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const ROUTE_CACHE_HOURS = Number(process.env.ROUTE_CACHE_HOURS ?? 12);
// When on radio, also poll the API and merge (keeps landing aircraft alive).
const SUPPLEMENT_API = (process.env.SUPPLEMENT_API ?? "1") !== "0";
const API_POLL_MS = Number(process.env.API_POLL_MS ?? 4000);

async function main(): Promise<void> {

  const airports = await loadAirports();
  const airportService =
    new AirportService(airports);

  const nearest =
  airportService.findNearestAirport(
    19.0896,
    72.8656
  );

console.log("Nearest:", nearest?.icao);
  console.log("Airport Count:", airports.size);

  const vabb = airports.get("VABB");

console.log(
  "VABB Runway Count:",
  vabb?.runways.length
);

console.log(
  "First Runway:",
  vabb?.runways[0]
);

  const store = new ConfigStore(resolve(DATA_DIR, "config.json"));
  await store.load();

  const enricher = new RouteEnricher(
    resolve(DATA_DIR, "route-cache.json"),
    ROUTE_CACHE_HOURS,
  );
  await enricher.load();

  const tleStore = new TleStore(resolve(DATA_DIR, "tle-cache.json"));
  await tleStore.load();

  const app = express();
  app.use(express.json());

  const server = createServer(app);
  const hub = new Hub(server, {
    store,
    getSnapshot: () => poller.getSnapshot(),
    getStatus: () => poller.getStatus(),
  });

  const poller = new Poller({
    source: SOURCE,
    radioUrl: RADIO_URL,
    apiUrlTemplate: API_URL,
    pollMs: POLL_MS,
    supplementApi: SUPPLEMENT_API,
    apiPollMs: API_POLL_MS,
    getConfig: () => store.get(),
    enricher,
    onSnapshot: (now, aircraft) => hub.broadcastAircraft(now, aircraft),
    onStatus: (status) => hub.broadcastStatus(status),
  });


  //const hub = new Hub(server, {
  //  store,
  //  getSnapshot: () => poller.getSnapshot(),
  //  getStatus: () => poller.getStatus(),
  //});

  // --- REST API (handy for debugging + non-WS clients) ---
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) => res.json(store.get()));
  app.post("/api/config", (req, res) => res.json(store.patch(req.body)));
  app.post("/api/config/reset", (_req, res) => res.json(store.reset()));
  app.get("/api/aircraft", (_req, res) => res.json(poller.getSnapshot()));
  app.get("/api/status", (_req, res) => res.json(poller.getStatus()));
  app.get("/api/tle", async (_req, res) => res.json(await tleStore.get()));
  app.get("/api/metar", async (req, res) => {
  try {
    const icao = String(req.query.icao ?? "");

    if (!icao) {
      res.status(400).json({ error: "Missing ICAO code" });
      return;
    }

    const metar = await getMetar(icao);

    if (!metar) {
      res.status(404).json({ error: `No METAR found for ${icao}` });
      return;
    }

    res.json(metar);
  } catch (err) {
    console.error("[api/metar]", err);
    res.status(500).json({ error: "Failed to load METAR" });
  }
});

  
  
//  app.get("/api/airport-geometry", async (req, res) => {
//  try {
//    const icao = String(req.query.icao || "").toUpperCase();
//
  //  if (!icao) {
    //  return res.status(400).json({ error: "Missing ICAO" });
    //}
//
//    const geometry = await loadGeometry(icao);
//
//    if (!geometry) {
//      return res.status(404).json({ error: `No geometry found for ${icao}` });
//    }
//
//    res.json(geometry);
//  } catch (err) {
//    console.error("Airport geometry error:", err);
//    res.status(500).json({ error: "Failed to load airport geometry" });
//  }
//});

 app.get("/api/location-search", (req, res) => {
  const q = String(req.query.q ?? "").trim().toUpperCase();

  if (!q) {
    return res.status(400).json({ error: "Missing query" });
  }

  const airportsList = [...airports.values()];

  const match =
    airportsList.find((a) => a.icao === q) ??
    airportsList.find((a) =>
      a.name.toUpperCase().includes(q)
    );

  if (!match) {
    return res.status(404).json({
      error: `No location found for ${q}`,
    });
  }

  res.json({
    name: match.name,
    lat: match.lat,
    lon: match.lon,
    icao: match.icao,
  });
});

app.get("/api/airport", (_req, res) => {
  try {
    const cfg = store.get();

    const airports =
      airportService.findAirportsWithinRadius(
        cfg.centerLat,
        cfg.centerLon,
        Math.max(cfg.radiusMiles, 75)
      );

    console.log(
      "Nearby airports:",
      airports.map((a) => a.icao)
    );

    const airport =
      airports.find((a) => {
        const path = resolve(
          DATA_DIR,
          "osm",
          `${a.icao}.geojson`
        );

        const hasGeoJson = existsSync(path);

        console.log(
          "Checking geometry:",
          a.icao,
          path,
          hasGeoJson
        );

        return hasGeoJson;
      }) ?? airports[0];

    if (!airport) {
      return res.status(404).json({
        error: "No airport found",
      });
    }

    console.log("Selected airport:", airport.icao);

    res.json(airport);
  } catch (err) {
    console.error("Airport lookup failed:", err);

    res.status(500).json({
      error: "Failed to resolve airport",
    });
  }
});


app.get("/api/airports", (_req, res) => {
  try {
    const cfg = store.get();

    const airports =
      airportService.findAirportsWithinRadius(
        cfg.centerLat,
        cfg.centerLon,
        Math.max(cfg.radiusMiles, 75)
      );

    res.json(airports);
  } catch (err) {
    console.error("Nearby airports failed:", err);

    res.status(500).json({
      error: "Failed to resolve nearby airports",
    });
  }
});

app.get("/api/airport-geometry", async (req, res) => {
  try {
    const icao = String(req.query.icao || "").toUpperCase();

    if (!icao) {
      return res.status(400).json({
        error: "Missing ICAO",
      });
    }

    const geometry = await loadGeometry(icao);

    if (!geometry) {
      return res.status(404).json({
        error: `No geometry found for ${icao}`,
      });
    }

    res.json(geometry);
  } catch (err) {
    console.error("Airport geometry failed:", err);

    res.status(500).json({
      error: "Failed to load airport geometry",
    });
  }
});


  app.post("/api/source", (req, res) => {
    const s = req.body?.source;
    if (s !== "radio" && s !== "api") {
      return res.status(400).json({ error: "source must be 'radio' or 'api'" });
    }
    poller.setSource(s);
    res.json(poller.getStatus());
  });

  // --- static web (production build) ---
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get("/control", (_req, res) => res.sendFile(resolve(WEB_DIST, "control.html")));
    app.get("/", (_req, res) => res.sendFile(resolve(WEB_DIST, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res
        .type("text/plain")
        .send("Web build not found. Run `npm run build`, or use the Vite dev server."),
    );
  }

  poller.start();

  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] data source: ${SOURCE} (${SOURCE === "radio" ? RADIO_URL : API_URL})`);
    console.log(`[server] control panel: http://<this-host>:${PORT}/control`);
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
