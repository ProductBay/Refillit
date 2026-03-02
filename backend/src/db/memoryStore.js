const { randomUUID } = require("node:crypto");

const TABLES = {
  users: [],
  doctor_profiles: [],
  patient_profiles: [],
  pharmacy_profiles: [],
  nhf_profiles: [],
  courier_profiles: [],
  prescriptions: [],
  orders: [],
  nhf_claims: [],
  nhf_payout_runs: [],
  nhf_disputes: [],
  nhf_resolution_events: [],
  audit_logs: [],
  chat_threads: [],
  chat_messages: [],
  doctor_private_notes: [],
  doctor_connections: [],
  doctor_reception_access: [],
  appointment_availability: [],
  appointments: [],
  doctor_prescription_templates: [],
  doctor_favorite_meds: [],
  appointment_waitlist: [],
  referrals: [],
  pharmacy_interventions: [],
  shared_care_notes: [],
  soap_notes: [],
  consent_records: [],
  care_instruction_broadcasts: [],
  refill_requests: [],
  patient_medication_reminders: [],
  patient_visit_prep_items: [],
  patient_care_tasks: [],
  patient_proxy_access: [],
  installment_proposals: [],
  compliance_report_snapshots: [],
  moh_export_jobs: [],
  moh_policies: [],
  moh_clinical_catalog_entries: [],
  payment_intents: [],
  wallet_ledger: [],
  nhf_credit_ledger: [],
  entity_registrations: [],
  otc_products: [],
  pharmacy_otc_inventory: [],
  otc_order_items: [],
  demo_nda_acceptances: [],
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const nowIso = () => new Date().toISOString();

class MemoryModel {
  static table = null;

  static fields = [];

  static reset() {
    TABLES[this.table] = [];
  }

  static _hydrate(data) {
    return new this(data);
  }

  static _match(row, where = {}) {
    return Object.entries(where).every(([key, val]) => row[key] === val);
  }

  static async create(payload) {
    const row = {
      id: payload.id || randomUUID(),
      createdAt: payload.createdAt || nowIso(),
      updatedAt: payload.updatedAt || nowIso(),
      ...payload,
    };
    TABLES[this.table].push(row);
    return this._hydrate(clone(row));
  }

  static async findOne({ where = {} } = {}) {
    const row = TABLES[this.table].find((entry) => this._match(entry, where));
    return row ? this._hydrate(clone(row)) : null;
  }

  static async findByPk(id) {
    const row = TABLES[this.table].find((entry) => entry.id === id);
    return row ? this._hydrate(clone(row)) : null;
  }

  static async findAll({ where = {}, limit, offset = 0 } = {}) {
    const rows = TABLES[this.table].filter((entry) => this._match(entry, where));
    const paged =
      typeof limit === "number" ? rows.slice(offset, offset + limit) : rows.slice(offset);
    return paged.map((entry) => this._hydrate(clone(entry)));
  }

  static async count({ where = {} } = {}) {
    return TABLES[this.table].filter((entry) => this._match(entry, where)).length;
  }

  static async destroy({ where = {} } = {}) {
    const before = TABLES[this.table].length;
    TABLES[this.table] = TABLES[this.table].filter((entry) => !this._match(entry, where));
    return before - TABLES[this.table].length;
  }

  constructor(payload) {
    Object.assign(this, payload);
  }

  async save() {
    const index = TABLES[this.constructor.table].findIndex((entry) => entry.id === this.id);
    if (index === -1) {
      TABLES[this.constructor.table].push(clone(this));
    } else {
      this.updatedAt = nowIso();
      TABLES[this.constructor.table][index] = clone(this);
    }
    return this;
  }
}

const listTableNames = () => Object.keys(TABLES);

const truncateTables = () => {
  for (const name of listTableNames()) {
    TABLES[name] = [];
  }
};

module.exports = {
  MemoryModel,
  TABLES,
  listTableNames,
  truncateTables,
};
