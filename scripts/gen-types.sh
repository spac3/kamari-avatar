#!/usr/bin/env bash
# Regenerate Python and TypeScript protocol types from schema/protocol.schema.json.
# Usage: scripts/gen-types.sh [--check]   (--check fails if generated files are stale)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
schema="$root/schema/protocol.schema.json"
py_out="$root/server/src/kamari_avatar/protocol.py"
ts_out="$root/web/src/protocol.ts"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

"${DATAMODEL_CODEGEN:-datamodel-codegen}" --input "$schema" --input-file-type jsonschema \
  --output "$tmp/protocol.py" --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.11 --use-annotated --use-standard-collections --use-union-operator \
  --enum-field-as-literal all --disable-timestamp --use-title-as-name --formatters black isort 2>/dev/null
(cd "$root/web" && npx --no-install json2ts --input "$schema" --output "$tmp/protocol.ts" \
  --bannerComment "/* Generated from schema/protocol.schema.json by scripts/gen-types.sh. Do not edit. */" --unreachableDefinitions)

if [[ "${1:-}" == "--check" ]]; then
  diff -u "$py_out" "$tmp/protocol.py" && diff -u "$ts_out" "$tmp/protocol.ts" && echo "protocol types up to date"
else
  cp "$tmp/protocol.py" "$py_out"; cp "$tmp/protocol.ts" "$ts_out"; echo "wrote $py_out and $ts_out"
fi
