#!/bin/bash
# ============================================================
# BioGuardians - Database Migration Runner (MySQL 8.4)
#
# Applies SQL migrations from db/migrations/ in order.
# Tracks applied migrations in a journal table with SHA-256
# checksums to detect tampering with already-applied files.
#
# MySQL commits DDL implicitly, so a migration cannot share a
# transaction with its journal entry: the entry is written only
# after the file ran without errors. Every migration must be
# idempotent, so a migration that failed halfway can simply be
# run again.
#
# Usage:
#   ./db/migrate.sh                 # apply pending migrations
#   ./db/migrate.sh --status        # show migration status
#   ./db/migrate.sh --dry-run       # show what would be applied
#
# Environment:
#   DATABASE_URL (preferred; mysql://user:password@host:port/database)
#   Or, if DATABASE_URL is not set:
#     DB_HOST     (default: 127.0.0.1)
#     DB_PORT     (default: 3306)
#     DB_USER     (required)
#     DB_PASSWORD (required)
#     DB_NAME     (required)
#   MIGRATIONS_DIR (default: ./migrations relative to script)
# ============================================================
set -eu

# ---------- Configuration ----------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$SCRIPT_DIR/migrations}"

die()   { echo "ERROR: $*" >&2; exit 1; }

if [ -n "${DATABASE_URL:-}" ]; then
  # mysql://user:password@host[:port]/database[?params]
  re='^mysql://([^:@/]+):([^@]*)@([^:/]+)(:([0-9]+))?/([^?]+)'
  [[ "$DATABASE_URL" =~ $re ]] || die "DATABASE_URL must look like mysql://user:password@host:port/database"
  DB_USER="${BASH_REMATCH[1]}"
  DB_PASSWORD="${BASH_REMATCH[2]}"
  DB_HOST="${BASH_REMATCH[3]}"
  DB_PORT="${BASH_REMATCH[5]:-3306}"
  DB_NAME="${BASH_REMATCH[6]}"
else
  DB_HOST="${DB_HOST:-127.0.0.1}"
  DB_PORT="${DB_PORT:-3306}"
  : "${DB_USER:?DB_USER is required (set in .env or environment)}"
  : "${DB_PASSWORD:?DB_PASSWORD is required (set in .env or environment)}"
  : "${DB_NAME:?DB_NAME is required (set in .env or environment)}"
fi
CONN_LABEL="$DB_HOST:$DB_PORT/$DB_NAME"

# Credentials go through a private options file, not the command line.
MY_CNF="$(mktemp)"
trap 'rm -f "$MY_CNF"' EXIT
chmod 600 "$MY_CNF"
cat > "$MY_CNF" <<EOF
[client]
host=$DB_HOST
port=$DB_PORT
user=$DB_USER
password="$DB_PASSWORD"
default-character-set=utf8mb4
EOF

# utf8mb4 is required: the client defaults to latin1, which corrupts accents.
MYSQL_BASE="mysql --defaults-extra-file=$MY_CNF --protocol=TCP $DB_NAME"

# ---------- Helpers ----------
log()   { echo "   $*"; }
header(){ echo "==> $*"; }

# Wait for database to be ready
wait_for_db() {
    header "Waiting for database at $CONN_LABEL..."
    for i in $(seq 1 30); do
        if $MYSQL_BASE -N -e "SELECT 1" >/dev/null 2>&1; then
            log "Database is ready."
            return 0
        fi
        log "Attempt $i/30..."
        sleep 1
    done
    die "Could not connect to database at $CONN_LABEL after 30 attempts."
}

# Ensure journal table exists
ensure_journal() {
    header "Ensuring migration journal exists..."
    $MYSQL_BASE <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    filename   VARCHAR(255) NOT NULL UNIQUE,
    checksum   VARCHAR(64)  NOT NULL,
    applied_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
SQL
}

# Get applied migrations as "filename|checksum" lines
get_applied() {
    $MYSQL_BASE -N -B -e \
        "SELECT CONCAT(filename, '|', checksum) FROM schema_migrations ORDER BY filename;"
}

# Compute SHA-256 hash of a file
file_hash() {
    sha256sum "$1" | cut -d' ' -f1
}

# ---------- Commands ----------
cmd_status() {
    wait_for_db
    ensure_journal

    header "Migration status:"
    local applied
    applied=$(get_applied)

    local total=0 pending=0 skipped=0

    for f in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
        local filename hash existing existing_hash
        filename=$(basename "$f")
        hash=$(file_hash "$f")
        total=$((total + 1))

        existing=$(echo "$applied" | grep "^$filename|" || true)
        if [ -n "$existing" ]; then
            existing_hash=$(echo "$existing" | cut -d'|' -f2)
            if [ "$existing_hash" != "$hash" ]; then
                log "TAMPERED $filename (hash mismatch)"
            else
                log "APPLIED $filename"
            fi
            skipped=$((skipped + 1))
        else
            log "PENDING $filename"
            pending=$((pending + 1))
        fi
    done

    echo ""
    echo "   Total: $total | Applied: $skipped | Pending: $pending"
}

cmd_migrate() {
    local dry_run=false
    [ "${1:-}" = "--dry-run" ] && dry_run=true

    wait_for_db
    ensure_journal

    local applied
    applied=$(get_applied)

    local applied_count=0 skipped_count=0

    header "Processing migrations from $MIGRATIONS_DIR..."

    for f in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
        local filename hash existing existing_hash
        filename=$(basename "$f")
        hash=$(file_hash "$f")

        # Check if already applied
        existing=$(echo "$applied" | grep "^$filename|" || true)
        if [ -n "$existing" ]; then
            existing_hash=$(echo "$existing" | cut -d'|' -f2)
            if [ "$existing_hash" != "$hash" ]; then
                die "Migration $filename was modified after being applied!
     Stored hash:  $existing_hash
     Current hash: $hash"
            fi
            log "SKIP    $filename (already applied)"
            skipped_count=$((skipped_count + 1))
            continue
        fi

        if $dry_run; then
            log "DRY-RUN $filename (would apply)"
            applied_count=$((applied_count + 1))
            continue
        fi

        log "APPLY   $filename"
        # The mysql client stops at the first error (no --force), so the
        # journal entry below is only written when the whole file succeeded.
        $MYSQL_BASE < "$f"
        $MYSQL_BASE -e "INSERT INTO schema_migrations (filename, checksum) VALUES ('$filename', '$hash');"
        applied_count=$((applied_count + 1))
    done

    echo ""
    header "Migration summary:"
    log "Applied: $applied_count"
    log "Skipped: $skipped_count (already in journal)"

    if $dry_run; then
        log "(dry-run mode — no changes were made)"
    fi
    header "Done."
}

# ---------- Main ----------
case "${1:-}" in
    --status)  cmd_status ;;
    --dry-run) cmd_migrate --dry-run ;;
    *)         cmd_migrate "$@" ;;
esac
