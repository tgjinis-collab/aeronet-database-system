// ─── Drop & recreate for clean seed ──────────────────────────────────────────
db = db.getSiblingDB("aeronetb_db");

// COLLECTION 1: qc_reports
// Source: Dim_NDT_report.json + EnvironmentalTest_report.json
//
// Design rationale:
//   - Each document = one QC report with all its versions embedded as an array.
//   - _pgRef links back to the qc_report_id primary key in PostgreSQL.
//   - report_type and current_status are duplicated from PostgreSQL for
//     convenience when querying MongoDB without a join.
//   - versions[] allows full audit trail of edits without a separate collection.
//   - results is a flexible object — schema varies by report_type (Dimensional,
//     NDT, Environmental, Visual), so a document model is ideal here.

db.qc_reports.drop();
db.createCollection("qc_reports", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["reportId", "_pgRef", "partId", "report_type", "current_status", "inspector", "inspectionDate", "versions"],
      properties: {
        reportId:       { bsonType: "string",  description: "Human-readable report ID (e.g. QC-784512-A1)" },
        _pgRef:         { bsonType: "string",  description: "PostgreSQL qc_report_id UUID for cross-DB lookup" },
        partId:         { bsonType: "string",  description: "Manufacturer part number (mirrors PostgreSQL part.part_name)" },
        report_type:    { bsonType: "string",  enum: ["DIMENSIONAL_CHECK","NON_DESTRUCTIVE_TESTING","ENVIRONMENTAL_STRESS","VISUAL_INSPECTION"] },
        current_status: { bsonType: "string",  enum: ["DRAFT","SUBMITTED","APPROVED","REJECTED"] },
        inspector:      { bsonType: "object" },
        inspectionDate: { bsonType: "string" },
        versions:       { bsonType: "array",   minItems: 1 }
      }
    }
  }
});

// ── Document 1: Dimensional Check + NDT (from Dim_NDT_report.json) ───────────
db.qc_reports.insertOne({
  reportId:        "QC-784512-A1",
  _pgRef:          "m1000000-0000-0000-0000-000000000001",   // PostgreSQL qc_report_id
  _pgRef_ndt:      "m1000000-0000-0000-0000-000000000002",   // second PG header row for NDT sub-report
  partId:          "A-320-WING-01",
  deliveredItemId: "j1000000-0000-0000-0000-000000000001",   // PostgreSQL delivered_item_id
  report_type:     "DIMENSIONAL_CHECK",                       // primary type
  current_status:  "APPROVED",
  inspector: {
    name:        "Jane Doe",
    employeeId:  "J.D.753",
    _pgEmpId:    "f1000000-0000-0000-0000-000000000002"       // PostgreSQL user.emp_id
  },
  inspectionDate: "2025-08-28",
  createdAt:      new Date("2025-08-28T09:00:00Z"),
  updatedAt:      new Date("2025-08-29T11:30:00Z"),

  // Full result payload — flexible per report_type
  results: {
    visualInspection: "Pass",
    dimensionalTolerance: {
      result: "Pass",
      measurements: [
        { dimension: "length", nominal: 15.000, measured: 15.002, unit: "m", tolerance: "+/-0.005" },
        { dimension: "width",  nominal: 3.500,  measured: 3.499,  unit: "m", tolerance: "+/-0.005" }
      ],
      maxDeviation:     0.002,
      deviationUnit:    "m",
      verdict:          "Within tolerance"
    },
    nonDestructiveTesting: {
      type:     "Ultrasonic",
      standard: "ASTM E2375",
      result:   "Pass",
      coverage: "100% of bond line",
      comments: "No internal defects detected. No delamination or void indications found."
    }
  },

  // Version history — new version per edit/re-inspection
  versions: [
    {
      versionNo:   1,
      createdAt:   new Date("2025-08-28T09:00:00Z"),
      createdBy:   { employeeId: "J.D.753", name: "Jane Doe", _pgEmpId: "f1000000-0000-0000-0000-000000000002" },
      status:      "SUBMITTED",
      summary:     "Initial submission. All checks passed.",
      resultSnapshot: {
        visualInspection:   "Pass",
        dimensionalResult:  "Pass",
        ndtResult:          "Pass"
      }
    },
    {
      versionNo:   2,
      createdAt:   new Date("2025-08-29T11:30:00Z"),
      createdBy:   { employeeId: "J.D.753", name: "Jane Doe", _pgEmpId: "f1000000-0000-0000-0000-000000000002" },
      status:      "APPROVED",
      summary:     "Approved by Chief Inspector following supervisor review.",
      resultSnapshot: {
        visualInspection:   "Pass",
        dimensionalResult:  "Pass",
        ndtResult:          "Pass"
      }
    }
  ],

  certification: {
    certifiedBy:  "John Smith",
    _pgCertRef:   "n1000000-0000-0000-0000-000000000001",
    certDate:     "2025-08-29",
    stamp:        "CertifiedOK"
  }
});

