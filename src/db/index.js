'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let db;
let txDepth = 0;

function open(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

function conn() {
  if (!db) open();
  return db;
}

const stmtCache = new Map();
function prepare(sql) {
  const d = conn();
  let s = stmtCache.get(sql);
  if (!s || s._db !== d) {
    s = d.prepare(sql);
    s._db = d;
    stmtCache.set(sql, s);
  }
  return s;
}

const get = (sql, ...params) => prepare(sql).get(...params);
const all = (sql, ...params) => prepare(sql).all(...params);
const run = (sql, ...params) => prepare(sql).run(...params);

// Insert a row from an object; keys become columns.
function insert(table, row) {
  const cols = Object.keys(row);
  run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => row[c]));
  return row;
}

function update(table, id, fields, idCol = 'id') {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${idCol} = ?`,
    ...cols.map((c) => fields[c]), id);
}

// Run fn atomically. Nested calls join the outer transaction (savepoints keep inner failures contained).
function tx(fn) {
  const d = conn();
  const name = `sp${txDepth}`;
  d.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    d.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    txDepth--;
    d.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  }
}

function close() {
  if (db) db.close();
  db = undefined;
  stmtCache.clear();
  txDepth = 0;
}

module.exports = { open, conn, get, all, run, insert, update, tx, close };
