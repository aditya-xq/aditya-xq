#!/usr/bin/env bash
set -euo pipefail

# File that lists remote URLs + target filenames
MAPPING_FILE="assets-to-fetch.json"

# If mapping file doesn't exist, create a sample and exit (so you can modify it)
if [ ! -f "$MAPPING_FILE" ]; then
  cat > "$MAPPING_FILE" <<'JSON'
[
  {
    "url": "https://github-readme-stats.vercel.app/api?username=aditya-xq&show_icons=true&theme=highcontrast&hide_border=true&rank_icon=github",
    "out": "assets/github-stats.png"
  },
  {
    "url": "https://github-readme-streak-stats.herokuapp.com/?user=aditya-xq&theme=highcontrast&hide_border=true",
    "out": "assets/streaks.png"
  },
  {
    "url": "https://visitor-badge.laobi.icu/badge?page_id=aditya-xq&left_color=maroon&right_color=darkgreen",
    "out": "assets/visitor-badge.png"
  }
]
JSON

  echo "Created sample $MAPPING_FILE. Edit it with the URLs you want and re-run the workflow (or trigger manually)."
  exit 0
fi

# Download each item in mapping file.
# Mapping file format: [ { "url": "...", "out": "assets/foo.png" }, ... ]
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

n=$(jq 'length' "$MAPPING_FILE")
if [ "$n" -eq 0 ]; then
  echo "No entries in $MAPPING_FILE"
  exit 0
fi

echo "Fetching $n assets..."
for i in $(seq 0 $((n-1))); do
  url=$(jq -r ".[$i].url" "$MAPPING_FILE")
  out=$(jq -r ".[$i].out" "$MAPPING_FILE")
  if [ "$url" = "null" ] || [ "$out" = "null" ]; then
    echo "Skipping invalid mapping at index $i"
    continue
  fi

  # ensure directory exists
  mkdir -p "$(dirname "$out")"

  # download to a tmp file first, follow redirects
  tmpfile="$tmpdir/$(basename "$out").tmp"
  echo "Downloading: $url -> $out"
  if curl -fSL --max-time 30 -o "$tmpfile" "$url"; then
    # check if file changed before overwriting (avoid touching git unnecessarily)
    if [ -f "$out" ]; then
      if cmp -s "$tmpfile" "$out"; then
        echo "No change for $out"
      else
        mv "$tmpfile" "$out"
        echo "Updated $out"
      fi
    else
      mv "$tmpfile" "$out"
      echo "Saved new $out"
    fi
  else
    echo "WARNING: failed to download $url (skipping)"
    rm -f "$tmpfile"
  fi
done

echo "Done fetching assets."
