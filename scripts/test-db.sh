#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_FILE_RELATIVE="supabase/tests/organization_branding.test.sql"
TEST_FILE="$ROOT/$TEST_FILE_RELATIVE"
TEST_TMP=""
PGDATA=""
SOCKET_DIR=""
PGPORT_LOCAL="$((50000 + $$ % 10000))"
DB_NAME="shahdara_disposable_$(date +%s)_$$"
DB_CREATED=false

refuse_database_environment() {
  local name
  local found=()
  while IFS='=' read -r name _; do
    [[ -n "${!name:-}" ]] || continue
    if [[ "$name" =~ ^PG[A-Z0-9_]*$ \
       || "$name" =~ ^DATABASE(_.*)?$ \
       || "$name" =~ ^DIRECT_URL$ \
       || "$name" =~ ^SHADOW_DATABASE_URL$ \
       || "$name" =~ ^POSTGRES(QL)?(_.*)?$ \
       || "$name" =~ ^DB(_.*)?$ \
       || "$name" =~ ^SUPABASE_DB(_.*)?$ \
       || "$name" =~ ^SUPABASE_POSTGRES(_.*)?$ \
       || "$name" =~ ^SUPABASE_DATABASE_URL$ \
       || "$name" =~ ^(PRISMA|NEON|TURSO|MYSQL)_DATABASE_URL$ \
       || "$name" =~ ^(JDBC|CONNECTION)(_STRING|_URL)?$ ]]; then
      found+=("$name")
    fi
  done < <(env)

  if ((${#found[@]})); then
    printf 'Refusing inherited database connection configuration (%s); test:db uses only its own disposable local cluster.\n' "$(IFS=', '; echo "${found[*]}")" >&2
    return 2
  fi
}

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ -d "$PGDATA" ]]; then
    if [[ "$DB_CREATED" == true ]]; then
      as_postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
    fi
    if as_postgres "$PG_CTL" -D "$PGDATA" status >/dev/null 2>&1; then
      if ! as_postgres "$PG_CTL" -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1; then
        echo "Could not stop the disposable PostgreSQL cluster cleanly." >&2
        result=1
      fi
    fi
  fi
  case "$TEST_TMP" in
    /tmp/shahdara-pgtap.*)
      if ! sudo -n rm -rf -- "$TEST_TMP"; then
        echo "Could not remove disposable PostgreSQL artifacts at $TEST_TMP." >&2
        result=1
      fi
      ;;
    *) echo "Refusing to remove unexpected temporary path: $TEST_TMP" >&2; result=1 ;;
  esac
  exit "$result"
}

refuse_database_environment

for command_name in sudo pg_config pg_isready psql createdb dropdb pg_prove; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name (install PostgreSQL 16 and pgTAP first)." >&2
    exit 2
  fi
done

if ! pg_config --version | grep -Eq '^PostgreSQL 16([.]|$)'; then
  echo "PostgreSQL 16 is required; pg_config reports: $(pg_config --version)." >&2
  exit 2
fi
PG_BINDIR="$(pg_config --bindir)"
PG_SHAREDIR="$(pg_config --sharedir)"
PG_CTL="$PG_BINDIR/pg_ctl"
INITDB="$PG_BINDIR/initdb"
for executable in "$PG_CTL" "$INITDB"; do
  if [[ ! -x "$executable" ]]; then
    echo "Missing PostgreSQL server executable: $executable" >&2
    exit 2
  fi
done
for extension in pgtap pgcrypto; do
  if [[ ! -f "$PG_SHAREDIR/extension/$extension.control" ]]; then
    echo "Missing PostgreSQL extension $extension; install pgTAP and PostgreSQL contrib packages." >&2
    exit 2
  fi
done
if ! sudo -n -u postgres true >/dev/null 2>&1; then
  echo "This runner needs passwordless sudo access to the local postgres OS account to create its disposable cluster." >&2
  exit 2
fi
if [[ ! -f "$TEST_FILE" ]]; then
  echo "Missing selected pgTAP suite: $TEST_FILE" >&2
  exit 2
fi

as_postgres() {
  sudo -n -u postgres env -i \
    PATH="$PATH" HOME=/var/lib/postgresql LANG=C.UTF-8 \
    PGHOST="$SOCKET_DIR" PGPORT="$PGPORT_LOCAL" PGUSER=postgres "$@"
}

TEST_TMP="$(mktemp -d /tmp/shahdara-pgtap.XXXXXX)"
PGDATA="$TEST_TMP/pgdata"
SOCKET_DIR="$TEST_TMP/socket"
trap cleanup EXIT
chmod 755 "$TEST_TMP"
sudo -n chown postgres:postgres "$TEST_TMP"
sudo -n -u postgres mkdir "$PGDATA" "$SOCKET_DIR"
sudo -n -u postgres "$INITDB" \
  --no-instructions --username=postgres --auth-local=trust --auth-host=reject \
  --encoding=UTF8 "$PGDATA" >/dev/null

printf 'Starting a disposable PostgreSQL 16 cluster with Unix-socket-only access.\n'
as_postgres "$PG_CTL" -D "$PGDATA" \
  -l "$PGDATA/server.log" \
  -o "-F -p $PGPORT_LOCAL -k $SOCKET_DIR -c listen_addresses= -c unix_socket_permissions=0700" \
  -w start >/dev/null
if ! as_postgres pg_isready -h "$SOCKET_DIR" -p "$PGPORT_LOCAL" >/dev/null; then
  echo "Disposable PostgreSQL did not become ready on its private Unix socket." >&2
  sudo -n -u postgres cat "$PGDATA/server.log" >&2 || true
  exit 1
fi

as_postgres createdb --template=template0 --encoding=UTF8 "$DB_NAME"
DB_CREATED=true
run_psql() {
  as_postgres psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname="$DB_NAME" "$@"
}

printf 'Creating empty disposable database: %s\n' "$DB_NAME"
run_psql < "$ROOT/supabase/tests/bootstrap.local.sql" >/dev/null

mapfile -d '' MIGRATIONS < <(find "$ROOT/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z)
if ((${#MIGRATIONS[@]} == 0)); then
  echo "No repository migrations found under supabase/migrations." >&2
  exit 1
fi
for migration in "${MIGRATIONS[@]}"; do
  printf 'Applying repository migration locally: %s\n' "${migration##*/}"
  run_psql < "$migration" >/dev/null
done

printf 'Running the current organization_branding pgTAP suite (35 planned assertions).\n'
(
  cd "$ROOT"
  as_postgres env PGDATABASE="$DB_NAME" PGOPTIONS='-c search_path=public,extensions' \
    pg_prove --verbose "$TEST_FILE_RELATIVE"
)
printf 'pgTAP suite passed; removing disposable database and PostgreSQL cluster.\n'
