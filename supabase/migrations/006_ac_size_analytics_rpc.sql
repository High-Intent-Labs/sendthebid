-- Migration 006: RPC backing the admin consumer AC-size deep-dive.
--
-- Returns email-capture rows for the /ac-size-for-my-room consumer tool,
-- with an optional date filter. No segment filter (single audience —
-- homeowners only). SECURITY DEFINER so it bypasses RLS; the admin
-- password is the security boundary, same pattern as get_admin_data +
-- get_mini_split_captures + get_load_calc_captures.
--
-- Call from the browser via Supabase REST:
--   POST /rest/v1/rpc/get_ac_size_captures
--   body: { admin_password, start_date, end_date }
--
-- Any null filter means "no constraint on this axis":
--   start_date = NULL → no lower bound (all-time so far)
--   end_date   = NULL → no upper bound

CREATE OR REPLACE FUNCTION get_ac_size_captures(
  admin_password text,
  start_date timestamptz DEFAULT NULL,
  end_date timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF admin_password <> 'nailthequoteangi26' THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'created_at', created_at,
        'email', email,
        'ab_variant', ab_variant,
        'calculation_data', calculation_data,
        'marketing_consent', marketing_consent,
        'source_url', source_url
      )
      ORDER BY created_at DESC
    ),
    '[]'::jsonb
  )
  INTO result
  FROM email_captures
  WHERE tool_slug = 'ac-size-for-my-room'
    AND (start_date IS NULL OR created_at >= start_date)
    AND (end_date   IS NULL OR created_at <= end_date);

  RETURN result;
END;
$$;

-- Browser calls this via the anon key; the SECURITY DEFINER block + the
-- password check inside are what protect the data.
GRANT EXECUTE ON FUNCTION get_ac_size_captures(text, timestamptz, timestamptz) TO anon;
