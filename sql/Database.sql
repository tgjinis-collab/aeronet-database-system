-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- DOMAIN ENUMERATIONS
-- =============================================================================

CREATE TYPE accreditation_status AS ENUM (
    'ISO9001', 'AS9100', 'NADCAP', 'FAA_APPROVED', 'EASA_APPROVED', 'PENDING', 'SUSPENDED'
);

CREATE TYPE order_status AS ENUM (
    'PLACED', 'CONFIRMED', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED'
);

CREATE TYPE qc_report_type AS ENUM (
    'VISUAL_INSPECTION', 'DIMENSIONAL_CHECK', 'NON_DESTRUCTIVE_TESTING', 'ENVIRONMENTAL_STRESS'
);

CREATE TYPE qc_status AS ENUM (
    'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'
);

CREATE TYPE action_type AS ENUM (
    'VIEW', 'CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'EXPORT', 'LOGIN', 'LOGOUT'
);

CREATE TYPE audit_outcome AS ENUM (
    'SUCCESS', 'FAILURE', 'DENIED'
);

CREATE TYPE device_type AS ENUM (
    'MACHINE_SENSOR', 'CONTAINER_TRACKER', 'ENVIRONMENTAL_MONITOR'
);

CREATE TYPE assigned_to_type AS ENUM (
    'EQUIPMENT', 'SHIPMENT', 'CONTAINER'
);

CREATE TYPE feature_type AS ENUM (
    'RFID_TAG', 'ANTI_CORROSION_COATING', 'SHOCK_SENSOR',
    'DIGITAL_TWIN', 'CUSTOM_FINISH', 'THERMAL_COATING'
);

CREATE TYPE role_name AS ENUM (
    'PROCUREMENT_OFFICER', 'QUALITY_INSPECTOR',
    'SUPPLY_CHAIN_MANAGER', 'EQUIPMENT_ENGINEER', 'AUDITOR'
);

CREATE TYPE permission_name AS ENUM (
    'READ', 'WRITE', 'APPROVE', 'AUDIT', 'EXPORT'
);

CREATE TYPE permission_scope AS ENUM (
    'SUPPLIERS', 'PARTS', 'ORDERS', 'SHIPMENTS',
    'QC_REPORTS', 'CERTIFICATIONS', 'IOT_DATA',
    'USERS', 'AUDIT_LOGS', 'EQUIPMENT'
);

-- DOMAIN 1: SUPPLIER & PARTS