// ── Document 2: Environmental Stress Test (from EnvironmentalTest_report.json) ─
db.qc_reports.insertOne({
  reportId:        "QC-889234-Z9",
  _pgRef:          "m1000000-0000-0000-0000-000000000003",
  partId:          "B-737-FUSE-02",
  deliveredItemId: "j1000000-0000-0000-0000-000000000003",
  report_type:     "ENVIRONMENTAL_STRESS",
  current_status:  "APPROVED",
  inspector: {
    name:        "Ahmed Khan",
    employeeId:  "AK.455",
    _pgEmpId:    "f1000000-0000-0000-0000-000000000003"
  },
  inspectionDate: "2025-09-01",
  createdAt:      new Date("2025-09-01T08:00:00Z"),
  updatedAt:      new Date("2025-09-01T17:00:00Z"),

  results: {
    environmentalTest: {
      standard:           "MIL-STD-810H",
      temperatureRange:   "-55 to 70C",
      thermalCycleCount:  10,
      humidityExposure:   "95% RH for 48 hours",
      pressureAltitude:   "40,000 ft simulated",
      result:             "Pass"
    },
    postTestInspection: {
      visualResult:    "Pass",
      dimensionalDrift: {
        length: { before: 14.998, after: 14.998, unit: "m", delta: 0.000 },
        width:  { before: 5.201,  after: 5.201,  unit: "m", delta: 0.000 }
      },
      cracksOrWarping: false
    }
  },
  notes: "Component withstood environmental stress without cracking or warping. All post-test dimensions within nominal tolerance.",

  versions: [
    {
      versionNo:  1,
      createdAt:  new Date("2025-09-01T08:00:00Z"),
      createdBy:  { employeeId: "AK.455", name: "Ahmed Khan", _pgEmpId: "f1000000-0000-0000-0000-000000000003" },
      status:     "SUBMITTED",
      summary:    "Environmental stress test complete. All results nominal.",
      resultSnapshot: { environmentalResult: "Pass", cracksOrWarping: false }
    },
    {
      versionNo:  2,
      createdAt:  new Date("2025-09-01T17:00:00Z"),
      createdBy:  { employeeId: "J.D.753", name: "Jane Doe", _pgEmpId: "f1000000-0000-0000-0000-000000000002" },
      status:     "APPROVED",
      summary:    "Senior inspector review complete. Report approved.",
      resultSnapshot: { environmentalResult: "Pass", cracksOrWarping: false }
    }
  ]
});

// ── Indexes ───────────────────────────────────────────────────────────────────
db.qc_reports.createIndex({ reportId: 1 },        { unique: true });
db.qc_reports.createIndex({ _pgRef: 1 },           { unique: true });
db.qc_reports.createIndex({ deliveredItemId: 1 });
db.qc_reports.createIndex({ current_status: 1 });
db.qc_reports.createIndex({ "inspector.employeeId": 1 });
db.qc_reports.createIndex({ inspectionDate: 1 });

print("✓ qc_reports: 2 documents inserted");

// =============================================================================
// COLLECTION 2: certification_documents
// Source: Component_certification.pdf
//
// Design rationale:
//   - Binary content (PDF bytes, digital stamp, signature image) cannot be
//     stored efficiently in PostgreSQL. MongoDB GridFS handles large blobs;
//     for sub-16 MB PDFs we store a base64 ref + object-store URI here.
//   - materialTraceability[] is a variable-length list — ideal for a document.
//   - testResults[] structure varies by test type, so flexible schema wins.
//   - is_immutable is mirrored from PostgreSQL as a double-guard; the
//     application rejects writes if either flag is TRUE.
// =============================================================================

