import { Type } from 'class-transformer';
import { BookingStatus, ChangeRequestStatus, ChangeRequestType, PassengerType, SegmentDirection, TripType } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const NAME = /^\p{L}[\p{L} .'-]*$/u;
const PHONE = /^\+?[0-9][0-9 -]{6,18}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PassengerDto {
  @IsEnum(PassengerType) type!: PassengerType;
  @IsString() @MinLength(1) @MaxLength(60) @Matches(NAME) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(60) @Matches(NAME) lastName!: string;
  @IsOptional() @Matches(DATE) dateOfBirth?: string;
  /** Passport number. Optional (a domestic traveller may not have one) but given together with nationality. Stored encrypted. */
  @IsOptional() @IsString() @MinLength(5) @MaxLength(20) @Matches(/^[A-Za-z0-9]+$/) documentNumber?: string;
  /** Country that issued the passport, as printed (e.g. Nepal, India). Stored encrypted. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(56) @Matches(NAME) nationality?: string;
  /** Passport expiry date (optional; the public site does not ask for it). Stored encrypted. */
  @IsOptional() @Matches(DATE) documentExpiry?: string;
}

/** Staff add or correct one passenger's passport; number and nationality are required, expiry is optional. */
export class UpdatePassportDto {
  @IsString() @MinLength(5) @MaxLength(20) @Matches(/^[A-Za-z0-9]+$/) documentNumber!: string;
  @IsString() @MinLength(2) @MaxLength(56) @Matches(NAME) nationality!: string;
  @IsOptional() @Matches(DATE) documentExpiry?: string;
}


export class CreateInquiryDto {
  @IsEnum(TripType) tripType!: TripType;
  @IsUUID() outboundFlightId!: string;
  @IsOptional() @IsUUID() returnFlightId?: string;
  @IsString() @MinLength(2) @MaxLength(100) @Matches(NAME) contactName!: string;
  @IsEmail() @MaxLength(254) contactEmail!: string;
  @Matches(PHONE) contactPhone!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** The day(s) the customer asked for. Kept so staff can move them to the nearest reserved flight. */
  @IsOptional() @Matches(DATE) requestedDate?: string;
  @IsOptional() @Matches(DATE) requestedReturnDate?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(18) @ValidateNested({ each: true }) @Type(() => PassengerDto) passengers!: PassengerDto[];
}

/** Staff correct the day the customer wants to fly (an empty string clears it). */
export class UpdateBookingDatesDto {
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/) requestedDate?: string;
  @IsOptional() @Matches(/^(\d{4}-\d{2}-\d{2})?$/) requestedReturnDate?: string;
}

export class LookupDto {
  @IsString() @MaxLength(30) reference!: string;
  @IsEmail() @MaxLength(254) email!: string;
}

export class HoldDto {
  @IsOptional() @IsInt() @Min(5) @Max(1440) minutes?: number;
}

export class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class AdminBookingQuery {
  /** inquiry = not yet confirmed by staff; booking = confirmed (or created directly by staff). */
  @IsOptional() @IsIn(['inquiry', 'booking']) kind?: 'inquiry' | 'booking';
  /** A single status, or a group: OPEN = new + on hold, CLOSED = rejected / expired / cancelled. */
  @IsOptional() @IsIn([...Object.values(BookingStatus), 'OPEN', 'CLOSED']) status?: BookingStatus | 'OPEN' | 'CLOSED';
  /** reference, name, email or phone */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsString() @MaxLength(10) flightNumber?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) origin?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) destination?: string;
  /** departure date range (Nepal calendar days) */
  @IsOptional() @Matches(DATE) flightFrom?: string;
  @IsOptional() @Matches(DATE) flightTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

export class TicketLineDto {
  @IsUUID() passengerId!: string;
  /** As printed on the airline's ticket. */
  @Matches(/^[A-Za-z0-9-]{6,20}$/, { message: 'ticketNumber must be 6-20 letters, digits or dashes' }) ticketNumber!: string;
}

export class IssueTicketDto {
  /** Airline reservation code (PNR) as given by the airline. */
  @Matches(/^[A-Za-z0-9]{5,8}$/, { message: 'pnr must be 5-8 letters or digits' }) pnr!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(18) @ValidateNested({ each: true }) @Type(() => TicketLineDto) tickets!: TicketLineDto[];
}

export class CreateRequestDto {
  @IsString() @MaxLength(30) reference!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsEnum(ChangeRequestType) type!: ChangeRequestType;
  /** Why they want it. The customer never states a refund amount: that depends on the airline and is decided by staff. */
  @IsString() @MinLength(3) @MaxLength(1000) message!: string;
  @IsOptional() @Matches(DATE) preferredDate?: string;
}

export class ResolveRequestDto {
  @IsIn([ChangeRequestStatus.DONE, ChangeRequestStatus.REJECTED]) status!: 'DONE' | 'REJECTED';
  /** Emailed to the customer. */
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** NPR, decided by staff from the airline's rules. */
  @IsOptional() @Matches(/^\d{1,10}(\.\d{1,2})?$/) refundAmount?: string;
}

export class LegChangeDto {
  @IsEnum(SegmentDirection) direction!: SegmentDirection;
  @IsUUID() newFlightId!: string;
}

/** Keep the flight but change the time for THIS ticket (e.g. the flight is running late). */
export class LegRetimeDto {
  @IsEnum(SegmentDirection) direction!: SegmentDirection;
  @IsDateString() departureAt!: string;
}

export class RescheduleDto {
  /** Move a leg to another flight. */
  @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => LegChangeDto) changes?: LegChangeDto[];
  /** Keep a leg on its flight but change its date and time. */
  @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => LegRetimeDto) retimes?: LegRetimeDto[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Only for a ticketed booking whose airline reissued the ticket. */
  @IsOptional() @Matches(/^[A-Za-z0-9]{5,8}$/) pnr?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(18) @ValidateNested({ each: true }) @Type(() => TicketLineDto) tickets?: TicketLineDto[];
}

export class MonthQuery {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must look like 2026-11' }) month!: string;
}

export class SimpleListQuery {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

export class FileNameQuery {
  @IsString() @MinLength(1) @MaxLength(120) filename!: string;
}

export class CustomerQuery {
  /** travelling = confirmed / ticketed; cancelled = cancelled after confirmation; leads = inquiries not yet confirmed */
  @IsOptional() @IsIn(['travelling', 'cancelled', 'leads']) scope?: 'travelling' | 'cancelled' | 'leads';
  @IsOptional() @IsIn(['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID', 'REFUND_DUE', 'REFUNDED']) payment?: string;
  @IsOptional() @IsIn(['true']) rescheduled?: 'true';
  /** flying date range (Nepal calendar days) */
  @IsOptional() @Matches(DATE) flyFrom?: string;
  @IsOptional() @Matches(DATE) flyTo?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
