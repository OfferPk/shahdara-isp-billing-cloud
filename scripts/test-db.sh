#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGHOST_LOCAL="/var/run/postgresql"
PGPORT_LOCAL="5432"
DB_NAME="shahdara_disposable_${USER:-ci}_$(date +%s)_$$"
TEST_TMP="$(mktemp -d /tmp/shahdara-pgtap.XXXXXX)"
chmod 755 "$TEST_TMP"

if [[ -n "${PGHOST:-}" && "${PGHOST}" != "$PGHOST_LOCAL" ]]; then
  echo "Refusing non-local PostgreSQL host; this runner only accepts $PGHOST_LOCAL." >&2
  exit 2
fi
if [[ -n "${DATABASE_URL:-}" || -n "${PGSERVICE:-}" || -n "${PGSERVICEFILE:-}" ]]; then
  echo "Refusing DATABASE_URL/PGSERVICE; this runner accepts only the local PostgreSQL socket." >&2
  exit 2
fi
if ! command -v pg_prove >/dev/null || ! command -v psql >/dev/null; then
  echo "Install PostgreSQL client and pgTAP/pg_prove before running test:db." >&2
  exit 2
fi
if ! pg_isready -h "$PGHOST_LOCAL" -p "$PGPORT_LOCAL" >/dev/null 2>&1; then
  echo "Local PostgreSQL is not accepting connections on $PGHOST_LOCAL:$PGPORT_LOCAL." >&2
  exit 2
fi

as_postgres() {
  sudo -u postgres env -u DATABASE_URL -u PGSERVICE -u PGSERVICEFILE \
    -u PGUSER -u PGDATABASE -u PGPASSWORD -u PGOPTIONS \
    PGHOST="$PGHOST_LOCAL" PGPORT="$PGPORT_LOCAL" PGUSER=postgres "$@"
}
cleanup() {
  as_postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT

as_postgres createdb "$DB_NAME"
run_psql() {
  as_postgres psql -X -v ON_ERROR_STOP=1 -d "$DB_NAME" "$@"
}

cd "$ROOT"
echo "Creating disposable local database: $DB_NAME"
run_psql < "$ROOT/supabase/tests/bootstrap.local.sql" >/dev/null
while IFS= read -r migration; do
  echo "Applying local migration: ${migration##*/}"
  run_psql < "$migration" >/dev/null
done < <(find "$ROOT/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print | sort)

cp "$ROOT/supabase/tests/pppoe_usage.test.sql" "$TEST_TMP/"
chmod 644 "$TEST_TMP/pppoe_usage.test.sql"
echo "Executing the PPPoE RLS/transaction pgTAP suite against $DB_NAME (local Unix socket only)."
as_postgres env PGDATABASE="$DB_NAME" PGOPTIONS='-c search_path=public,extensions' \
  pg_prove --verbose "$TEST_TMP/pppoe_usage.test.sql"

echo "Disposable PPPoE database tests passed; dropping $DB_NAME."
