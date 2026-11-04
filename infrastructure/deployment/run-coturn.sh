#!/bin/sh
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set}"
: "${TURN_REALM:?TURN_REALM must be set}"

case "$TURN_SECRET" in
  *[!A-Za-z0-9_-]*|'') echo "TURN_SECRET must be a high-entropy URL-safe secret" >&2; exit 1 ;;
esac
if [ "${#TURN_SECRET}" -lt 32 ]; then
  echo "TURN_SECRET must contain at least 32 characters" >&2
  exit 1
fi

{
  printf 'static-auth-secret=%s\n' "$TURN_SECRET"
  printf 'realm=%s\n' "$TURN_REALM"
  cat /etc/coturn/base.conf
} > /tmp/turnserver.conf

chmod 600 /tmp/turnserver.conf
unset TURN_SECRET
exec turnserver -c /tmp/turnserver.conf
