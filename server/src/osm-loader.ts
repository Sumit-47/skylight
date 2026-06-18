import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadGeometry(
  icao: string
) {
  const path = resolve(
    __dirname,
    "../data/osm",
    `${icao}.geojson`
  );

  console.log("Loading geometry:", path);

  const raw = await readFile(path, "utf8");

  return JSON.parse(raw);
}