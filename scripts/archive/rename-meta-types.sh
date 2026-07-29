#!/bin/bash
# ADR-004: Global rename of meta-types to *Definition suffix
# This script performs mechanical renaming across all meta-model YAML files

set -e

cd "$(dirname "$0")/../ontology/meta"

echo "Starting global rename of meta-types..."

# Define rename mappings (old_name -> new_name)
declare -A renames=(
    ["OntologyModule"]="OntologyModuleDefinition"
    ["ObjectType"]="ObjectTypeDefinition"
    ["AttributeType"]="AttributeTypeDefinition"
    ["RelationType"]="RelationTypeDefinition"
    ["AssociationType"]="AssociationTypeDefinition"
    ["QueryType"]="QueryTypeDefinition"
    ["FunctionType"]="FunctionTypeDefinition"
    ["ActionType"]="ActionTypeDefinition"
    ["Dataset"]="DatasetDefinition"
    ["SemanticMapping"]="SemanticMappingDefinition"
    ["IngestionPipeline"]="IngestionPipelineDefinition"
    ["MaterializationPlan"]="MaterializationPlanDefinition"
)

# Backup original files
echo "Creating backups..."
for file in *.yaml; do
    cp "$file" "${file}.bak"
done

# Perform replacements
for old in "${!renames[@]}"; do
    new="${renames[$old]}"
    echo "Renaming: $old -> $new"

    # Replace in all YAML files
    # Use word boundaries to avoid partial matches
    for file in *.yaml; do
        if [ "$file" != "*.yaml.bak" ]; then
            # sed on Windows (Git Bash) requires different syntax
            sed -i "s/\b${old}\b/${new}/g" "$file"
        fi
    done
done

echo "Rename complete. Backups saved as *.yaml.bak"
echo ""
echo "Files modified:"
ls -lh *.yaml

echo ""
echo "To restore backups: for f in *.yaml.bak; do mv \$f \${f%.bak}; done"
