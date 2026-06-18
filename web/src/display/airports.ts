// Bundled airport geometry, drawn at true geographic position so departures and
// arrivals visibly line up with the runways. Coordinates from OurAirports (KSFO).

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface Airport {
  icao: string;
  name: string;
  runways: Runway[];
}

export const SFO: Airport = {
  icao: "KSFO",
  name: "SFO",
  runways: [
    { leIdent: "10L", heIdent: "28R", le: [37.628742, -122.39341], he: [37.613538, -122.35716], widthFt: 200 },
    { leIdent: "10R", heIdent: "28L", le: [37.626298, -122.393124], he: [37.61172, -122.358367], widthFt: 200 },
    { leIdent: "1L", heIdent: "19R", le: [37.607898, -122.38295], he: [37.626476, -122.37063], widthFt: 200 },
    { leIdent: "1R", heIdent: "19L", le: [37.606333, -122.381061], he: [37.627346, -122.367124], widthFt: 200 },
  ],
};


export const VABB: Airport = {
  icao: "VABB",
  name: "Mumbai",
  runways: [
    {
      leIdent: "09",
      heIdent: "27",
      le: [19.0967, 72.8506],
      he: [19.0969, 72.8822],
      widthFt: 148
    },
    {
      leIdent: "14",
      heIdent: "32",
      le: [19.0820, 72.8579],
      he: [19.1026, 72.8767],
      widthFt: 148
    }
  ]
};

/** Airports drawn on the map (currently just SFO; easy to extend). */
export const AIRPORTS: Airport[] = [SFO,VABB];
