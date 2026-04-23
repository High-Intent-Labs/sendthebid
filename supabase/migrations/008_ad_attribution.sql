-- Migration 008: Ad attribution columns + ad_clicks ingestion table
--
-- Context: Google Ads attributes conversions per-click via gclid, but we had no
-- end-to-end join from search term / keyword to email. This migration:
--
-- 1. Adds attribution columns to email_captures so every future capture can
--    carry the gclid + UTM stamp it came in with. Paired with a page-load
--    capture script in BaseLayout.astro that reads URL params and stashes them
--    in sessionStorage.
--
-- 2. Creates an ad_clicks table that a nightly Python job populates from the
--    Google Ads click_view report (per-gclid keyword + ad group + device).
--    Joining email_captures.gclid -> ad_clicks.gclid gives a true
--    search-term-to-email map independent of Google's own attribution UI.
--
-- Deploy order: apply this migration BEFORE shipping the code that references
-- these columns. Apr 19 taught us the hard way that out-of-order deploys
-- silently drop inserts.

-- ---------------------------------------------------------------------------
-- 1. email_captures: attribution columns
-- ---------------------------------------------------------------------------
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS gclid text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS utm_term text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS utm_content text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS landing_url text;
ALTER TABLE email_captures ADD COLUMN IF NOT EXISTS referrer text;

CREATE INDEX IF NOT EXISTS idx_email_captures_gclid ON email_captures(gclid);
CREATE INDEX IF NOT EXISTS idx_email_captures_utm_campaign ON email_captures(utm_campaign);

-- ---------------------------------------------------------------------------
-- 2. ad_clicks: Google Ads click_view ingestion
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_clicks (
  gclid text PRIMARY KEY,
  click_date date NOT NULL,
  customer_id bigint,
  campaign_id bigint,
  campaign_name text,
  ad_group_id bigint,
  ad_group_name text,
  keyword_text text,
  keyword_match_type text,
  device text,
  area_of_interest_country text,
  location_country text,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_clicks_click_date ON ad_clicks(click_date);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_keyword_text ON ad_clicks(keyword_text);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_campaign_id ON ad_clicks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_ad_group_id ON ad_clicks(ad_group_id);

ALTER TABLE ad_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on ad_clicks"
  ON ad_clicks FOR ALL
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. Convenience view: emails joined to click-level attribution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW email_captures_attributed AS
SELECT
  ec.id,
  ec.created_at,
  ec.email,
  ec.trade,
  ec.tool_slug,
  ec.segment,
  ec.is_diy,
  ec.contractor_stage,
  ec.ab_variant,
  ec.marketing_consent,
  -- Self-reported attribution (captured from URL at page load)
  ec.gclid,
  ec.utm_source,
  ec.utm_medium,
  ec.utm_campaign,
  ec.utm_term,
  ec.utm_content,
  ec.landing_url,
  ec.referrer,
  -- GAds-side attribution (resolved from click_view via fetch_ad_clicks.py)
  ac.campaign_name       AS ads_campaign_name,
  ac.ad_group_name       AS ads_ad_group_name,
  ac.keyword_text        AS ads_keyword_text,
  ac.keyword_match_type  AS ads_keyword_match_type,
  ac.device              AS ads_device,
  ac.click_date          AS ads_click_date
FROM email_captures ec
LEFT JOIN ad_clicks ac ON ac.gclid = ec.gclid;

COMMENT ON VIEW email_captures_attributed IS
  'Emails joined to Google Ads click attribution. gclid -> ad_clicks (from Google Ads click_view report). Use this for Cost-per-email-by-keyword and persona analysis.';
