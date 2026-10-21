-- Read-only; psql variables are quoted data. Includes every empty NY day.
SELECT json_agg(x ORDER BY day)::text
FROM (
 SELECT d::date::text AS day,count(o.clover_order_id)::int AS count,
        md5(coalesce(string_agg(o.clover_order_id,',' ORDER BY o.clover_order_id COLLATE "C"),'')) AS digest
 FROM generate_series(:'from_day'::date,:'to_day'::date,interval '1 day') d
 LEFT JOIN core.orders o ON o.business_id=:'business_id'::uuid
  AND (o.created_at AT TIME ZONE 'America/New_York')::date=d::date
 GROUP BY d
) x;
