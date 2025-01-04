// init_db.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'judge_dashboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Execute schema creation for Superintendent, Judge, Police, and CBI dashboards
const initSchema = () => {
  const schema = `
    -- Superintendent Criminal Table
    CREATE TABLE IF NOT EXISTS SUPERINTENDENT_CRIMINAL (
        criminal_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER NOT NULL,
        gender TEXT NOT NULL,
        nationality TEXT NOT NULL,
        photo TEXT,
        cell_number TEXT,
        jail_name TEXT
    );

    -- Crimes Table
    CREATE TABLE IF NOT EXISTS CRIMES (
        crime_id INTEGER PRIMARY KEY AUTOINCREMENT,
        criminal_id TEXT NOT NULL,
        crime_type TEXT NOT NULL,
        crime_details TEXT NOT NULL,
        crime_date TEXT NOT NULL,
        FOREIGN KEY(criminal_id) REFERENCES SUPERINTENDENT_CRIMINAL(criminal_id)
    );

    -- Biometrics Table
    CREATE TABLE IF NOT EXISTS BIOMETRICS (
        biometric_id INTEGER PRIMARY KEY AUTOINCREMENT,
        criminal_id TEXT UNIQUE NOT NULL,
        photo_front TEXT,
        photo_side TEXT,
        photo_back TEXT,
        blood_group TEXT NOT NULL,
        fingerprint TEXT,
        retina_scan TEXT,
        dna_info TEXT NOT NULL,
        FOREIGN KEY(criminal_id) REFERENCES SUPERINTENDENT_CRIMINAL(criminal_id)
    );

    -- Meeting Records Table
    CREATE TABLE IF NOT EXISTS MEETING_RECORDS (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        criminal_id TEXT NOT NULL,
        outsider_name TEXT NOT NULL,
        meeting_date TEXT NOT NULL,
        details TEXT NOT NULL,
        FOREIGN KEY(criminal_id) REFERENCES SUPERINTENDENT_CRIMINAL(criminal_id)
    );

    -- Health Records Table
    CREATE TABLE IF NOT EXISTS HEALTH_RECORDS (
        health_id INTEGER PRIMARY KEY AUTOINCREMENT,
        criminal_id TEXT UNIQUE NOT NULL,
        health_condition TEXT NOT NULL,
        FOREIGN KEY(criminal_id) REFERENCES SUPERINTENDENT_CRIMINAL(criminal_id)
    );

    -- Assign Works Table
    CREATE TABLE IF NOT EXISTS ASSIGN_WORKS (
        assign_id INTEGER PRIMARY KEY AUTOINCREMENT,
        criminal_id TEXT NOT NULL,
        work_description TEXT NOT NULL,
        assign_date TEXT NOT NULL,
        FOREIGN KEY(criminal_id) REFERENCES SUPERINTENDENT_CRIMINAL(criminal_id)
    );

    -- Users Table (Updated to include 'email' and 'role')
    CREATE TABLE IF NOT EXISTS USERS (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL
    );

    -- Judge Case Table
    CREATE TABLE IF NOT EXISTS JUDGE_CASE (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL UNIQUE,
        case_name TEXT NOT NULL,
        judge TEXT NOT NULL,
        hearing_date TEXT NOT NULL
    );

    -- Police Jail Table
    CREATE TABLE IF NOT EXISTS POLICE_JAIL (
        criminal_id TEXT PRIMARY KEY,
        jail_name TEXT NOT NULL,
        cell_number TEXT NOT NULL,
        FOREIGN KEY(criminal_id) REFERENCES SUPERINTENDENT_CRIMINAL(criminal_id)
    );

    -- CBI Case Reports Table
    CREATE TABLE IF NOT EXISTS CBI_CASE_REPORTS (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT UNIQUE NOT NULL,
        case_name TEXT NOT NULL,
        description TEXT NOT NULL
    );

    -- CBI Evidence Table
    CREATE TABLE IF NOT EXISTS CBI_EVIDENCE (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL,
        evidence_description TEXT NOT NULL,
        evidence_file TEXT NOT NULL,
        date_added TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(case_id) REFERENCES CBI_CASE_REPORTS(case_id)
    );

  `;

  db.exec(schema, (err) => {
    if (err) {
      console.error('Error creating tables:', err.message);
    } else {
      console.log('Database schema initialized.');
    }
  });
};

// Initialize the database schema
initSchema();

// Export the database connection for use in other modules
module.exports = db;
