#!/usr/bin/env node
/**
 * Deep Analysis for Meta-Model v0.5
 *
 * Validates ADR-011 and ADR-012 compliance:
 * - ADR-011: Single truth source architecture
 * - ADR-012: Three-axis temporal semantics
 *
 * Usage: node scripts/deep-analysis-v0.5.js
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function loadYaml(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return yaml.load(content);
}

function analyzeDataBinding() {
  console.log(`\n${colors.bold}${colors.cyan}=== v0.5 Data Binding Analysis ===${colors.reset}\n`);

  const dataBindingPath = path.join(__dirname, '../ontology/meta/data-binding-meta-model.yaml');

  if (!fs.existsSync(dataBindingPath)) {
    console.log(`${colors.yellow}⚠️  v0.5 module not found, checking v0.4...${colors.reset}`);
    return analyzeV04Compliance();
  }

  const dataBinding = loadYaml(dataBindingPath);
  const version = dataBinding.module.version;

  console.log(`Module Version: ${colors.cyan}${version}${colors.reset}\n`);

  if (version !== '0.5.0') {
    console.log(`${colors.yellow}⚠️  Expected v0.5.0, found ${version}${colors.reset}\n`);
    return analyzeV04Compliance();
  }

  // ADR-011 Compliance Checks
  console.log(`${colors.bold}ADR-011: Single Truth Source Architecture${colors.reset}`);
  checkADR011Compliance(dataBinding);

  // ADR-012 Compliance Checks
  console.log(`\n${colors.bold}ADR-012: Three-Axis Temporal Semantics${colors.reset}`);
  checkADR012Compliance(dataBinding);

  // Generate report
  console.log(`\n${colors.bold}${colors.cyan}=== Summary ===${colors.reset}\n`);
  generateSummary();
}

let issues = {
  p0: [],
  p1: [],
  p2: []
};

function checkADR011Compliance(dataBinding) {
  const checks = [
    checkNoFieldSemanticMapping,
    checkNoSemanticFieldMappingType,
    checkSemanticMappingHasSourceBinding,
    checkSlotMappingsNotFieldMappings,
    checkValueBindingUsed,
    checkMaterializationRunExists,
    checkNoWatermarkInPlan,
    checkTransformationsVersioned
  ];

  checks.forEach(check => check(dataBinding));
}

function checkNoFieldSemanticMapping(dataBinding) {
  // Check if Field type has semanticMapping field
  const db = dataBinding.DataBinding;

  if (db.Field && db.Field.optionalFields && db.Field.optionalFields.semanticMapping) {
    issues.p0.push({
      category: 'ADR-011-violation',
      message: 'Field.semanticMapping exists (violates single truth source)',
      location: 'DataBinding.Field.optionalFields.semanticMapping',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ Field.semanticMapping found (ADR-011 violation)${colors.reset}`);
  } else {
    console.log(`  ${colors.green}✓ No Field.semanticMapping found${colors.reset}`);
  }
}

function checkNoSemanticFieldMappingType(dataBinding) {
  const db = dataBinding.DataBinding;

  if (db.SemanticFieldMapping) {
    issues.p0.push({
      category: 'ADR-011-violation',
      message: 'SemanticFieldMapping type exists (violates single truth source)',
      location: 'DataBinding.SemanticFieldMapping',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ SemanticFieldMapping type found (ADR-011 violation)${colors.reset}`);
  } else {
    console.log(`  ${colors.green}✓ No SemanticFieldMapping type found${colors.reset}`);
  }
}

function checkSemanticMappingHasSourceBinding(dataBinding) {
  const db = dataBinding.DataBinding;

  if (!db.SemanticMappingDefinition) {
    issues.p0.push({
      category: 'missing-type',
      message: 'SemanticMappingDefinition type not found',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ SemanticMappingDefinition type not found${colors.reset}`);
    return;
  }

  const mapping = db.SemanticMappingDefinition.requiredFields || {};

  if (mapping.source && mapping.source.type === 'SourceBinding') {
    console.log(`  ${colors.green}✓ SemanticMappingDefinition uses SourceBinding${colors.reset}`);
  } else if (mapping.sourceDataset) {
    issues.p0.push({
      category: 'ADR-011-incomplete',
      message: 'SemanticMappingDefinition uses sourceDataset (should be source: SourceBinding)',
      location: 'DataBinding.SemanticMappingDefinition.requiredFields.sourceDataset',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ SemanticMappingDefinition uses sourceDataset (should be SourceBinding)${colors.reset}`);
  } else {
    issues.p1.push({
      category: 'ADR-011-incomplete',
      message: 'Cannot determine source binding structure',
      severity: 'P1 HIGH'
    });
    console.log(`  ${colors.yellow}⚠️  Cannot determine source binding structure${colors.reset}`);
  }
}

function checkSlotMappingsNotFieldMappings(dataBinding) {
  const db = dataBinding.DataBinding;
  const mapping = db.SemanticMappingDefinition?.optionalFields || {};

  if (mapping.slotMappings) {
    console.log(`  ${colors.green}✓ Uses slotMappings (correct naming)${colors.reset}`);
  } else if (mapping.fieldMappings) {
    issues.p1.push({
      category: 'ADR-011-naming',
      message: 'Uses fieldMappings (should be renamed to slotMappings)',
      location: 'DataBinding.SemanticMappingDefinition.optionalFields.fieldMappings',
      severity: 'P1 HIGH'
    });
    console.log(`  ${colors.yellow}⚠️  Uses fieldMappings (should be slotMappings)${colors.reset}`);
  } else {
    console.log(`  ${colors.yellow}⚠️  No slot/field mappings found${colors.reset}`);
  }
}

function checkValueBindingUsed(dataBinding) {
  const db = dataBinding.DataBinding;

  if (db.ValueBinding) {
    console.log(`  ${colors.green}✓ ValueBinding type defined${colors.reset}`);

    // Check if it's a union type
    if (db.ValueBinding.discriminator === 'bindingType') {
      console.log(`  ${colors.green}✓ ValueBinding is discriminated union${colors.reset}`);
    } else {
      issues.p1.push({
        category: 'ADR-011-incomplete',
        message: 'ValueBinding should be discriminated union with bindingType',
        severity: 'P1 HIGH'
      });
      console.log(`  ${colors.yellow}⚠️  ValueBinding should be discriminated union${colors.reset}`);
    }
  } else {
    issues.p0.push({
      category: 'ADR-011-incomplete',
      message: 'ValueBinding type not defined',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ ValueBinding type not defined${colors.reset}`);
  }
}

function checkMaterializationRunExists(dataBinding) {
  const db = dataBinding.DataBinding;

  if (db.MaterializationRun) {
    console.log(`  ${colors.green}✓ MaterializationRun type defined${colors.reset}`);

    const run = db.MaterializationRun.requiredFields || {};

    // Check for immutable time context (ADR-012)
    const hasAssertionTime = !!run.assertionTime;
    const hasReferenceTime = !!run.referenceTime;
    const hasInputSnapshot = !!run.inputSnapshotDigest;

    if (hasAssertionTime && hasReferenceTime && hasInputSnapshot) {
      console.log(`  ${colors.green}✓ MaterializationRun has immutable runtime context${colors.reset}`);
    } else {
      issues.p0.push({
        category: 'ADR-012-incomplete',
        message: 'MaterializationRun missing required time context fields',
        details: `assertionTime: ${hasAssertionTime}, referenceTime: ${hasReferenceTime}, inputSnapshotDigest: ${hasInputSnapshot}`,
        severity: 'P0 BLOCKING'
      });
      console.log(`  ${colors.red}✗ MaterializationRun missing time context fields${colors.reset}`);
    }
  } else {
    issues.p0.push({
      category: 'ADR-011-incomplete',
      message: 'MaterializationRun type not defined',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ MaterializationRun type not defined${colors.reset}`);
  }
}

function checkNoWatermarkInPlan(dataBinding) {
  const db = dataBinding.DataBinding;
  const plan = db.MaterializationPlanDefinition?.optionalFields || {};

  if (plan.watermark) {
    issues.p0.push({
      category: 'ADR-011-violation',
      message: 'MaterializationPlanDefinition has watermark (should be in MaterializationRun)',
      location: 'DataBinding.MaterializationPlanDefinition.optionalFields.watermark',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ watermark found in plan (should be in run)${colors.reset}`);
  } else {
    console.log(`  ${colors.green}✓ No watermark in plan (correct)${colors.reset}`);
  }
}

function checkTransformationsVersioned(dataBinding) {
  const db = dataBinding.DataBinding;
  const trans = db.TransformationDefinition;

  if (!trans) {
    console.log(`  ${colors.yellow}⚠️  TransformationDefinition not found${colors.reset}`);
    return;
  }

  const required = trans.requiredFields || {};
  const optional = trans.optionalFields || {};

  const hasVersion = !!required.version || !!optional.version;
  const hasDigest = !!required.implementationDigest || !!optional.implementationDigest;
  const hasInputs = !!required.inputs || !!optional.inputs;
  const hasOutputs = !!required.outputs || !!optional.outputs;
  const hasTests = !!required.testCases || !!optional.testCases;

  const allRequired = hasVersion && hasDigest && hasInputs && hasOutputs && hasTests;

  if (allRequired) {
    console.log(`  ${colors.green}✓ TransformationDefinition has all required fields${colors.reset}`);
  } else {
    issues.p1.push({
      category: 'ADR-011-incomplete',
      message: 'TransformationDefinition missing required fields',
      details: `version: ${hasVersion}, digest: ${hasDigest}, inputs: ${hasInputs}, outputs: ${hasOutputs}, tests: ${hasTests}`,
      severity: 'P1 HIGH'
    });
    console.log(`  ${colors.yellow}⚠️  TransformationDefinition incomplete${colors.reset}`);
    console.log(`     version: ${hasVersion}, digest: ${hasDigest}, inputs: ${hasInputs}, outputs: ${hasOutputs}, tests: ${hasTests}`);
  }
}

function checkADR012Compliance(dataBinding) {
  const checks = [
    checkTemporalMappingSpecStructure,
    checkThreeAxisBinding,
    checkNoCurrentTimestamp,
    checkTimeAxisBinding
  ];

  checks.forEach(check => check(dataBinding));
}

function checkTemporalMappingSpecStructure(dataBinding) {
  const db = dataBinding.DataBinding;

  if (!db.TemporalMappingSpec) {
    issues.p0.push({
      category: 'ADR-012-incomplete',
      message: 'TemporalMappingSpec type not defined',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ TemporalMappingSpec type not defined${colors.reset}`);
    return;
  }

  console.log(`  ${colors.green}✓ TemporalMappingSpec type defined${colors.reset}`);

  const spec = db.TemporalMappingSpec;
  const required = spec.requiredFields || {};
  const optional = spec.optionalFields || {};

  if (required.patternRef || optional.patternRef) {
    console.log(`  ${colors.green}✓ TemporalMappingSpec has patternRef${colors.reset}`);
  } else {
    issues.p1.push({
      category: 'ADR-012-incomplete',
      message: 'TemporalMappingSpec missing patternRef',
      severity: 'P1 HIGH'
    });
    console.log(`  ${colors.yellow}⚠️  TemporalMappingSpec missing patternRef${colors.reset}`);
  }
}

function checkThreeAxisBinding(dataBinding) {
  const db = dataBinding.DataBinding;
  const spec = db.TemporalMappingSpec?.optionalFields || {};

  const hasValidTime = !!spec.validTime;
  const hasKnowledgeTime = !!spec.knowledgeTime;
  const hasAvailabilityTime = !!spec.availabilityTime;

  if (hasValidTime && hasKnowledgeTime && hasAvailabilityTime) {
    console.log(`  ${colors.green}✓ TemporalMappingSpec supports all three time axes${colors.reset}`);
  } else {
    issues.p0.push({
      category: 'ADR-012-incomplete',
      message: 'TemporalMappingSpec missing time axis bindings',
      details: `validTime: ${hasValidTime}, knowledgeTime: ${hasKnowledgeTime}, availabilityTime: ${hasAvailabilityTime}`,
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ Missing time axis bindings${colors.reset}`);
    console.log(`     validTime: ${hasValidTime}, knowledgeTime: ${hasKnowledgeTime}, availabilityTime: ${hasAvailabilityTime}`);
  }

  // Check for deprecated fields
  if (spec.recordedAtField || spec.recordedAtSource) {
    issues.p1.push({
      category: 'ADR-012-violation',
      message: 'TemporalMappingSpec has deprecated recordedAt fields',
      severity: 'P1 HIGH'
    });
    console.log(`  ${colors.yellow}⚠️  Deprecated recordedAt fields found${colors.reset}`);
  }
}

function checkNoCurrentTimestamp(dataBinding) {
  const yamlContent = fs.readFileSync(
    path.join(__dirname, '../ontology/meta/data-binding-meta-model.yaml'),
    'utf8'
  );

  const currentTimestampRegex = /CURRENT_TIMESTAMP|currentTimestamp|NOW\(\)|GETDATE\(\)|SYSDATE/gi;
  const matches = yamlContent.match(currentTimestampRegex);

  if (matches && matches.length > 0) {
    issues.p0.push({
      category: 'ADR-012-violation',
      message: `Found ${matches.length} non-reproducible time function(s): ${matches.join(', ')}`,
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ Non-reproducible time functions found: ${matches.join(', ')}${colors.reset}`);
  } else {
    console.log(`  ${colors.green}✓ No CURRENT_TIMESTAMP or non-reproducible time functions${colors.reset}`);
  }
}

function checkTimeAxisBinding(dataBinding) {
  const db = dataBinding.DataBinding;

  if (db.TimeAxisBinding) {
    console.log(`  ${colors.green}✓ TimeAxisBinding type defined${colors.reset}`);

    const binding = db.TimeAxisBinding.requiredFields || {};
    if (binding.from) {
      console.log(`  ${colors.green}✓ TimeAxisBinding has required 'from' field${colors.reset}`);
    } else {
      issues.p1.push({
        category: 'ADR-012-incomplete',
        message: 'TimeAxisBinding missing required from field',
        severity: 'P1 HIGH'
      });
      console.log(`  ${colors.yellow}⚠️  TimeAxisBinding missing 'from' field${colors.reset}`);
    }
  } else {
    issues.p0.push({
      category: 'ADR-012-incomplete',
      message: 'TimeAxisBinding type not defined',
      severity: 'P0 BLOCKING'
    });
    console.log(`  ${colors.red}✗ TimeAxisBinding type not defined${colors.reset}`);
  }
}

function analyzeV04Compliance() {
  console.log(`${colors.bold}${colors.yellow}Running v0.4 Compliance Check${colors.reset}\n`);
  console.log(`This is the ${colors.bold}legacy${colors.reset} data binding module.`);
  console.log(`To achieve ADR-011/012 compliance, migrate to v0.5.0.\n`);

  // Known v0.4 issues
  issues.p0.push(
    {
      category: 'version',
      message: 'Data binding module is v0.4 (needs upgrade to v0.5 for ADR-011/012 compliance)',
      severity: 'P0 BLOCKING'
    },
    {
      category: 'ADR-011-violation',
      message: 'Field.semanticMapping exists (violates single truth source)',
      severity: 'P0 BLOCKING'
    },
    {
      category: 'ADR-011-violation',
      message: 'SemanticFieldMapping type exists (violates single truth source)',
      severity: 'P0 BLOCKING'
    },
    {
      category: 'ADR-011-incomplete',
      message: 'SemanticMappingDefinition uses sourceDataset (not SourceBinding)',
      severity: 'P0 BLOCKING'
    },
    {
      category: 'ADR-011-incomplete',
      message: 'MaterializationRun type does not exist',
      severity: 'P0 BLOCKING'
    },
    {
      category: 'ADR-012-incomplete',
      message: 'TemporalMappingSpec does not support three-axis model',
      severity: 'P0 BLOCKING'
    }
  );

  issues.p1.push(
    {
      category: 'ADR-012-violation',
      message: 'TemporalMappingSpec uses recordedAtSource: currentTimestamp',
      severity: 'P1 HIGH'
    },
    {
      category: 'ADR-011-violation',
      message: 'MaterializationPlanDefinition.watermark (should be in run)',
      severity: 'P1 HIGH'
    }
  );
}

function generateSummary() {
  const totalIssues = issues.p0.length + issues.p1.length + issues.p2.length;

  if (issues.p0.length > 0) {
    console.log(`${colors.bold}${colors.red}P0 阻断问题: ${issues.p0.length}${colors.reset}`);
    issues.p0.forEach(issue => {
      console.log(`  ${colors.red}✗${colors.reset} ${issue.category}: ${issue.message}`);
      if (issue.details) console.log(`    详情: ${issue.details}`);
      if (issue.location) console.log(`    位置: ${issue.location}`);
    });
    console.log();
  }

  if (issues.p1.length > 0) {
    console.log(`${colors.bold}${colors.yellow}P1 高优先级问题: ${issues.p1.length}${colors.reset}`);
    issues.p1.forEach(issue => {
      console.log(`  ${colors.yellow}⚠️${colors.reset} ${issue.category}: ${issue.message}`);
      if (issue.details) console.log(`    详情: ${issue.details}`);
      if (issue.location) console.log(`    位置: ${issue.location}`);
    });
    console.log();
  }

  if (issues.p2.length > 0) {
    console.log(`${colors.bold}P2 建议改进: ${issues.p2.length}${colors.reset}`);
    issues.p2.forEach(issue => {
      console.log(`  ${colors.cyan}ℹ${colors.reset} ${issue.category}: ${issue.message}`);
    });
    console.log();
  }

  if (totalIssues === 0) {
    console.log(`${colors.bold}${colors.green}✅ 所有 ADR-011 和 ADR-012 检查通过${colors.reset}\n`);
    console.log(`Data Binding v0.5 架构合规。`);
    return 0;
  } else {
    console.log(`${colors.bold}总计: ${totalIssues} 个问题${colors.reset}`);

    if (issues.p0.length > 0) {
      console.log(`\n${colors.red}${colors.bold}❌ 存在 P0 阻断问题，必须修复后才能进入生产${colors.reset}`);
      return 1;
    } else if (issues.p1.length > 0) {
      console.log(`\n${colors.yellow}${colors.bold}⚠️  存在 P1 高优先级问题，建议修复${colors.reset}`);
      return 0;
    } else {
      console.log(`\n${colors.green}所有关键检查通过${colors.reset}`);
      return 0;
    }
  }
}

// Run analysis
const exitCode = analyzeDataBinding();
process.exit(exitCode);
