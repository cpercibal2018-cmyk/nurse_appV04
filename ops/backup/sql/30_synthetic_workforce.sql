-- ops/backup/sql/30_synthetic_workforce.sql
-- SYNTHETIC workforce for the Gate 1 sandbox. NO REAL STAFF DATA.
--
-- Names are deliberately machine-generated (SYNTH-#####) so no synthetic row
-- can ever be mistaken for a real person, and so the restore drill's output
-- can be shared freely.
--
-- Deterministic: the same employee count always yields the same dataset, so a
-- drill result is reproducible.

CREATE TABLE IF NOT EXISTS employees (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  job_number    VARCHAR(20) NOT NULL UNIQUE,
  unit_id       INTEGER NOT NULL REFERENCES nursing_units(id),
  position      VARCHAR(20) NOT NULL REFERENCES position_directory(code),
  contact_email VARCHAR(160),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS contracts (
  id         SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  status     VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_contract_dates CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS credentials (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  template_code VARCHAR(20) NOT NULL,
  issue_date    DATE,
  expiry_date   DATE,
  validity_status VARCHAR(20) NOT NULL DEFAULT 'Valid',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Employees ───────────────────────────────────────────────────────────────
-- 120 synthetic nurses spread across units, weighted toward clinical positions.
INSERT INTO employees (name, job_number, unit_id, position, contact_email, created_at)
SELECT
  'SYNTH-' || lpad(g::text, 5, '0'),
  'JOB-' || lpad(g::text, 5, '0'),
  u.id,
  CASE
    WHEN g % 37 = 0 THEN 'HN'
    WHEN g % 23 = 0 THEN 'CN'
    WHEN g % 11 = 0 THEN 'NS'
    WHEN g % 7  = 0 THEN 'PRACTITIONER'
    WHEN g % 3  = 0 THEN 'PCT'
    ELSE 'SN'
  END,
  'synth' || g || '@sandbox.invalid',
  now() - (g % 400) * interval '1 day'
FROM generate_series(1, 120) g
JOIN LATERAL (
  SELECT id FROM nursing_units WHERE deleted_at IS NULL AND bed_count > 0
   ORDER BY id OFFSET (g % 30) LIMIT 1
) u ON true
ON CONFLICT (job_number) DO NOTHING;

-- ── Contracts (non-overlapping per employee by construction) ────────────────
INSERT INTO contracts (employee_id, start_date, end_date, status)
SELECT e.id,
       CURRENT_DATE - interval '180 days',
       CURRENT_DATE + (e.id % 400) - 100,
       CASE WHEN (e.id % 400) - 100 < 0 THEN 'Expired' ELSE 'Active' END
  FROM employees e
 WHERE NOT EXISTS (SELECT 1 FROM contracts c WHERE c.employee_id = e.id);

-- ── Credentials with a spread of expiry states ──────────────────────────────
-- Drives eligibility, the expiry scan and the grace-period scenarios:
-- some long-valid, some expiring inside the 60-day window, some already expired.
INSERT INTO credentials (employee_id, template_code, issue_date, expiry_date, validity_status)
SELECT e.id,
       t.template_code,
       CURRENT_DATE - 365,
       CURRENT_DATE + (e.id * 7 + t.exp_offset) % 500 - 120,
       CASE
         WHEN (CURRENT_DATE + (e.id * 7 + t.exp_offset) % 500 - 120) < CURRENT_DATE THEN 'Expired'
         WHEN (CURRENT_DATE + (e.id * 7 + t.exp_offset) % 500 - 120) < CURRENT_DATE + 60 THEN 'ExpiringSoon'
         ELSE 'Valid'
       END
FROM employees e
CROSS JOIN (VALUES ('SCFHS', 0), ('BLS', 31), ('ACLS', 67), ('IQAMA', 101)) AS t(template_code, exp_offset)
WHERE NOT EXISTS (
  SELECT 1 FROM credentials c
   WHERE c.employee_id = e.id AND c.template_code = t.template_code
);

-- ── Audit chain: one entry per domain mutation, chunked to keep it fast ─────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, job_number FROM employees ORDER BY id LOOP
    PERFORM fn_append_audit_entry(
      NULL, 'EMPLOYEE_SEEDED', 'employees', r.id::text,
      jsonb_build_object('job_number', r.job_number, 'source', 'synthetic-sandbox')
    );
  END LOOP;

  FOR r IN SELECT id, employee_id FROM contracts ORDER BY id LOOP
    PERFORM fn_append_audit_entry(
      NULL, 'CONTRACT_SEEDED', 'contracts', r.id::text,
      jsonb_build_object('employee_id', r.employee_id)
    );
  END LOOP;
END $$;

DO $$
DECLARE c INT; ch INT; cd INT;
BEGIN
  SELECT count(*) INTO c FROM employees;
  SELECT count(*) INTO cd FROM contracts;
  SELECT count(*) INTO ch FROM audit_entries;
  RAISE NOTICE 'Synthetic workforce: % employees, % contracts, % audit entries', c, cd, ch;
END $$;
