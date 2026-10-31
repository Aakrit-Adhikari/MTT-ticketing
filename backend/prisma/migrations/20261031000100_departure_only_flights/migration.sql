-- A route flight may now be entered with a departure time only (arrival is optional).
ALTER TABLE "Flight" DROP CONSTRAINT "flight_kind";
ALTER TABLE "Flight" ADD CONSTRAINT "flight_kind" CHECK (
  ("sectorId" IS NULL AND "originId" IS NOT NULL AND "destinationId" IS NOT NULL)
  OR ("sectorId" IS NOT NULL AND "originId" IS NULL AND "destinationId" IS NULL AND "arrivalAt" IS NULL)
);