db.certification_documents.drop();
db.createCollection("certification_documents", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["certificationId", "_pgRef", "partId", "is_immutable", "approval"],
      properties: {
        certificationId: { bsonType: "string" },
        _pgRef:          { bsonType: "string",  description: "PostgreSQL certification.certification_id UUID" },
        is_immutable:    { bsonType: "bool",    description: "Mirrors PostgreSQL flag — write guard" }
      }
    }
  }
});

db.certification_documents.insertOne({
  certificationId:  "CERT-2025-AX-993",
  _pgRef:           "n1000000-0000-0000-0000-000000000001",  // PostgreSQL certification_id
  partId:           "A-320-WING-01",
  partName:         "Airbus A320 Wing Assembly",
  deliveredItemId:  "j1000000-0000-0000-0000-000000000001",

  supplier: {
    name:      "Global AeroParts Ltd.",
    _pgRef:    "a1000000-0000-0000-0000-000000000001"
  },
  certificationDate: new Date("2025-09-02T00:00:00Z"),
  createdAt:         new Date("2025-09-02T10:00:00Z"),

  inspector: {
    name:        "Jane Doe",
    employeeId:  "J.D.753",
    _pgEmpId:    "f1000000-0000-0000-0000-000000000002"
  },

  // Test results embedded — variable structure per test type
  testResults: [
    {
      testType: "Dimensional Check",
      result:   "Pass",
      details: {
        length:    "15.002 m",
        width:     "3.499 m",
        deviation: "0.002 m",
        verdict:   "Within AS9100 tolerance"
      }
    },
    {
      testType: "Non-Destructive Test",
      result:   "Pass",
      details: {
        method:   "Ultrasonic scan",
        coverage: "100% bond line",
        findings: "No internal defects detected"
      }
    },
    {
      testType: "Load Test",
      result:   "Pass",
      details: {
        loadApplied:  "150% rated capacity",
        deformation:  "None",
        verdict:      "Structural integrity confirmed"
      }
    }
  ],

  // Material traceability — variable number of batches
  materialTraceability: [
    {
      material:       "Aluminum Alloy 7075",
      batchId:        "ALU-BATCH-77X",
      _pgBatchRef:    "k1000000-0000-0000-0000-000000000001",
      originSupplier: "Hydro Aluminium, Germany",
      supplierCert:   "CERT-SUP-2025-442",
      certRef:        "s3://aeronetb-assets/supplier-certs/CERT-SUP-2025-442.pdf"
    },
    {
      material:       "Composite Resin X1",
      batchId:        "RES-BATCH-44P",
      _pgBatchRef:    "k1000000-0000-0000-0000-000000000002",
      originSupplier: "Hexion Inc., USA",
      supplierCert:   "CERT-SUP-2025-981",
      certRef:        "s3://aeronetb-assets/supplier-certs/CERT-SUP-2025-981.pdf"
    }
  ],

  approval: {
    certifiedBy:     "John Smith",
    title:           "Chief Inspector",
    _pgEmpId:        "f1000000-0000-0000-0000-000000000004",
    approvedAt:      new Date("2025-09-02T10:00:00Z"),
    digitalStamp:    "CertifiedOK",
    signatureRef:    "s3://aeronetb-assets/signatures/john.smith-2025-09-02.png",
    signatureMethod: "Electronically Signed — AeroNetB SecureSign v3"
  },

  // Document storage references
  documents: {
    pdfRef:       "s3://aeronetb-assets/certs/CERT-2025-AX-993.pdf",
    pdfChecksum:  "sha256:a3f5c92d8b1e4f07...",
    linkedQcReports: ["QC-784512-A1"]
  },

  is_immutable: true   // mirrors PostgreSQL — once true, no updates permitted
});

db.certification_documents.createIndex({ certificationId: 1 }, { unique: true });
db.certification_documents.createIndex({ _pgRef: 1 },           { unique: true });
db.certification_documents.createIndex({ deliveredItemId: 1 });
db.certification_documents.createIndex({ is_immutable: 1 });
db.certification_documents.createIndex({ "inspector.employeeId": 1 });

print("✓ certification_documents: 1 document inserted");

// =============================================================================
// COLLECTION 3: sensor_readings   (IoT time-series)
// Source: MEQuip_IoT.json — representative structure for equipment sensors
//
// Design rationale:
//   - Extremely high write volume (every device ticks every few seconds).
//   - Payload varies by device type (CNC mill = vibration + spindle load;
//     climate chamber = temperature + humidity; container = GPS + shock).
//   - Hot-path scalar fields (temperature, vibration, pressure, gpsPosition)
//     are top-level typed fields for fast range queries.
//   - rawReadings stores the full vendor JSON blob without transformation.
//   - TTL index expires readings older than 365 days automatically.
// =============================================================================

