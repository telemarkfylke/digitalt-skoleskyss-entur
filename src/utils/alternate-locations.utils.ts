/**
 * SELECT-list fragment exposing a work placement ("Utplassering") as a `HasAlternateLocations` flag.
 *
 * 1 when `$.AlternateLocations.Locations` holds at least one object ([type] = 5), otherwise 0 —
 * covers `null`, `[]`, a missing path and a NULL/invalid OrderBundle. A scalar keeps the monitor's
 * compareColumns check stable; raw JSON would fire on any bundle edit.
 *
 * No parameters, so it never shifts the positional @paramN slots. The `o` alias is dbo.Orders.
 */
export const ALTERNATE_LOCATIONS_FLAG_SQL = `,
          -- Utplassering: extended timeband while Locations holds an object.
          CASE WHEN ISJSON(o.OrderBundle) = 1 AND EXISTS (
            SELECT 1 FROM OPENJSON(o.OrderBundle, '$.AlternateLocations.Locations') WHERE [type] = 5
          ) THEN 1 ELSE 0 END AS HasAlternateLocations`;

export interface HasAlternateLocationsFlag {
  HasAlternateLocations?: number | boolean | null;
}

// Truthy rather than === 1: mssql may return the flag as a number or a boolean.
export const hasAlternateLocations = (record: HasAlternateLocationsFlag): boolean =>
  Boolean(record.HasAlternateLocations);
