// server/src/metar-service.ts
import type { MetarInfo } from "../../shared/src/metar.js";

const METAR_BASE_URL = "https://aviationweather.gov/api/data/metar";

interface AviationWeatherMetar {
  rawOb?: string;
  raw_text?: string;
  reportTime?: string;
  obsTime?: string;
  name?: string;
  icaoId?: string;
}

export async function getMetar(icao: string): Promise<MetarInfo | null> {
  const id = icao.trim().toUpperCase();

  if (!id) return null;

  const url = `${METAR_BASE_URL}?ids=${encodeURIComponent(id)}&format=json`;

  const res = await fetch(url);

  if (!res.ok) {
    console.warn(`[metar] Failed to fetch METAR for ${id}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as AviationWeatherMetar[];

  if (!Array.isArray(data) || data.length === 0) {
    console.warn(`[metar] No METAR found for ${id}`);
    return null;
  }

  const item = data[0];
  const raw = item.rawOb ?? item.raw_text ?? "";

  if (!raw) return null;

  return parseMetar(id, raw, item.reportTime ?? item.obsTime);
}

export function parseMetar(
  icao: string,
  raw: string,
  observed?: string
): MetarInfo {
  const tokens = raw.split(/\s+/);

  const info: MetarInfo = {
    icao,
    raw,
    observed,
    weather: [],
  };

  for (const token of tokens) {
    parseWind(token, info);
    parseVisibility(token, info);
    parseTempDewpoint(token, info);
    parseQnh(token, info);
    parseWeather(token, info);
  }

  return info;
}

function parseWind(token: string, info: MetarInfo): void {
  const match = token.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/);

  if (!match) return;

  const dir = match[1];

  if (dir !== "VRB") {
    info.windDirDeg = Number(dir);
  }

  info.windSpeedKt = Number(match[2]);

  if (match[4]) {
    info.windGustKt = Number(match[4]);
  }
}

function parseVisibility(token: string, info: MetarInfo): void {
  // Common international METAR visibility format: 4000, 9999
  if (/^\d{4}$/.test(token)) {
    const meters = Number(token);
    info.visibilityMeters = meters === 9999 ? 10000 : meters;
  }
}

function parseTempDewpoint(token: string, info: MetarInfo): void {
  const match = token.match(/^(M?\d{2})\/(M?\d{2})$/);

  if (!match) return;

  info.tempC = parseSignedTemp(match[1]);
  info.dewpointC = parseSignedTemp(match[2]);
}

function parseSignedTemp(value: string): number {
  if (value.startsWith("M")) {
    return -Number(value.slice(1));
  }

  return Number(value);
}

function parseQnh(token: string, info: MetarInfo): void {
  const match = token.match(/^Q(\d{4})$/);

  if (!match) return;

  info.qnhHpa = Number(match[1]);
}

function parseWeather(token: string, info: MetarInfo): void {
  // Basic weather codes useful for visual ambience
  const weatherCodes = [
    "RA",
    "DZ",
    "TS",
    "BR",
    "FG",
    "HZ",
    "FU",
    "SN",
    "SHRA",
    "VCTS",
  ];

  const cleaned = token.replace(/^[-+]/, "");

  if (weatherCodes.includes(cleaned)) {
    info.weather.push(cleaned);
  }
}