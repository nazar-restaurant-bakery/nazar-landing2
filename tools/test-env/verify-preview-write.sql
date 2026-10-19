-- READ-ONLY evidence query. Run on the verified test target and, separately,
-- on the existing production target. Expected test: key=1, signup=1; production=0.
-- psql variables: request_id and synthetic_email (reserved .invalid only).
BEGIN TRANSACTION READ ONLY;
SELECT count(*) AS matching_request_keys
FROM core.signup_request_keys WHERE request_id=:'request_id'::uuid;
SELECT count(*) AS matching_signups,
       coalesce(bool_and(is_test),false) AS all_matching_signups_are_tests
FROM core.signups
WHERE lower(email)=lower(:'synthetic_email') AND lower(:'synthetic_email') LIKE '%@example.invalid';
SELECT count(*) AS matching_catering_requests,
       coalesce(bool_and(r.is_test),false) AS all_matching_requests_are_tests
FROM core.catering_requests r JOIN core.signups s ON s.id=r.signup_id
WHERE lower(s.email)=lower(:'synthetic_email') AND lower(:'synthetic_email') LIKE '%@example.invalid';
ROLLBACK;
