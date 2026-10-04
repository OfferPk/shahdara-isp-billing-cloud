#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pg_bin="/usr/lib/postgresql/16/bin"
for binary in initdb pg_ctl; do
  if [[ ! -x "$pg_bin/$binary" ]]; then
    echo "Missing PostgreSQL server binary: $pg_bin/$binary" >&2
    exit 2
  fi
done
if ! command -v sudo >/dev/null || ! sudo -n -u postgres true; then
  echo 'This runner needs passwordless local sudo access to start an isolated postgres-owned cluster.' >&2
  exit 2
fi

port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
data_dir="$(mktemp -d /tmp/shahdara-customer-auth-pg.XXXXXX)"
sudo -n chown postgres:postgres "$data_dir"
started=0
cleanup() {
  if [[ "$started" == 1 ]]; then
    sudo -n -u postgres "$pg_bin/pg_ctl" -D "$data_dir" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  sudo -n rm -rf -- "$data_dir"
}
trap cleanup EXIT INT TERM

sudo -n -u postgres "$pg_bin/initdb" -D "$data_dir" --auth-local=trust --auth-host=trust --no-instructions >/dev/null
sudo -n -u postgres "$pg_bin/pg_ctl" -D "$data_dir" -o "-F -p $port -h 127.0.0.1" -l "$data_dir/postgres.log" -w start >/dev/null
started=1
createdb --host 127.0.0.1 --port "$port" --username postgres synthetic_customer_auth_test
psql --no-psqlrc --set ON_ERROR_STOP=1 --host 127.0.0.1 --port "$port" --username postgres --dbname synthetic_customer_auth_test \
  --file "$repo_root/tests/local-customer-auth-fixture.sql"
psql --no-psqlrc --set ON_ERROR_STOP=1 --host 127.0.0.1 --port "$port" --username postgres --dbname synthetic_customer_auth_test \
  --file "$repo_root/supabase/migrations/20261002180000_customer_temporary_password_auth.sql"
psql --no-psqlrc --set ON_ERROR_STOP=1 --host 127.0.0.1 --port "$port" --username postgres --dbname synthetic_customer_auth_test \
  --file "$repo_root/supabase/migrations/20261003200536_add_customer_pppoe_username_mapping.sql"
psql --no-psqlrc --set ON_ERROR_STOP=1 --host 127.0.0.1 --port "$port" --username postgres --dbname synthetic_customer_auth_test \
  --file "$repo_root/supabase/migrations/20261004091620_staging_pppoe_test_portal_login.sql"
psql --no-psqlrc --set ON_ERROR_STOP=1 --host 127.0.0.1 --port "$port" --username postgres --dbname synthetic_customer_auth_test \
  --file "$repo_root/tests/local-customer-auth-assertions.sql"

echo 'Disposable PostgreSQL cluster stopped and removed by the exit trap.'
