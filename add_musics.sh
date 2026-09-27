#!/usr/bin/env bash
# Usage: add_musics.sh "Song name 1" "Song name 2" ...
#
# Downloads each song from YouTube (search by name, or a link) as MP3 into a
# temporary folder, then moves only the files that are not already in the library.
#
# Overridable from the environment (music-api sets DEST_DIR, runs as the file owner):
#   DEST_DIR  final library folder     (default /mnt/storage/music)
#   TEMP_DIR  scratch download folder  (default: a fresh mktemp -d)

DEST_DIR="${DEST_DIR:-/mnt/storage/music}"
TEMP_DIR="${TEMP_DIR:-$(mktemp -d)}"

# Only use sudo when we can't write to the library as ourselves (manual runs on the host)
SUDO=""
[ -w "$DEST_DIR" ] || SUDO="sudo"

# Make sure the folders exist
$SUDO mkdir -p "$DEST_DIR"
mkdir -p "$TEMP_DIR"

# Check that arguments were passed
if [ $# -eq 0 ]; then
    echo "Usage: $0 \"Song name 1\" \"Song name 2\" ..."
    exit 1
fi

TOTAL=$#
CURRENT=1
MOVED=0
SKIPPED=0
FAILED=0

echo "Downloading $TOTAL song(s) to the temporary folder..."

for SONG in "$@"; do
    echo ""
    echo "--------------------------------------------------"
    echo "[$CURRENT/$TOTAL] Searching and downloading: $SONG"
    echo "--------------------------------------------------"

    # Download to the temporary folder first.
    # "--" so a name starting with "-" can never be read as a yt-dlp option;
    # --no-playlist so a link to a playlist doesn't pull hundreds of songs;
    # --newline so progress shows up line by line when the output is piped.
    if ! yt-dlp -x \
      --audio-format mp3 \
      --audio-quality 0 \
      --add-metadata \
      --embed-thumbnail \
      --no-playlist \
      --newline \
      --default-search "ytsearch" \
      -o "$TEMP_DIR/%(title)s.%(ext)s" \
      -- "$SONG"; then
        echo "ERROR: could not download: $SONG"
        FAILED=$((FAILED + 1))
    fi

    CURRENT=$((CURRENT + 1))
done

echo ""
echo "Moving only new files to the final destination ($DEST_DIR)..."

# Move only files that do NOT already exist in the destination (avoids duplicates)
for FILE in "$TEMP_DIR"/*; do
    if [ -f "$FILE" ]; then
        FILENAME=$(basename "$FILE")
        if [ ! -f "$DEST_DIR/$FILENAME" ]; then
            $SUDO mv "$FILE" "$DEST_DIR/"
            echo "Moved successfully: $FILENAME"
            MOVED=$((MOVED + 1))
        else
            echo "Duplicate detected (already in storage): $FILENAME - Skipped."
            SKIPPED=$((SKIPPED + 1))
        fi
    fi
done

# Delete the temporary folder and whatever is left in it
rm -rf "$TEMP_DIR"

echo ""
echo "Done! $MOVED added, $SKIPPED skipped, $FAILED failed. Temporary folder cleaned. Songs stored in: $DEST_DIR"

[ "$FAILED" -eq 0 ]
