-- ops/backup/sql/20_org_structure.sql
-- Hospital organizational structure (specification Section 2.9).
-- SYNTHETIC baseline: 5 departments, 47 nursing units, 582 beds — the seeded
-- figures reconciled in rev 2.8.7. No real hospital data.

CREATE TABLE IF NOT EXISTS departments (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(10) NOT NULL UNIQUE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS nursing_units (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(20) NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL,
  description   TEXT,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  bed_count     INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_bed_count_range CHECK (bed_count >= 0 AND bed_count <= 500),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bed_capacity_log (
  id             BIGSERIAL PRIMARY KEY,
  unit_id        INTEGER NOT NULL REFERENCES nursing_units(id),
  previous_count INTEGER NOT NULL,
  new_count      INTEGER NOT NULL,
  reason         VARCHAR(200),
  changed_by     INTEGER,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS position_directory (
  code          VARCHAR(20) PRIMARY KEY,
  full_title    VARCHAR(100) NOT NULL,
  tier          VARCHAR(30) NOT NULL,
  is_schedulable BOOLEAN NOT NULL DEFAULT true,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  display_order SMALLINT NOT NULL DEFAULT 0
);

INSERT INTO position_directory (code, full_title, tier, is_schedulable, is_active, display_order) VALUES
  ('DON','Director of Nursing','Executive',false,true,1),
  ('DEPUTY_DON','Deputy Director of Nursing','Executive',false,true,2),
  ('ADMIN','Administrator','Administrative',false,true,3),
  ('NS','Nursing Supervisor','Management',true,true,4),
  ('ACTING_HEAD','Acting Head Nurse','Management',true,true,5),
  ('NURSE_EDUCATOR','Clinical Nurse Educator','Specialist',true,true,6),
  ('PRACTITIONER','Nurse Practitioner','Advanced Practice',true,true,7),
  ('HN','Head Nurse','Management',true,true,8),
  ('CN','Charge Nurse','Clinical Lead',true,true,9),
  ('SN','Staff Nurse','Clinical',true,true,10),
  ('PCT','Patient Care Technician','Support',true,true,11),
  ('TEC','Technician','Support',true,true,12),
  ('HCA','Healthcare Assistant','Support',true,true,13),
  ('MW','Midwife','Clinical Specialist',true,true,14)
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (code, name, description) VALUES
  ('EMAC','Emergency & Acute Care','Emergency departments, urgent care and clinical decision units'),
  ('SURG','Surgical & Perioperative Services','Operating rooms, recovery and day surgery'),
  ('CRIT','Critical Care & Intensive Services','ICU, NICU, PICU, CCU and high-dependency units'),
  ('GNSP','General & Specialty Services','Inpatient wards, outpatient clinics and specialty units'),
  ('CORP','Administrative & Corporate Services','Nursing admin, HR, infection control and support services')
ON CONFLICT (code) DO NOTHING;

INSERT INTO nursing_units (code, name, department_id, bed_count, description)
SELECT t.code, t.name, d.id, t.beds, NULL::text
FROM (VALUES
  ('ER_MAIN','ER Main / Adult','EMAC',39),('ER_MC','ER M&C','EMAC',32),
  ('UCC','Urgent Care Center','EMAC',15),('CDU','Clinical Decision Unit','EMAC',32),
  ('ER_COORD','ER Coordinator','EMAC',0),('ED_NAV','ED Navigation','EMAC',8),
  ('ED_ADMIN','ED Admin','EMAC',7),
  ('OR','Operating Room','SURG',12),('OR_COORD','OR Coordinator','SURG',0),
  ('PACU','Recovery / PACU','SURG',8),('DAY_SURG','Day Surgery','SURG',9),
  ('PLASTER','Plaster Unit','SURG',9),
  ('ICU_MAIN','ICU Main','CRIT',79),('ICU_EXT','ICU Extension','CRIT',28),
  ('NICU','Neonatal Intensive Care','CRIT',15),('PICU','Pediatric Intensive Care','CRIT',15),
  ('CCU','Coronary Care Unit','CRIT',10),('BURN_ICU','Burn ICU','CRIT',6),
  ('ASU','Acute Stabilization Unit','CRIT',6),('HDU','High Dependency Unit','CRIT',6),
  ('INP_WARDS','Inpatient Wards','GNSP',98),('AKU','Allergy and Kidney Unit','GNSP',14),
  ('REHAB','Rehabilitation','GNSP',17),('PEDIA','Pediatric Inpatient','GNSP',15),
  ('LND','Labor and Delivery','GNSP',15),('OBGYNE','Obstetrics & Gynecology','GNSP',17),
  ('NBS','Newborn Screening','GNSP',3),('OPD_DENTAL','OPD / Dental','GNSP',23),
  ('JAIL','Jail Ward','GNSP',12),('RRT','Respiratory Rehab','GNSP',5),
  ('ECHO_EEG','ECHO / EEG','GNSP',2),('ENDO','Endoscopy','GNSP',5),
  ('RADIOLOGY','Radiology','GNSP',6),('BLOOD_BANK','Blood Bank','GNSP',2),
  ('LAB','Laboratory','GNSP',0),('DIABETIC','Diabetic Center','GNSP',10),
  ('DISCHARGE','Discharge Lounge','GNSP',2),
  ('NURS_ADMIN','Nursing Admin','CORP',0),('HR','Human Resources','CORP',0),
  ('IC','Infection Control','CORP',0),('PAT_EXP','Patient Experience','CORP',0),
  ('PAT_AFFAIRS','Patient Affairs','CORP',0),('ACADEMIC','Academic Affairs','CORP',0),
  ('BIZ_CENTER','Business Center','CORP',0),('IDARA','Idara','CORP',0),
  ('STORE','Store','CORP',0),('HOME_CARE','Home Care','CORP',0)
) AS t(code, name, dept, beds)
JOIN departments d ON d.code = t.dept
ON CONFLICT (code) DO NOTHING;

INSERT INTO bed_capacity_log (unit_id, previous_count, new_count, reason)
SELECT id, 0, bed_count, 'Initial seed from Hospital Master Unit Directory (synthetic drill data)'
  FROM nursing_units
 WHERE bed_count > 0;

-- Expect: 47 units / 582 beds
DO $$
DECLARE v_units INT; v_beds INT;
BEGIN
  SELECT count(*), coalesce(sum(bed_count),0) INTO v_units, v_beds
    FROM nursing_units WHERE deleted_at IS NULL;
  IF v_units <> 47 OR v_beds <> 582 THEN
    RAISE EXCEPTION 'Seed mismatch: % units / % beds (expected 47 / 582)', v_units, v_beds;
  END IF;
  RAISE NOTICE 'Org structure OK: % units, % beds', v_units, v_beds;
END $$;
