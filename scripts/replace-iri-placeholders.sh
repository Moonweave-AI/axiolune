#!/bin/bash
# Replace IRI Placeholders Script
# Usage: ./scripts/replace-iri-placeholders.sh <BASE_IRI>
# Example: ./scripts/replace-iri-placeholders.sh "https://ontology.moonweave.ai/axiolune"

set -e

if [ -z "$1" ]; then
  echo "Error: BASE_IRI not provided"
  echo "Usage: $0 <BASE_IRI>"
  echo "Example: $0 'https://ontology.moonweave.ai/axiolune'"
  exit 1
fi

BASE_IRI="$1"

# Validate BASE_IRI format (must be https:// or urn:)
if [[ ! "$BASE_IRI" =~ ^(https://|urn:) ]]; then
  echo "Error: BASE_IRI must start with 'https://' or 'urn:'"
  exit 1
fi

echo "=========================================="
echo "IRI Placeholder Replacement"
echo "=========================================="
echo "BASE_IRI: $BASE_IRI"
echo ""

# Confirm with user
read -p "This will replace all {BASE_IRI} placeholders in the repository. Continue? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Find all files containing {BASE_IRI}
echo "Searching for files with {BASE_IRI} placeholders..."
FILES=$(find . -type f \( -name "*.yaml" -o -name "*.yml" -o -name "*.md" -o -name "*.py" -o -name "*.ts" -o -name "*.js" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -exec grep -l "{BASE_IRI}" {} \;)

if [ -z "$FILES" ]; then
  echo "No files found with {BASE_IRI} placeholders."
  exit 0
fi

echo "Found files:"
echo "$FILES"
echo ""

# Backup directory
BACKUP_DIR=".iri-replacement-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
echo "Creating backup in: $BACKUP_DIR"

# Replace in each file
COUNT=0
for FILE in $FILES; do
  # Create backup
  BACKUP_FILE="$BACKUP_DIR/$FILE"
  mkdir -p "$(dirname "$BACKUP_FILE")"
  cp "$FILE" "$BACKUP_FILE"

  # Replace {BASE_IRI} with actual BASE_IRI
  sed -i "s|{BASE_IRI}|$BASE_IRI|g" "$FILE"

  COUNT=$((COUNT + 1))
  echo "  ✓ $FILE"
done

echo ""
echo "=========================================="
echo "Replacement complete!"
echo "=========================================="
echo "Files modified: $COUNT"
echo "Backup location: $BACKUP_DIR"
echo ""
echo "Next steps:"
echo "1. Review changes: git diff"
echo "2. Run validation: node scripts/validate-yaml.js ontology/meta/*.yaml"
echo "3. Commit if correct: git add -A && git commit -m 'chore: replace IRI placeholders with $BASE_IRI'"
echo "4. Or restore backup: cp -r $BACKUP_DIR/* ."