db.sensor_readings.drop();
db.createCollection("sensor_readings");

// ── Machine Sensor — CNC Mill Alpha-7 (equipment readings) ──────────────────
db.sensor_readings.insertMany([
  {
    deviceId:       "p1000000-0000-0000-0000-000000000001",
    deviceType:     "MACHINE_SENSOR",
    assignedToType: "EQUIPMENT",
    assignedToId:   "o1000000-0000-0000-0000-000000000001",  // CNC Mill Alpha-7
    equipmentName:  "CNC Milling Centre Alpha-7",
    facility:       "Hamburg Plant A",
    timestamp:      new Date("2025-09-01T06:00:00Z"),

    // Hot-path typed fields — indexed for dashboards
    temperature_c:  42.3,
    vibration_mm_s: 1.2,
    pressure_bar:   null,
    gpsPosition:    null,   // null for fixed equipment

    // Full vendor payload
    rawReadings: {
      spindleLoad_pct:    78.5,
      feedRate_mm_min:    800,
      coolantTemp_c:      22.1,
      coolantFlow_l_min:  12.4,
      axisPosition: { x: 104.22, y: 55.10, z: 12.00, unit: "mm" },
      alarmCodes:         [],
      toolId:             "T-04-ENDMILL-12MM"
    },
    anomaly: false
  },
  {
    deviceId:       "p1000000-0000-0000-0000-000000000001",
    deviceType:     "MACHINE_SENSOR",
    assignedToType: "EQUIPMENT",
    assignedToId:   "o1000000-0000-0000-0000-000000000001",
    equipmentName:  "CNC Milling Centre Alpha-7",
    facility:       "Hamburg Plant A",
    timestamp:      new Date("2025-09-01T06:05:00Z"),

    temperature_c:  43.8,   // slight rise — triggers soft alert at 45°C
    vibration_mm_s: 2.9,    // elevated — bearing check recommended
    pressure_bar:   null,
    gpsPosition:    null,

    rawReadings: {
      spindleLoad_pct:    82.1,
      feedRate_mm_min:    800,
      coolantTemp_c:      22.4,
      coolantFlow_l_min:  12.2,
      axisPosition: { x: 110.05, y: 55.10, z: 12.00, unit: "mm" },
      alarmCodes:         ["W-VIBRATION-HIGH"],
      toolId:             "T-04-ENDMILL-12MM"
    },
    anomaly: true,
    anomalyDetail: "Vibration threshold exceeded (>2.5 mm/s). Bearing inspection recommended."
  },

  // ── Climate Chamber — Environmental Test Room ──────────────────────────────
  {
    deviceId:       "p1000000-0000-0000-0000-000000000002",
    deviceType:     "MACHINE_SENSOR",
    assignedToType: "EQUIPMENT",
    assignedToId:   "o1000000-0000-0000-0000-000000000003",  // Climate Chamber CC-12
    equipmentName:  "Climate Chamber CC-12",
    facility:       "Seattle Plant B",
    timestamp:      new Date("2025-09-01T08:00:00Z"),

    temperature_c:  -54.8,  // part of -55 to 70C environmental test
    vibration_mm_s: null,
    pressure_bar:   0.101,  // atmospheric
    gpsPosition:    null,

    rawReadings: {
      humidity_pct:       95.2,
      chamberSetpoint_c: -55.0,
      heatingRate_c_min:  0.0,
      coolingRate_c_min:  0.5,
      testProfile:        "MIL-STD-810H-503.7",
      elapsedTestTime_min: 120,
      doorSealOk:          true
    },
    anomaly: false
  },

  // ── Container Tracker — Shipment in transit ───────────────────────────────
  {
    deviceId:       "p1000000-0000-0000-0000-000000000003",
    deviceType:     "CONTAINER_TRACKER",
    assignedToType: "SHIPMENT",
    assignedToId:   "i1000000-0000-0000-0000-000000000001",  // DHL Shipment
    facility:       null,
    timestamp:      new Date("2025-08-20T14:30:00Z"),

    temperature_c:  18.4,
    vibration_mm_s: 0.3,
    pressure_bar:   1.013,
    gpsPosition: {
      lat:      53.6305,
      lon:       9.9918,
      altitude_m: 12,
      accuracy_m: 4.2,
      locationText: "Hamburg Airport, Cargo Terminal 2"
    },

    rawReadings: {
      humidity_pct:      45.0,
      shockEvent:        false,
      batteryLevel_pct:  87,
      signalStrength_db: -72,
      containerSealIntact: true,
      carrierScan:       "DHL-SCAN-HAM-001"
    },
    anomaly: false
  },
  {
    deviceId:       "p1000000-0000-0000-0000-000000000003",
    deviceType:     "CONTAINER_TRACKER",
    assignedToType: "SHIPMENT",
    assignedToId:   "i1000000-0000-0000-0000-000000000001",
    facility:       null,
    timestamp:      new Date("2025-08-28T10:15:00Z"),

    temperature_c:  19.1,
    vibration_mm_s: 4.8,   // elevated during unloading
    pressure_bar:   1.013,
    gpsPosition: {
      lat:      51.4775,
      lon:      -0.4614,
      altitude_m: 25,
      accuracy_m: 3.1,
      locationText: "Heathrow Air Freight Terminal, London, UK"
    },

    rawReadings: {
      humidity_pct:      48.2,
      shockEvent:        false,
      batteryLevel_pct:  61,
      signalStrength_db: -68,
      containerSealIntact: true,
      carrierScan:       "DHL-SCAN-LHR-044"
    },
    anomaly: false
  }
]);

