export interface AirportGeometryFeature {
  type: "Feature";
  properties?: {
    aeroway?: string;
    name?: string;
    [key: string]: unknown;
  };
  geometry: {
  type:
    | "Point"
    | "LineString"
    | "Polygon"
    | "MultiPolygon";
  coordinates: unknown;
};
}

export interface AirportGeometry {
  type: "FeatureCollection";
  features: AirportGeometryFeature[];
}