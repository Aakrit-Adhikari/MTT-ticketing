import { Type } from 'class-transformer';
import { FlightStatus, TripType } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateFlightDto {
  @IsUUID() airlineId!: string;
  @Matches(/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/, { message: 'flightNumber looks invalid (e.g. RA 301)' }) flightNumber!: string;
  /** A route flight needs originId + destinationId (arrivalAt is optional). A sector flight (e.g. a mountain flight) needs only sectorId. */
  @IsOptional() @IsUUID() originId?: string;
  @IsOptional() @IsUUID() destinationId?: string;
  @IsOptional() @IsUUID() sectorId?: string;
  @IsDateString() departureAt!: string;
  @IsOptional() @IsDateString() arrivalAt?: string;
  @Matches(MONEY) adultFare!: string;
  @Matches(MONEY) childFare!: string;
  /** Seats the agency holds on this departure (the allocation). */
  @IsInt() @Min(0) @Max(1000) seatsAllocated!: number;
}

export class UpdateFlightDto {
  @IsOptional() @Matches(MONEY) adultFare?: string;
  @IsOptional() @Matches(MONEY) childFare?: string;
  @IsOptional() @IsEnum(FlightStatus) status?: FlightStatus;
}

export class AdjustInventoryDto {
  /** Positive adds seats, negative removes them. */
  @IsInt() @Min(-1000) @Max(1000) delta!: number;
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

export class AdminFlightQuery {
  @IsOptional() @Matches(IATA) origin?: string;
  @IsOptional() @Matches(IATA) destination?: string;
  @IsOptional() @IsUUID() sectorId?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsEnum(FlightStatus) status?: FlightStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

export class SearchFlightsQuery {
  /** Either origin + destination, or just a sectorId (sector flights are one-way and have no airports). */
  @IsOptional() @Matches(IATA) origin?: string;
  @IsOptional() @Matches(IATA) destination?: string;
  @IsOptional() @IsUUID() sectorId?: string;
  @IsOptional() @Matches(DATE) departureDate?: string; // omitted = browse all upcoming departures
  @IsOptional() @Matches(DATE) returnDate?: string;
  @IsEnum(TripType) tripType!: TripType;
  @Type(() => Number) @IsInt() @Min(1) @Max(9) adults!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) children: number = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9) infants: number = 0;
}