db.sensor_readings.createIndex({ deviceId: 1, timestamp: -1 });
db.sensor_readings.createIndex({ assignedToId: 1, timestamp: -1 });
db.sensor_readings.createIndex({ timestamp: -1 });
db.sensor_readings.createIndex({ anomaly: 1 });
// TTL: auto-expire readings older than 365 days
db.sensor_readings.createIndex({ timestamp: 1 }, { expireAfterSeconds: 31536000 });

print("✓ sensor_readings: 5 documents inserted");

// =============================================================================
// COLLECTION 4: shipment_events
// Checkpoint and condition update events for each shipment
//
// Design rationale:
//   - Structure varies by event_type (GPS checkpoint vs temperature alert vs
//     customs clearance note). A document model avoids sparse nullable columns.
//   - High append rate during active shipments.
//   - _pgShipmentRef links back to PostgreSQL shipment.shipment_id.
// =============================================================================

db.shipment_events.drop();
db.createCollection("shipment_events");

db.shipment_events.insertMany([
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000001",
    trackingNumber:  "DHL-AE-20250820-001",
    eventType:       "CHECKPOINT",
    timestamp:       new Date("2025-08-18T06:30:00Z"),
    location: {
      text:   "Hamburg Airport, Cargo Terminal 2, Germany",
      lat:    53.6305,
      lon:     9.9918
    },
    containerCondition: { sealIntact: true, tempOk: true, shockEvent: false },
    notes:           "Departed Hamburg. All seals intact."
  },
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000001",
    trackingNumber:  "DHL-AE-20250820-001",
    eventType:       "CHECKPOINT",
    timestamp:       new Date("2025-08-22T11:00:00Z"),
    location: {
      text:   "Charles de Gaulle CDG Hub, France",
      lat:    49.0097,
      lon:     2.5479
    },
    containerCondition: { sealIntact: true, tempOk: true, shockEvent: false },
    notes:           "Transit hub scan. No issues."
  },
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000001",
    trackingNumber:  "DHL-AE-20250820-001",
    eventType:       "CONDITION_UPDATE",
    timestamp:       new Date("2025-08-25T09:45:00Z"),
    location: {
      text:   "Heathrow Air Freight, Pre-customs hold area, UK",
      lat:    51.4775,
      lon:    -0.4614
    },
    containerCondition: {
      sealIntact:  true,
      tempOk:      true,
      shockEvent:  false,
      humidity_pct: 47.9,
      temperature_c: 18.6
    },
    notes:           "Customs hold — EASA documentation under review."
  },
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000001",
    trackingNumber:  "DHL-AE-20250820-001",
    eventType:       "CHECKPOINT",
    timestamp:       new Date("2025-08-28T14:30:00Z"),
    location: {
      text:   "AeroNetB Receiving Dock, Heathrow, UK",
      lat:    51.4700,
      lon:    -0.4550
    },
    containerCondition: { sealIntact: true, tempOk: true, shockEvent: false },
    notes:           "Delivered. Container seals intact. Transferred to QC holding area."
  },

  // ── Shipment 2: FedEx B737 Fuselage ────────────────────────────────────────
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000002",
    trackingNumber:  "FDX-AE-20250901-007",
    eventType:       "CHECKPOINT",
    timestamp:       new Date("2025-08-29T08:30:00Z"),
    location: {
      text:   "Seattle-Tacoma International Airport, USA",
      lat:    47.4502,
      lon:   -122.3088
    },
    containerCondition: { sealIntact: true, tempOk: true, shockEvent: false },
    notes:           "Departed Seattle. Fuselage barrel loaded in climate container."
  },
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000002",
    trackingNumber:  "FDX-AE-20250901-007",
    eventType:       "CONDITION_UPDATE",
    timestamp:       new Date("2025-08-31T16:00:00Z"),
    location: {
      text:   "FedEx International Hub, Memphis, USA",
      lat:    35.0421,
      lon:   -89.9762
    },
    containerCondition: {
      sealIntact:    true,
      tempOk:        true,
      shockEvent:    true,   // logged but within limits
      shockG:        3.1,
      shockLimit_G:  5.0
    },
    notes:           "Minor shock event (3.1G) during pallet transfer. Within 5G limit. No damage expected."
  },
  {
    _pgShipmentRef:  "i1000000-0000-0000-0000-000000000002",
    trackingNumber:  "FDX-AE-20250901-007",
    eventType:       "CHECKPOINT",
    timestamp:       new Date("2025-09-01T11:00:00Z"),
    location: {
      text:   "Gatwick Cargo Terminal, UK",
      lat:    51.1537,
      lon:    -0.1821
    },
    containerCondition: { sealIntact: true, tempOk: true, shockEvent: false },
    notes:           "Delivered. Shock event flagged for QC inspection prior to use."
  }
]);

