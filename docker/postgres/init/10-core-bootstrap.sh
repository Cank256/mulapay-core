#!/bin/sh
# Runs once, when the dev Postgres volume is first created. Applies the same bootstrap
# SQL that a DBA runs in other environments (src/db/bootstrap/001_*.sql).
# Development passwords only; never reuse them elsewhere.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v rw_password="${CORE_RW_PASSWORD:-core_rw_dev}" \
  -v ro_password="${CORE_RO_PASSWORD:-core_ro_dev}" \
  -v statement_timeout=15s \
  -v idle_tx_timeout=10s \
  -f /bootstrap/001_core_roles_and_schema.sql
