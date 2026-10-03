-- Team: staff, rostering, attendance and payroll (TEAM-MODULE-PLAN.md).
-- Additive only: new tables, two new enum values, one nullable column on
-- sessions. Nothing existing changes shape or meaning.

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StaffCredentialKind" AS ENUM ('PIN');

-- CreateEnum
CREATE TYPE "SoloSuitability" AS ENUM ('SUITABLE', 'CAUTION', 'NOT_RECOMMENDED');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('TRAINEE', 'TRAINED');

-- CreateEnum
CREATE TYPE "RosterStatus" AS ENUM ('DRAFT', 'APPLICATIONS_OPEN', 'APPLICATIONS_CLOSED', 'GENERATED', 'IN_REVIEW', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('APPLIED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'REMOVED');

-- CreateEnum
CREATE TYPE "AssignmentSource" AS ENUM ('AUTO', 'MANUAL', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "CoverageStatus" AS ENUM ('OPEN', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'MANAGER_CONFIRMED', 'MANAGER_SKIPPED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('TEAM_APP', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayslipLineKind" AS ENUM ('ATTENDANCE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('OPEN', 'INCLUDED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "PayFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RoundingMode" AS ENUM ('FLOOR', 'NEAREST');

-- AlterEnum
ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'WAGES';

-- AlterEnum
ALTER TYPE "SessionScope" ADD VALUE IF NOT EXISTS 'STAFF';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "staff_id" TEXT;

-- CreateTable
CREATE TABLE "staff_members" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "staff_code" TEXT NOT NULL,
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_work_type_id" TEXT,
    "role_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_credentials" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "kind" "StaffCredentialKind" NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_attributes" (
    "staff_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "reliability" INTEGER,
    "capability" INTEGER,
    "experience" INTEGER,
    "solo_suitability" "SoloSuitability" NOT NULL DEFAULT 'SUITABLE',
    "training_status" "TrainingStatus" NOT NULL DEFAULT 'TRAINED',
    "management_priority" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_attributes_pkey" PRIMARY KEY ("staff_id")
);

-- CreateTable
CREATE TABLE "work_types" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_sen_per_hour" INTEGER NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_settings" (
    "business_id" TEXT NOT NULL,
    "application_limit" INTEGER NOT NULL DEFAULT 10,
    "assignment_target_shifts" INTEGER NOT NULL DEFAULT 5,
    "assignment_max_shifts" INTEGER NOT NULL DEFAULT 7,
    "assignment_max_minutes" INTEGER NOT NULL DEFAULT 2700,
    "withdrawal_deadline_hours" INTEGER NOT NULL DEFAULT 24,
    "urgent_coverage_hours" INTEGER NOT NULL DEFAULT 24,
    "pay_rounding_minutes" INTEGER NOT NULL DEFAULT 30,
    "pay_rounding_mode" "RoundingMode" NOT NULL DEFAULT 'FLOOR',
    "pay_frequency" "PayFrequency" NOT NULL DEFAULT 'WEEKLY',
    "pay_anchor_date" DATE NOT NULL DEFAULT '2026-01-05'::date,
    "payday_offset_days" INTEGER NOT NULL DEFAULT 3,
    "engine_weights" JSONB NOT NULL DEFAULT '{}',
    "org_code" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "operating_hours" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "opens_at" TEXT NOT NULL,
    "closes_at" TEXT NOT NULL,

    CONSTRAINT "operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closed_periods" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT,

    CONSTRAINT "closed_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot_templates" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "required_staff" INTEGER NOT NULL DEFAULT 1,
    "can_run_solo" BOOLEAN NOT NULL DEFAULT true,
    "role_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "work_type_id" TEXT,
    "label" TEXT,

    CONSTRAINT "slot_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_weeks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "status" "RosterStatus" NOT NULL DEFAULT 'DRAFT',
    "applications_open_at" TIMESTAMP(3),
    "applications_close_at" TIMESTAMP(3),
    "review_deadline" TIMESTAMP(3),
    "publish_deadline" TIMESTAMP(3),
    "application_limit" INTEGER NOT NULL,
    "assignment_target_shifts" INTEGER NOT NULL,
    "assignment_max_shifts" INTEGER NOT NULL,
    "assignment_max_minutes" INTEGER NOT NULL,
    "withdrawal_deadline_hours" INTEGER NOT NULL,
    "generated_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_slots" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "roster_week_id" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "required_staff" INTEGER NOT NULL DEFAULT 1,
    "can_run_solo" BOOLEAN NOT NULL DEFAULT true,
    "role_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "work_type_id" TEXT,
    "label" TEXT,

    CONSTRAINT "shift_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_applications" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'APPLIED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "AssignmentSource" NOT NULL,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "work_type_id" TEXT,
    "rate_override_sen" INTEGER,
    "rate_override_reason" TEXT,
    "rate_override_at" TIMESTAMP(3),
    "explanation" TEXT,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coverage_requests" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "vacated_assignment_id" TEXT,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" "CoverageStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "coverage_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replacement_offers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "coverage_request_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "replacement_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "assignment_id" TEXT,
    "clock_in_at" TIMESTAMPTZ(3) NOT NULL,
    "clock_out_at" TIMESTAMPTZ(3),
    "source" "AttendanceSource" NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PENDING',
    "approved_start_at" TIMESTAMPTZ(3),
    "approved_end_at" TIMESTAMPTZ(3),
    "work_type_id" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "PayslipStatus" NOT NULL DEFAULT 'APPROVED',
    "total_minutes" INTEGER NOT NULL,
    "total_sen" INTEGER NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "paid_on" DATE,
    "expense_id" TEXT,
    "ledger_entry_id" BIGINT,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "payslip_id" TEXT NOT NULL,
    "kind" "PayslipLineKind" NOT NULL,
    "attendance_id" TEXT,
    "attendance_version" INTEGER,
    "adjustment_id" TEXT,
    "work_date" DATE NOT NULL,
    "clock_in_at" TIMESTAMPTZ(3),
    "clock_out_at" TIMESTAMPTZ(3),
    "minutes" INTEGER NOT NULL,
    "work_type_name" TEXT NOT NULL,
    "rate_sen_per_hour" INTEGER NOT NULL,
    "amount_sen" INTEGER NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "attendance_id" TEXT,
    "cause_payslip_id" TEXT,
    "amount_sen" INTEGER NOT NULL,
    "minutes_delta" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'OPEN',
    "included_in_payslip_id" TEXT,
    "resolved_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_members_business_id_status_idx" ON "staff_members"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_business_id_id_key" ON "staff_members"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_business_id_staff_code_key" ON "staff_members"("business_id", "staff_code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_credentials_staff_id_kind_key" ON "staff_credentials"("staff_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attributes_business_id_staff_id_key" ON "staff_attributes"("business_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_types_business_id_id_key" ON "work_types"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "work_types_business_id_name_key" ON "work_types"("business_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_settings_org_code_key" ON "team_settings"("org_code");

-- CreateIndex
CREATE UNIQUE INDEX "operating_hours_business_id_weekday_key" ON "operating_hours"("business_id", "weekday");

-- CreateIndex
CREATE INDEX "closed_periods_business_id_start_date_idx" ON "closed_periods"("business_id", "start_date");

-- CreateIndex
CREATE INDEX "slot_templates_business_id_weekday_idx" ON "slot_templates"("business_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "roster_weeks_business_id_id_key" ON "roster_weeks"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roster_weeks_business_id_week_start_key" ON "roster_weeks"("business_id", "week_start");

-- CreateIndex
CREATE INDEX "shift_slots_roster_week_id_starts_at_idx" ON "shift_slots"("roster_week_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "shift_slots_business_id_id_key" ON "shift_slots"("business_id", "id");

-- CreateIndex
CREATE INDEX "shift_applications_staff_id_idx" ON "shift_applications"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_applications_slot_id_staff_id_key" ON "shift_applications"("slot_id", "staff_id");

-- CreateIndex
CREATE INDEX "assignments_slot_id_status_idx" ON "assignments"("slot_id", "status");

-- CreateIndex
CREATE INDEX "assignments_staff_id_status_idx" ON "assignments"("staff_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_business_id_id_key" ON "assignments"("business_id", "id");

-- CreateIndex
CREATE INDEX "coverage_requests_business_id_status_idx" ON "coverage_requests"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "coverage_requests_business_id_id_key" ON "coverage_requests"("business_id", "id");

-- CreateIndex
CREATE INDEX "replacement_offers_staff_id_status_idx" ON "replacement_offers"("staff_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_offers_coverage_request_id_staff_id_key" ON "replacement_offers"("coverage_request_id", "staff_id");

-- CreateIndex
CREATE INDEX "attendance_records_business_id_clock_in_at_idx" ON "attendance_records"("business_id", "clock_in_at");

-- CreateIndex
CREATE INDEX "attendance_records_staff_id_clock_in_at_idx" ON "attendance_records"("staff_id", "clock_in_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_business_id_id_key" ON "attendance_records"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_expense_id_key" ON "payslips"("expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_ledger_entry_id_key" ON "payslips"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "payslips_business_id_period_start_idx" ON "payslips"("business_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_business_id_id_key" ON "payslips"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_business_id_expense_id_key" ON "payslips"("business_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_business_id_staff_id_period_start_period_end_key" ON "payslips"("business_id", "staff_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "payslip_lines_payslip_id_idx" ON "payslip_lines"("payslip_id");

-- CreateIndex
CREATE INDEX "payslip_lines_attendance_id_idx" ON "payslip_lines"("attendance_id");

-- CreateIndex
CREATE INDEX "payroll_adjustments_business_id_status_idx" ON "payroll_adjustments"("business_id", "status");

-- CreateIndex
CREATE INDEX "payroll_adjustments_staff_id_idx" ON "payroll_adjustments"("staff_id");

-- CreateIndex
CREATE INDEX "team_audit_log_business_id_created_at_idx" ON "team_audit_log"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "team_audit_log_business_id_entity_type_entity_id_idx" ON "team_audit_log"("business_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "sessions_staff_id_idx" ON "sessions"("staff_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_business_id_default_work_type_id_fkey" FOREIGN KEY ("business_id", "default_work_type_id") REFERENCES "work_types"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_attributes" ADD CONSTRAINT "staff_attributes_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_settings" ADD CONSTRAINT "team_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slot_templates" ADD CONSTRAINT "slot_templates_business_id_work_type_id_fkey" FOREIGN KEY ("business_id", "work_type_id") REFERENCES "work_types"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_weeks" ADD CONSTRAINT "roster_weeks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_slots" ADD CONSTRAINT "shift_slots_business_id_roster_week_id_fkey" FOREIGN KEY ("business_id", "roster_week_id") REFERENCES "roster_weeks"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_slots" ADD CONSTRAINT "shift_slots_business_id_work_type_id_fkey" FOREIGN KEY ("business_id", "work_type_id") REFERENCES "work_types"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_applications" ADD CONSTRAINT "shift_applications_business_id_slot_id_fkey" FOREIGN KEY ("business_id", "slot_id") REFERENCES "shift_slots"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_applications" ADD CONSTRAINT "shift_applications_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_business_id_slot_id_fkey" FOREIGN KEY ("business_id", "slot_id") REFERENCES "shift_slots"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_business_id_work_type_id_fkey" FOREIGN KEY ("business_id", "work_type_id") REFERENCES "work_types"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_requests" ADD CONSTRAINT "coverage_requests_business_id_slot_id_fkey" FOREIGN KEY ("business_id", "slot_id") REFERENCES "shift_slots"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_requests" ADD CONSTRAINT "coverage_requests_business_id_vacated_assignment_id_fkey" FOREIGN KEY ("business_id", "vacated_assignment_id") REFERENCES "assignments"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_offers" ADD CONSTRAINT "replacement_offers_business_id_coverage_request_id_fkey" FOREIGN KEY ("business_id", "coverage_request_id") REFERENCES "coverage_requests"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_offers" ADD CONSTRAINT "replacement_offers_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_business_id_assignment_id_fkey" FOREIGN KEY ("business_id", "assignment_id") REFERENCES "assignments"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_business_id_work_type_id_fkey" FOREIGN KEY ("business_id", "work_type_id") REFERENCES "work_types"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_business_id_expense_id_fkey" FOREIGN KEY ("business_id", "expense_id") REFERENCES "expenses"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_business_id_payslip_id_fkey" FOREIGN KEY ("business_id", "payslip_id") REFERENCES "payslips"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff_members"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_business_id_attendance_id_fkey" FOREIGN KEY ("business_id", "attendance_id") REFERENCES "attendance_records"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_business_id_cause_payslip_id_fkey" FOREIGN KEY ("business_id", "cause_payslip_id") REFERENCES "payslips"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_business_id_included_in_payslip_id_fkey" FOREIGN KEY ("business_id", "included_in_payslip_id") REFERENCES "payslips"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_audit_log" ADD CONSTRAINT "team_audit_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backstops. The API checks all of this; these make a bug unable to store it.
-- ---------------------------------------------------------------------------

ALTER TABLE "work_types" ADD CONSTRAINT "work_types_rate_nonnegative" CHECK ("rate_sen_per_hour" >= 0);

ALTER TABLE "staff_attributes" ADD CONSTRAINT "staff_attributes_scores_in_range" CHECK (
  ("reliability" IS NULL OR "reliability" BETWEEN 1 AND 5)
  AND ("capability" IS NULL OR "capability" BETWEEN 1 AND 5)
  AND ("experience" IS NULL OR "experience" BETWEEN 1 AND 5)
  AND "management_priority" BETWEEN -2 AND 2
);

ALTER TABLE "team_settings" ADD CONSTRAINT "team_settings_numbers_sane" CHECK (
  "application_limit" >= 0
  AND "assignment_target_shifts" >= 0
  AND "assignment_max_shifts" >= "assignment_target_shifts"
  AND "assignment_max_minutes" >= 0
  AND "withdrawal_deadline_hours" >= 0
  AND "urgent_coverage_hours" >= 0
  AND "pay_rounding_minutes" BETWEEN 1 AND 60
  AND "payday_offset_days" >= 0
);

ALTER TABLE "operating_hours" ADD CONSTRAINT "operating_hours_valid" CHECK (
  "weekday" BETWEEN 0 AND 6
  AND "opens_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "closes_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
);

ALTER TABLE "closed_periods" ADD CONSTRAINT "closed_periods_ordered" CHECK ("end_date" >= "start_date");

ALTER TABLE "slot_templates" ADD CONSTRAINT "slot_templates_valid" CHECK (
  "weekday" BETWEEN 0 AND 6
  AND "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "required_staff" >= 1
);

ALTER TABLE "roster_weeks" ADD CONSTRAINT "roster_weeks_starts_monday" CHECK (EXTRACT(ISODOW FROM "week_start") = 1);

ALTER TABLE "shift_slots" ADD CONSTRAINT "shift_slots_valid" CHECK (
  "ends_at" > "starts_at" AND "required_staff" >= 1
);

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_rate_override_nonnegative" CHECK (
  "rate_override_sen" IS NULL OR "rate_override_sen" >= 0
);

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_ordered" CHECK (
  ("clock_out_at" IS NULL OR "clock_out_at" > "clock_in_at")
  AND ("approved_end_at" IS NULL OR "approved_start_at" IS NULL OR "approved_end_at" > "approved_start_at")
);

-- One open clock-in per person at a time.
CREATE UNIQUE INDEX "attendance_records_one_open_per_staff"
  ON "attendance_records" ("staff_id") WHERE "clock_out_at" IS NULL AND "status" <> 'REJECTED';

-- One live assignment per person per slot.
CREATE UNIQUE INDEX "assignments_one_active_per_slot_staff"
  ON "assignments" ("slot_id", "staff_id") WHERE "status" = 'ACTIVE';

-- One open vacancy offer per request at a time: offers go out in queue order.
CREATE UNIQUE INDEX "replacement_offers_one_pending_per_request"
  ON "replacement_offers" ("coverage_request_id") WHERE "status" = 'PENDING';

ALTER TABLE "payslips" ADD CONSTRAINT "payslips_period_ordered" CHECK ("period_end" >= "period_start");
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_paid_has_payment" CHECK (
  "status" <> 'PAID' OR ("paid_at" IS NOT NULL AND "paid_on" IS NOT NULL)
);
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_minutes_nonnegative" CHECK ("minutes" >= 0);

-- A paid payslip is history. Its row may not change (beyond nothing at all)
-- and its lines may not be added, changed or removed. A later correction is a
-- payroll adjustment, never an edit here.
CREATE FUNCTION "team_paid_payslip_is_final"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'payslips' THEN
    IF OLD."status" = 'PAID' THEN
      RAISE EXCEPTION 'payslip % is paid and cannot change', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "payslips"
     WHERE "id" = COALESCE(NEW."payslip_id", OLD."payslip_id") AND "status" = 'PAID'
  ) THEN
    RAISE EXCEPTION 'lines of a paid payslip cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "payslips_paid_is_final" BEFORE UPDATE OR DELETE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION "team_paid_payslip_is_final"();
CREATE TRIGGER "payslip_lines_paid_is_final" BEFORE INSERT OR UPDATE OR DELETE ON "payslip_lines"
  FOR EACH ROW EXECUTE FUNCTION "team_paid_payslip_is_final"();

-- The audit trail is append-only.
CREATE FUNCTION "team_audit_is_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the team audit log is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "team_audit_log_append_only" BEFORE UPDATE OR DELETE ON "team_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "team_audit_is_append_only"();

-- ---------------------------------------------------------------------------
-- Closed to Supabase's Data API, like every other table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff_members', 'staff_credentials', 'staff_attributes', 'work_types',
    'team_settings', 'operating_hours', 'closed_periods', 'slot_templates',
    'roster_weeks', 'shift_slots', 'shift_applications', 'assignments',
    'coverage_requests', 'replacement_offers', 'attendance_records', 'payslips',
    'payslip_lines', 'payroll_adjustments', 'team_audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SEQUENCE public.team_audit_log_id_seq FROM anon, authenticated;
  END IF;
END
$$;
