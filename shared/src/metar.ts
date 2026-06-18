export interface MetarInfo {
  icao: string;
  raw: string;
  observed?: string;

  windDirDeg?: number;
  windSpeedKt?: number;
  windGustKt?: number;

  visibilityMeters?: number;

  weather: string[];

  tempC?: number;
  dewpointC?: number;
  qnhHpa?: number;
}