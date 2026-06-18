import type { Airport } from "./airport-loader.js";

export class AirportService {
  constructor(
    private airports: Map<string, Airport>
  ) {}

  findNearestAirport(
    lat: number,
    lon: number
  ): Airport | null {
    const nearby = this.findAirportsWithinRadius(
      lat,
      lon,
      75
    );

    return nearby[0] ?? null;
  }

  findAirportsWithinRadius(
    lat: number,
    lon: number,
    radiusMiles: number
  ): Airport[] {
    const results: {
      airport: Airport;
      distanceMiles: number;
    }[] = [];

    for (const airport of this.airports.values()) {
      const distanceMiles =
        this.distanceMiles(
          lat,
          lon,
          airport.lat,
          airport.lon
        );

      if (distanceMiles <= radiusMiles) {
        results.push({
          airport,
          distanceMiles,
        });
      }
    }

    results.sort(
      (a, b) => a.distanceMiles - b.distanceMiles
    );

    return results.map((r) => r.airport);
  }

  private distanceMiles(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 3958.8;
    const dLat = this.degToRad(lat2 - lat1);
    const dLon = this.degToRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.degToRad(lat1)) *
        Math.cos(this.degToRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return (
      2 *
      R *
      Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
      )
    );
  }

  private degToRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }
}