db.shipment_events.createIndex({ _pgShipmentRef: 1, timestamp: 1 });
db.shipment_events.createIndex({ trackingNumber: 1 });
db.shipment_events.createIndex({ eventType: 1 });
db.shipment_events.createIndex({ "containerCondition.shockEvent": 1 });

print("✓ shipment_events: 7 documents inserted");

// =============================================================================
// COLLECTION 5: manufacturing_specs  (rich part specifications)
// Source: part_baseline_spec in PostgreSQL stores scalar fields;
//         MongoDB stores the rich binary references, free-form notes,
//         multimedia descriptions, and supplier-specific customisation blobs.
//
// Design rationale:
//   - CAD files, engineering drawings, prototype images are object-store refs
//     whose metadata (filename, version, upload date) varies per part.
//   - Supplier customisation details are per-supplier JSON blobs of
//     arbitrary depth — unsuitable for a relational column.
//   - Free-form technical notes have no fixed schema.
// =============================================================================

db.manufacturing_specs.drop();
db.createCollection("manufacturing_specs");

db.manufacturing_specs.insertMany([
  {
    _pgPartRef:      "b1000000-0000-0000-0000-000000000001",
    partManufId:     "A-320-WING-01",
    partName:        "Airbus A320 Wing Assembly",
    specRevision:    "Rev-C",
    lockedAt:        new Date("2025-01-15T00:00:00Z"),
    lockedBy:        "f1000000-0000-0000-0000-000000000002",

    documents: {
      cadModel: {
        uri:        "s3://aeronetb-assets/cad/A320-WING-01-v4.step",
        format:     "STEP AP242",
        version:    "v4.0",
        uploadedAt: new Date("2024-12-01T00:00:00Z"),
        fileSizeMb: 248.5
      },
      engineeringDrawing: {
        uri:        "s3://aeronetb-assets/drawings/A320-WING-01-DWG-r3.pdf",
        format:     "PDF/A-3",
        revision:   "r3",
        pages:      42,
        uploadedAt: new Date("2024-12-05T00:00:00Z")
      },
      prototypeMedia: [
        { uri: "s3://aeronetb-assets/media/A320-WING-01-proto-front.jpg", type: "image/jpeg", label: "Front view" },
        { uri: "s3://aeronetb-assets/media/A320-WING-01-proto-spar.jpg",  type: "image/jpeg", label: "Main spar close-up" },
        { uri: "s3://aeronetb-assets/media/A320-WING-01-xt.mp4",          type: "video/mp4",  label: "X-ray tomography scan" }
      ]
    },

    technicalNotes: [
      "Baseline locked at Rev-C. Any deviation from nominal dimensions requires an Engineering Change Request (ECR).",
      "The leading-edge skin must be stored horizontally. Vertical storage causes panel creep at ambient temperatures above 30°C.",
      "All machined surfaces must be deburred and inspected under 10x magnification before final anodise cycle."
    ],

    supplierCustomisations: {
      "a1000000-0000-0000-0000-000000000001": {
        supplierName:      "Global AeroParts Ltd.",
        _pgSpoRef:         "d1000000-0000-0000-0000-000000000001",
        rfid: {
          enabled:     true,
          standard:    "ISO 18000-6C",
          embedLocation: "Root rib, station 150mm from leading edge",
          chipModel:   "Impinj Monza R6"
        },
        coating: {
          type:        "Alodine 1200S",
          spec:        "MIL-DTL-5541 Type 2",
          thickness_um: 0.8
        },
        digitalTwin: {
          platform:    "Siemens Teamcenter",
          twinId:      "DT-A320-WING-01-GAP-0087",
          updatePolicy: "Updated at each production milestone"
        }
      },
      "a1000000-0000-0000-0000-000000000003": {
        supplierName: "AeroTech Structures S.A.",
        _pgSpoRef:    "d1000000-0000-0000-0000-000000000005",
        rfid: { enabled: false },
        coating: {
          type:    "Standard primer",
          spec:    "AMS 3100",
          notes:   "EU domestic orders only. RFID excluded per customer request."
        }
      }
    }
  },

  {
    _pgPartRef:   "b1000000-0000-0000-0000-000000000002",
    partManufId:  "B-737-FUSE-02",
    partName:     "Boeing 737 Fuselage Section",
    specRevision: "Rev-A",
    lockedAt:     new Date("2025-03-10T00:00:00Z"),
    lockedBy:     "f1000000-0000-0000-0000-000000000002",

    documents: {
      cadModel: {
        uri:        "s3://aeronetb-assets/cad/B737-FUSE-02-v2.step",
        format:     "STEP AP242",
        version:    "v2.0",
        uploadedAt: new Date("2025-02-20T00:00:00Z"),
        fileSizeMb: 312.0
      },
      engineeringDrawing: {
        uri:      "s3://aeronetb-assets/drawings/B737-FUSE-02-DWG-r1.pdf",
        format:   "PDF/A-3",
        revision: "r1",
        pages:    58,
        uploadedAt: new Date("2025-02-22T00:00:00Z")
      },
      prototypeMedia: [
        { uri: "s3://aeronetb-assets/media/B737-FUSE-02-barrel.jpg", type: "image/jpeg", label: "Barrel overview" }
      ]
    },

    technicalNotes: [
      "Barrel section joint tolerance ±0.5mm on all skin-panel interfaces. Exceeding tolerance requires shimming per Boeing BSS 7239.",
      "Interior frames must be inspected for edge cracks after chemical milling. Any crack >2mm is cause for rejection."
    ],

    supplierCustomisations: {
      "a1000000-0000-0000-0000-000000000002": {
        supplierName: "SkyForge Components Inc.",
        _pgSpoRef:    "d1000000-0000-0000-0000-000000000002",
        shockSensor: {
          model:        "DataTrace MPRF",
          placement:    "All four lift points",
          threshold_G:  5.0,
          logInterval_s: 60
        },
        container: {
          type:          "Climate-controlled ISO 20ft",
          tempRange_c:   "15 to 25",
          humidityRange: "40-60% RH"
        }
      }
    }
  }
]);

db.manufacturing_specs.createIndex({ _pgPartRef: 1 },   { unique: true });
db.manufacturing_specs.createIndex({ partManufId: 1 },   { unique: true });
db.manufacturing_specs.createIndex({ specRevision: 1 });

print("✓ manufacturing_specs: 2 documents inserted");

// =============================================================================
// SUMMARY
// =============================================================================
print("\n=== AeroNetB MongoDB Seed Complete ===");
print("Collections:");
db.getCollectionNames().forEach(n =>
  print("  " + n + ": " + db[n].countDocuments() + " docs")
);
