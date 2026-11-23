-- Menu items sold as walk-ins for a campaign, counted on its dashboard.
ALTER TABLE "campaigns" ADD COLUMN "walk_in_product_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
