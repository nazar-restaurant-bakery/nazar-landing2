-- READ-ONLY evidence query. Run on the verified test target and, separately,
-- on the existing production target. Use one preseeded synthetic email, record
-- these before-counts, then submit exactly one Preview form with a new request
-- ID. Expected test delta: request_keys +1, signups +1, customers unchanged.
-- The seeded email already has one signup, so its final signup count is TWO.
-- An exact retry must leave those counts unchanged. Production must have zero
-- matches for both the request ID and synthetic email before and after.
-- psql variables: request_id and synthetic_email (reserved .invalid only).
BEGIN TRANSACTION READ ONLY;
SELECT count(*) AS matching_request_keys
FROM core.signup_request_keys WHERE request_id=:'request_id'::uuid;
SELECT count(*) AS matching_customers,
       coalesce(bool_and(coalesce((to_jsonb(c)->>'is_test')::boolean,false)),false)
         AS all_matching_customers_are_tests
FROM core.customers c
WHERE lower(email)=lower(:'synthetic_email') AND lower(:'synthetic_email') LIKE '%@example.invalid';
SELECT count(*) AS matching_signups,
       coalesce(bool_and(is_test),false) AS all_matching_signups_are_tests
FROM core.signups
WHERE lower(email)=lower(:'synthetic_email') AND lower(:'synthetic_email') LIKE '%@example.invalid';
SELECT count(*) AS matching_catering_requests,
       coalesce(bool_and(r.is_test),false) AS all_matching_requests_are_tests
FROM core.catering_requests r JOIN core.signups s ON s.id=r.signup_id
WHERE lower(s.email)=lower(:'synthetic_email') AND lower(:'synthetic_email') LIKE '%@example.invalid';
ROLLBACK;
