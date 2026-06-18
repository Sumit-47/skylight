import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number];
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  runways: Runway[];
}

interface AirportCsvRow {
  ident: string;
  name: string;
  latitude_deg: string;
  longitude_deg: string;
}

interface RunwayCsvRow {
  airport_ident: string;
  le_ident: string;
  he_ident: string;
  le_latitude_deg: string;
  le_longitude_deg: string;
  he_latitude_deg: string;
  he_longitude_deg: string;
  width_ft: string;
}

export async function loadAirports() {

 const csv = await readFile(
  resolve(__dirname, "../data/ourairports/airports.csv"),
  "utf8"
);

  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
  }) as AirportCsvRow[];

  const airports = new Map<string, Airport>();

  for (const row of rows) {

    airports.set(row.ident, {
      icao: row.ident,
      name: row.name,
      lat: Number(row.latitude_deg),
      lon: Number(row.longitude_deg),
      runways: [],
    });

  }

  const runwayCsv = await readFile(
  resolve(__dirname, "../data/ourairports/runways.csv"),
  "utf8"
);

const runwayRows = parse(runwayCsv, {
  columns: true,
  skip_empty_lines: true,
}) as RunwayCsvRow[];

for (const row of runwayRows) {

  const airport = airports.get(row.airport_ident);

  if (!airport) continue;

  if (
    !row.le_latitude_deg ||
    !row.le_longitude_deg ||
    !row.he_latitude_deg ||
    !row.he_longitude_deg
  ) {
    continue;
  }

  airport.runways.push({
    leIdent: row.le_ident,
    heIdent: row.he_ident,
    le: [
      Number(row.le_latitude_deg),
      Number(row.le_longitude_deg)
    ],
    he: [
      Number(row.he_latitude_deg),
      Number(row.he_longitude_deg)
    ],
    widthFt: Number(row.width_ft || 150)
  });

}

  return airports;
}