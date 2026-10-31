-- Passport nationality and expiry, stored as AES-256-GCM envelopes like the passport number itself.
ALTER TABLE "Passenger" ADD COLUMN "documentExpiryEnc" TEXT,
  ADD COLUMN "nationalityEnc" TEXT;
