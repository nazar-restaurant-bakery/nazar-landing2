-- Test prerequisite copied from shared #65 contract v1; not a K15 production migration.
CREATE TABLE core.business_staff (
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  staff_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL CHECK(role IN('owner','manager','staff')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(business_id,staff_id)
);
CREATE TABLE core.platform_operators (
  staff_id uuid PRIMARY KEY REFERENCES auth.users(id),
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE core.business_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.platform_operators ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.business_staff,core.platform_operators
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.staff_authorized_v1(p_business_id uuid,p_operation text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(auth.uid() IS NOT NULL AND CASE
    WHEN p_operation='platform.read' THEN p_business_id IS NULL AND EXISTS(
      SELECT 1 FROM core.platform_operators p WHERE p.staff_id=auth.uid() AND p.active)
    WHEN p_operation IN('crm.read','orders.read','ops.read','loyalty.read',
      'crm.write','consent.restore','orders.match','campaign.staff_mark','ops.write')
      THEN p_business_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM core.businesses b WHERE b.id=p_business_id)
        AND (EXISTS(SELECT 1 FROM core.business_staff s
          WHERE s.business_id=p_business_id AND s.staff_id=auth.uid() AND s.active)
        OR (p_operation IN('crm.read','orders.read','ops.read','loyalty.read')
          AND EXISTS(SELECT 1 FROM core.platform_operators p WHERE p.staff_id=auth.uid() AND p.active)))
    ELSE false END,false)
$$;
REVOKE ALL ON FUNCTION core.staff_authorized_v1(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- Staff adapters must check their configured business, never the global menu bool.
CREATE FUNCTION public.staff_business_authorized_v1(p_business_id uuid,p_operation text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(auth.role()='authenticated' AND core.staff_authorized_v1(p_business_id,p_operation),false)
$$;
REVOKE ALL ON FUNCTION public.staff_business_authorized_v1(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.staff_business_authorized_v1(uuid,text) TO authenticated;