CREATE TABLE supplier (
    supplier_id     UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name   VARCHAR(255)    NOT NULL,
    address         TEXT            NOT NULL,
    contact_name    VARCHAR(150),
    contact_email   VARCHAR(255)    NOT NULL UNIQUE,
    contact_phone   VARCHAR(50),
    accreditation   accreditation_status NOT NULL DEFAULT 'PENDING',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE part (
    part_id         UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    part_name       VARCHAR(255)    NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE part_baseline_spec (
    baseline_spec_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    part_id                 UUID        NOT NULL UNIQUE REFERENCES part(part_id) ON DELETE CASCADE,
    tensile_strength_mpa    NUMERIC(10,3),
    yield_strength_mpa      NUMERIC(10,3),
    fatigue_limit_mpa       NUMERIC(10,3),
    hardness_hv             NUMERIC(8,2),
    process_details         TEXT,                   -- heat treatment, machining, finishing
    cad_model_ref           VARCHAR(500),            -- URI / object-store path
    engineering_drawing_ref VARCHAR(500),
    prototype_media_ref     VARCHAR(500),
    baseline_notes          TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_part_offering (
    supplier_part_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id             UUID        NOT NULL REFERENCES supplier(supplier_id) ON DELETE RESTRICT,
    part_id                 UUID        NOT NULL REFERENCES part(part_id) ON DELETE RESTRICT,
    customisation_summary   TEXT,
    is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (supplier_id, part_id)           -- a supplier offers a given part only once
);

CREATE TABLE supplier_part_feature (
    feature_id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_part_id    UUID            NOT NULL REFERENCES supplier_part_offering(supplier_part_id) ON DELETE CASCADE,
    feature_type        feature_type    NOT NULL,
    feature_description TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);


-- DOMAIN 2: ORDERS & SHIPMENTS

CREATE TABLE purchase_order (
    order_id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id             UUID            NOT NULL REFERENCES supplier(supplier_id) ON DELETE RESTRICT,
    order_date              DATE            NOT NULL DEFAULT CURRENT_DATE,
    desired_delivery_date   DATE,
    actual_delivery_date    DATE,
    status                  order_status    NOT NULL DEFAULT 'PLACED',
    created_by_emp_id       UUID,           -- FK added after USER table is created
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_delivery_dates CHECK (
        actual_delivery_date IS NULL OR actual_delivery_date >= order_date
    )
);

CREATE TABLE purchase_order_line (
    order_line_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID        NOT NULL REFERENCES purchase_order(order_id) ON DELETE CASCADE,
    supplier_part_id    UUID        NOT NULL REFERENCES supplier_part_offering(supplier_part_id) ON DELETE RESTRICT,
    quantity            INT         NOT NULL CHECK (quantity > 0),
    unit_price_usd      NUMERIC(14,4),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE shipment (
    shipment_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID        NOT NULL REFERENCES purchase_order(order_id) ON DELETE RESTRICT,
    tracking_number     VARCHAR(100) NOT NULL,
    port_of_entry       VARCHAR(150),
    carrier_name        VARCHAR(150),
    dispatched_at       TIMESTAMPTZ,
    arrived_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE delivered_item (
    delivered_item_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    order_line_id       UUID        NOT NULL REFERENCES purchase_order_line(order_line_id) ON DELETE RESTRICT,
    shipment_id         UUID        NOT NULL REFERENCES shipment(shipment_id) ON DELETE RESTRICT,
    serial_number       VARCHAR(100),
    batch_number        VARCHAR(100),
    delivery_timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DOMAIN 3: QUALITY & CERTIFICATION

CREATE TABLE qc_report (
    qc_report_id        UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    delivered_item_id   UUID            NOT NULL REFERENCES delivered_item(delivered_item_id) ON DELETE RESTRICT,
    report_type         qc_report_type  NOT NULL,
    current_status      qc_status       NOT NULL DEFAULT 'DRAFT',
    mongo_doc_ref       VARCHAR(500),   -- MongoDB document _id for full payload + version history
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE certification (
    certification_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    delivered_item_id       UUID        NOT NULL REFERENCES delivered_item(delivered_item_id) ON DELETE RESTRICT,
    issued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at             TIMESTAMPTZ,                    -- NULL until formally approved
    approved_by_emp_id      UUID,                           -- FK added after USER table
    certification_doc_ref   VARCHAR(500),                   -- MongoDB / object-store URI for PDF
    is_immutable            BOOLEAN     NOT NULL DEFAULT FALSE,
    mongo_doc_ref           VARCHAR(500),                   -- MongoDB document _id for full payload
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_approved CHECK (
        (approved_at IS NULL AND approved_by_emp_id IS NULL) OR
        (approved_at IS NOT NULL AND approved_by_emp_id IS NOT NULL)
    )
);

CREATE TABLE material_batch (
    material_batch_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_supplier_name    VARCHAR(255),
    material_type           VARCHAR(150) NOT NULL,
    heat_number             VARCHAR(100),
    manufacture_date        DATE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE delivered_item_material (
    delivered_item_material_id  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    delivered_item_id           UUID    NOT NULL REFERENCES delivered_item(delivered_item_id) ON DELETE CASCADE,
    material_batch_id           UUID    NOT NULL REFERENCES material_batch(material_batch_id) ON DELETE RESTRICT,
    UNIQUE (delivered_item_id, material_batch_id)
);

CREATE TABLE equipment (
    equipment_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_name      VARCHAR(255) NOT NULL,
    facility_plant      VARCHAR(150),
    equipment_type      VARCHAR(100) NOT NULL,
    manufacturer        VARCHAR(150),
    model_number        VARCHAR(100),
    install_date        DATE,
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE iot_device (
    device_id           UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    device_type         device_type     NOT NULL,
    assigned_to_type    assigned_to_type NOT NULL,
    assigned_to_id      UUID            NOT NULL,   -- FK to equipment_id or shipment_id depending on assigned_to_type
    firmware_version    VARCHAR(50),
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    registered_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_assigned_not_null CHECK (assigned_to_id IS NOT NULL)
);

-- DOMAIN 5: ROLES, PERMISSIONS & AUDIT

CREATE TABLE "user" (
    emp_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       VARCHAR(255) NOT NULL,
    job_title       VARCHAR(150),
    department      VARCHAR(150),
    email           VARCHAR(255) NOT NULL UNIQUE,
    phone           VARCHAR(50),
    auth_id         VARCHAR(255) UNIQUE,    -- external IdP reference (Auth0, Cognito, etc.)
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role (
    role_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    role_name       role_name   NOT NULL UNIQUE,
    description     TEXT
);

CREATE TABLE user_role (
    user_role_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    emp_id          UUID        NOT NULL REFERENCES "user"(emp_id) ON DELETE CASCADE,
    role_id         UUID        NOT NULL REFERENCES role(role_id) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by      UUID        REFERENCES "user"(emp_id),
    UNIQUE (emp_id, role_id)
);

CREATE TABLE permission (
    permission_id   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_name permission_name NOT NULL,
    scope           permission_scope NOT NULL,
    UNIQUE (permission_name, scope)
);

CREATE TABLE role_permission (
    role_permission_id  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id             UUID    NOT NULL REFERENCES role(role_id) ON DELETE CASCADE,
    permission_id       UUID    NOT NULL REFERENCES permission(permission_id) ON DELETE CASCADE,
    UNIQUE (role_id, permission_id)
);

CREATE TABLE audit_log (
    audit_id        UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    emp_id          UUID            REFERENCES "user"(emp_id) ON DELETE SET NULL,
    action_type     action_type     NOT NULL,
    entity_type     VARCHAR(100)    NOT NULL,   -- e.g. 'SUPPLIER', 'QC_REPORT', 'CERTIFICATION'
    entity_id       TEXT            NOT NULL,   -- the PK of the affected record (text for cross-db refs)
    outcome         audit_outcome   NOT NULL DEFAULT 'SUCCESS',
    ip_address      INET,
    user_agent      TEXT,
    detail          JSONB,                      -- additional context (diff, old values, etc.)
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- DEFERRED FOREIGN KEYS (self-referential / cross-table)
ALTER TABLE purchase_order
    ADD CONSTRAINT fk_po_created_by
    FOREIGN KEY (created_by_emp_id) REFERENCES "user"(emp_id) ON DELETE SET NULL;

ALTER TABLE certification
    ADD CONSTRAINT fk_cert_approved_by
    FOREIGN KEY (approved_by_emp_id) REFERENCES "user"(emp_id) ON DELETE SET NULL;

-- IMMUTABILITY TRIGGER — CERTIFICATION
-- Prevents any UPDATE to a certification row once is_immutable = TRUE
CREATE OR REPLACE FUNCTION enforce_certification_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_immutable = TRUE THEN
        RAISE EXCEPTION
            'Certification % is immutable and cannot be modified.', OLD.certification_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_certification_immutable
    BEFORE UPDATE ON certification
    FOR EACH ROW
    EXECUTE FUNCTION enforce_certification_immutability();

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_supplier_updated_at       BEFORE UPDATE ON supplier            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_part_updated_at           BEFORE UPDATE ON part                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_spec_updated_at           BEFORE UPDATE ON part_baseline_spec  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_po_updated_at             BEFORE UPDATE ON purchase_order       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_shipment_updated_at       BEFORE UPDATE ON shipment             FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_qcreport_updated_at       BEFORE UPDATE ON qc_report            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_equipment_updated_at      BEFORE UPDATE ON equipment            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_iot_device_updated_at     BEFORE UPDATE ON iot_device           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_updated_at           BEFORE UPDATE ON "user"               FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- INDEXES

-- Supplier & Parts
CREATE INDEX idx_supplier_accreditation    ON supplier(accreditation);
CREATE INDEX idx_spo_supplier              ON supplier_part_offering(supplier_id);
CREATE INDEX idx_spo_part                  ON supplier_part_offering(part_id);
CREATE INDEX idx_spf_supplier_part         ON supplier_part_feature(supplier_part_id);

-- Orders
CREATE INDEX idx_po_supplier               ON purchase_order(supplier_id);
CREATE INDEX idx_po_status                 ON purchase_order(status);
CREATE INDEX idx_po_order_date             ON purchase_order(order_date);
CREATE INDEX idx_pol_order                 ON purchase_order_line(order_id);
CREATE INDEX idx_pol_supplier_part         ON purchase_order_line(supplier_part_id);

-- Shipments
CREATE INDEX idx_shipment_order            ON shipment(order_id);
CREATE INDEX idx_shipment_tracking         ON shipment(tracking_number);
CREATE INDEX idx_delivered_item_shipment   ON delivered_item(shipment_id);
CREATE INDEX idx_delivered_item_order_line ON delivered_item(order_line_id);

-- QC & Certification
CREATE INDEX idx_qc_report_item            ON qc_report(delivered_item_id);
CREATE INDEX idx_qc_report_status          ON qc_report(current_status);
CREATE INDEX idx_cert_item                 ON certification(delivered_item_id);
CREATE INDEX idx_cert_immutable            ON certification(is_immutable);

-- IoT
CREATE INDEX idx_iot_device_assignment     ON iot_device(assigned_to_type, assigned_to_id);

-- Audit
CREATE INDEX idx_audit_emp                 ON audit_log(emp_id);
CREATE INDEX idx_audit_entity              ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created             ON audit_log(created_at DESC);
CREATE INDEX idx_audit_action              ON audit_log(action_type);

-- RBAC
CREATE INDEX idx_user_role_emp             ON user_role(emp_id);
CREATE INDEX idx_role_permission_role      ON role_permission(role_id);

-- SEED DATA: ROLES AND PERMISSIONS

INSERT INTO role (role_name, description) VALUES
    ('PROCUREMENT_OFFICER',  'Creates and manages supplier records and purchase orders'),
    ('QUALITY_INSPECTOR',    'Creates QC reports and approves certifications'),
    ('SUPPLY_CHAIN_MANAGER', 'Monitors shipments and supplier KPIs; may approve escalations'),
    ('EQUIPMENT_ENGINEER',   'Monitors IoT feeds and schedules equipment maintenance'),
    ('AUDITOR',              'Read-only access for compliance review; can flag issues');

INSERT INTO permission (permission_name, scope) VALUES
    ('READ',    'SUPPLIERS'),    ('WRITE',   'SUPPLIERS'),
    ('READ',    'PARTS'),        ('WRITE',   'PARTS'),
    ('READ',    'ORDERS'),       ('WRITE',   'ORDERS'),
    ('READ',    'SHIPMENTS'),    ('WRITE',   'SHIPMENTS'),
    ('READ',    'QC_REPORTS'),   ('WRITE',   'QC_REPORTS'),   ('APPROVE', 'QC_REPORTS'),
    ('READ',    'CERTIFICATIONS'),('APPROVE','CERTIFICATIONS'),
    ('READ',    'IOT_DATA'),     ('WRITE',   'IOT_DATA'),
    ('READ',    'USERS'),        ('WRITE',   'USERS'),
    ('READ',    'AUDIT_LOGS'),   ('AUDIT',   'AUDIT_LOGS'),
    ('READ',    'EQUIPMENT'),    ('WRITE',   'EQUIPMENT');

-- Procurement Officer: full access to suppliers, parts, orders, shipments (read)
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM role r, permission p
WHERE r.role_name = 'PROCUREMENT_OFFICER'
  AND (
        (p.permission_name IN ('READ','WRITE') AND p.scope IN ('SUPPLIERS','PARTS','ORDERS'))
     OR (p.permission_name = 'READ'           AND p.scope IN ('SHIPMENTS','CERTIFICATIONS'))
  );

-- Quality Inspector: read orders/shipments, full QC + certifications
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM role r, permission p
WHERE r.role_name = 'QUALITY_INSPECTOR'
  AND (
        (p.permission_name = 'READ'                   AND p.scope IN ('ORDERS','SHIPMENTS','PARTS'))
     OR (p.permission_name IN ('READ','WRITE','APPROVE') AND p.scope = 'QC_REPORTS')
     OR (p.permission_name IN ('READ','APPROVE')        AND p.scope = 'CERTIFICATIONS')
  );

-- Supply Chain Manager: broad read, may approve escalations
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM role r, permission p
WHERE r.role_name = 'SUPPLY_CHAIN_MANAGER'
  AND p.permission_name = 'READ'
  AND p.scope IN ('SUPPLIERS','PARTS','ORDERS','SHIPMENTS','QC_REPORTS','CERTIFICATIONS');

-- Equipment Engineer: IoT + equipment read/write
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM role r, permission p
WHERE r.role_name = 'EQUIPMENT_ENGINEER'
  AND (
        (p.permission_name IN ('READ','WRITE') AND p.scope IN ('IOT_DATA','EQUIPMENT'))
     OR (p.permission_name = 'READ'           AND p.scope IN ('SHIPMENTS','ORDERS'))
  );

-- Auditor: read-only everything + audit logs
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM role r, permission p
WHERE r.role_name = 'AUDITOR'
  AND (
        (p.permission_name = 'READ'  AND p.scope IN ('SUPPLIERS','PARTS','ORDERS','SHIPMENTS','QC_REPORTS','CERTIFICATIONS','IOT_DATA','EQUIPMENT'))
     OR (p.permission_name IN ('READ','AUDIT') AND p.scope = 'AUDIT_LOGS')
  );
