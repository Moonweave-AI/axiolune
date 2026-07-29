#!/usr/bin/env node

const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const META_DIR = path.join(__dirname, '..', 'ontology', 'meta');

console.log('='.repeat(70));
console.log('深度架构问题分析');
console.log('='.repeat(70));

// Load all YAML files
const core = yaml.load(fs.readFileSync(path.join(META_DIR, 'core-meta-model.yaml'), 'utf8'));
const patterns = yaml.load(fs.readFileSync(path.join(META_DIR, 'cross-domain-patterns.yaml'), 'utf8'));
const behavior = yaml.load(fs.readFileSync(path.join(META_DIR, 'behavior-meta-model.yaml'), 'utf8'));
const dataBinding = yaml.load(fs.readFileSync(path.join(META_DIR, 'data-binding-meta-model.yaml'), 'utf8'));

const issues = [];

// ==================== 问题 1: 模式属性闭包 ====================
console.log('\n1. 模式注入属性闭包检查');
console.log('-'.repeat(70));

const definedPatternAttrs = new Set();
if (core.MetaModel) {
  for (const name in core.MetaModel) {
    const attr = core.MetaModel[name];
    if (attr && attr.namespace === 'pattern') {
      definedPatternAttrs.add(name);
    }
  }
}

console.log(`已定义的模式属性 (${definedPatternAttrs.size}):`);
console.log(`  ${Array.from(definedPatternAttrs).join(', ')}`);

// Extract all injected attributes from patterns
const referencedPatternAttrs = new Set();
if (patterns.CrossDomainPatterns) {
  for (const key in patterns.CrossDomainPatterns) {
    const item = patterns.CrossDomainPatterns[key];
    if (Array.isArray(item)) {
      // It's a pattern list
      item.forEach(pattern => {
        if (pattern.injectedAttributes) {
          pattern.injectedAttributes.forEach(attr => {
            const attrName = attr.attribute.split('/').pop();
            referencedPatternAttrs.add(attrName);
          });
        }
      });
    }
  }
}

console.log(`\n引用的模式属性 (${referencedPatternAttrs.size}):`);
if (referencedPatternAttrs.size > 0) {
  console.log(`  ${Array.from(referencedPatternAttrs).join(', ')}`);
} else {
  console.log('  (未找到注入属性引用)');
}

const missingPatternAttrs = Array.from(referencedPatternAttrs).filter(a => !definedPatternAttrs.has(a));
if (missingPatternAttrs.length > 0) {
  console.log(`\n✗ 缺失的属性定义 (${missingPatternAttrs.length}):`);
  console.log(`  ${missingPatternAttrs.join(', ')}`);
  issues.push({
    category: 'Pattern Closure',
    severity: 'P0-BLOCKING',
    description: `${missingPatternAttrs.length} 个模式属性被引用但未定义`,
    missing: missingPatternAttrs
  });
} else {
  console.log('\n✓ 所有引用的模式属性均已定义');
}

// ==================== 问题 2: 约束定义闭包 ====================
console.log('\n\n2. 约束定义闭包检查');
console.log('-'.repeat(70));

const definedConstraints = new Set();
const referencedConstraints = new Set();

if (patterns.CrossDomainPatterns) {
  // Check for constraints dictionary
  if (patterns.CrossDomainPatterns.constraints) {
    for (const constraintName in patterns.CrossDomainPatterns.constraints) {
      definedConstraints.add(constraintName);
    }
  }

  for (const key in patterns.CrossDomainPatterns) {
    const item = patterns.CrossDomainPatterns[key];

    // Check if it's a constraint definition (old style - top-level with IRI)
    if (item && item.iri && item.iri.includes('/constraints/')) {
      definedConstraints.add(key);
    }

    // Check arrays for patterns with constraints
    if (Array.isArray(item)) {
      item.forEach(pattern => {
        if (pattern.constraintsAdded) {
          pattern.constraintsAdded.forEach(c => {
            const name = c.constraintRef.split('/').pop();
            referencedConstraints.add(name);
          });
        }
      });
    }
  }
}

console.log(`已定义的约束 (${definedConstraints.size}):`);
if (definedConstraints.size > 0) {
  console.log(`  ${Array.from(definedConstraints).join(', ')}`);
} else {
  console.log('  (未找到约束定义)');
}

console.log(`\n引用的约束 (${referencedConstraints.size}):`);
if (referencedConstraints.size > 0) {
  console.log(`  ${Array.from(referencedConstraints).join(', ')}`);
} else {
  console.log('  (未找到约束引用)');
}

const missingConstraints = Array.from(referencedConstraints).filter(c => !definedConstraints.has(c));
if (missingConstraints.length > 0) {
  console.log(`\n✗ 缺失的约束定义 (${missingConstraints.length}):`);
  console.log(`  ${missingConstraints.join(', ')}`);
  issues.push({
    category: 'Constraint Closure',
    severity: 'P0-BLOCKING',
    description: `${missingConstraints.length} 个约束被引用但未定义`,
    missing: missingConstraints
  });
} else {
  console.log('\n✓ 所有引用的约束均已定义');
}

// ==================== 问题 3: 数据绑定双真源分析 ====================
console.log('\n\n3. 数据绑定真值源分析');
console.log('-'.repeat(70));

let dualTruthSources = false;

// Check for multiple mapping structures
if (dataBinding.DataBinding) {
  const hasFieldSemanticMapping = JSON.stringify(dataBinding.DataBinding).includes('"semanticMapping"');
  const hasSemanticMappingDef = dataBinding.DataBinding.SemanticMappingDefinition !== undefined;
  const hasMaterializationMappings = dataBinding.DataBinding.MaterializationPlanDefinition &&
    JSON.stringify(dataBinding.DataBinding.MaterializationPlanDefinition).includes('semanticMappings');

  console.log('映射结构检查:');
  console.log(`  Field.semanticMapping: ${hasFieldSemanticMapping ? '存在' : '不存在'}`);
  console.log(`  SemanticMappingDefinition: ${hasSemanticMappingDef ? '存在' : '不存在'}`);
  console.log(`  MaterializationPlan.semanticMappings: ${hasMaterializationMappings ? '存在' : '不存在'}`);

  if ((hasFieldSemanticMapping ? 1 : 0) + (hasSemanticMappingDef ? 1 : 0) + (hasMaterializationMappings ? 1 : 0) > 1) {
    console.log('\n✗ 检测到多个语义映射真值源');
    dualTruthSources = true;
    issues.push({
      category: 'Data Binding Truth Source',
      severity: 'P0-BLOCKING',
      description: '存在多个语义映射结构，违反 ADR-007 单一真值源原则',
      sources: {
        fieldMapping: hasFieldSemanticMapping,
        semanticMappingDef: hasSemanticMappingDef,
        materializationMappings: hasMaterializationMappings
      }
    });
  } else {
    console.log('\n✓ 单一映射真值源（符合 ADR-007）');
  }
}

// ==================== 问题 4: Action 契约一致性 ====================
console.log('\n\n4. Action 安全契约一致性检查');
console.log('-'.repeat(70));

const actionIssues = [];

if (behavior.PlatformBehavior) {
  for (const key in behavior.PlatformBehavior) {
    const def = behavior.PlatformBehavior[key];

    if (def && def.type === 'ActionTypeDefinition') {
      const name = def.localName || key;

      // Check idempotency vs retry policy
      if (def.retryPolicy && !def.isIdempotent) {
        actionIssues.push({
          action: name,
          issue: 'retryPolicy 存在但 isIdempotent 不为 true（违反 ADR-008）'
        });
      }

      // Check idempotencyKeyFieldRequired vs parameters
      if (def.idempotencyKeyFieldRequired === true && def.parameters) {
        const hasRequiredIdempotencyKey = def.parameters.some(p =>
          p.name && p.name.toLowerCase().includes('idempotency') && p.required === true
        );

        if (!hasRequiredIdempotencyKey) {
          actionIssues.push({
            action: name,
            issue: 'idempotencyKeyFieldRequired=true 但参数中无必填的幂等键'
          });
        }
      }

      // Check for undeclared fields
      const declaredFields = new Set(['type', 'iri', 'namespace', 'localName', 'label', 'definition',
        'parameters', 'returns', 'isIdempotent', 'retryPolicy', 'compensatingActions',
        'idempotencyKeyFieldRequired', 'executionRecord', 'governance', 'alignments', 'note']);

      for (const field in def) {
        if (!declaredFields.has(field)) {
          actionIssues.push({
            action: name,
            issue: `使用了未声明的字段: ${field}`
          });
        }
      }
    }
  }
}

if (actionIssues.length > 0) {
  console.log(`✗ 发现 ${actionIssues.length} 个 Action 契约问题:`);
  actionIssues.forEach(ai => {
    console.log(`  - ${ai.action}: ${ai.issue}`);
  });
  issues.push({
    category: 'Action Safety',
    severity: 'P0-BLOCKING',
    description: `${actionIssues.length} 个 Action 定义违反安全契约`,
    details: actionIssues
  });
} else {
  console.log('✓ 所有 Action 定义符合安全契约');
}

// ==================== 问题 5: 时间映射完整性 ====================
console.log('\n\n5. 时间语义映射完整性检查');
console.log('-'.repeat(70));

const temporalIssues = [];

// Check if TemporalMappingSpec exists and is complete
if (dataBinding.DataBinding && dataBinding.DataBinding.TemporalMappingSpec) {
  const spec = dataBinding.DataBinding.TemporalMappingSpec;

  const requiredFields = ['validFromField', 'validToField', 'knowledgeFromField', 'knowledgeToField', 'availableAtField'];
  const missingFields = requiredFields.filter(f => !spec[f] && spec[f] !== null);

  if (missingFields.length > 0) {
    temporalIssues.push(`TemporalMappingSpec 缺少字段: ${missingFields.join(', ')}`);
  }

  // Check for deprecated fields
  if (spec.recordedAtField) {
    temporalIssues.push('TemporalMappingSpec 仍使用已废弃的 recordedAtField');
  }
} else {
  temporalIssues.push('未找到 TemporalMappingSpec 定义');
}

if (temporalIssues.length > 0) {
  console.log(`✗ 发现 ${temporalIssues.length} 个时间映射问题:`);
  temporalIssues.forEach(ti => console.log(`  - ${ti}`));
  issues.push({
    category: 'Temporal Mapping',
    severity: 'P1-HIGH',
    description: '时间映射不完整，无法支持历史回放',
    details: temporalIssues
  });
} else {
  console.log('✓ 时间映射完整');
}

// ==================== 最终总结 ====================
console.log('\n' + '='.repeat(70));
console.log('问题总结');
console.log('='.repeat(70));

if (issues.length === 0) {
  console.log('\n✅ 未发现深层架构问题');
  process.exit(0);
} else {
  console.log(`\n❌ 发现 ${issues.length} 类架构问题:\n`);

  const p0Issues = issues.filter(i => i.severity === 'P0-BLOCKING');
  const p1Issues = issues.filter(i => i.severity === 'P1-HIGH');

  console.log(`P0 阻断问题: ${p0Issues.length}`);
  p0Issues.forEach(issue => {
    console.log(`  - ${issue.category}: ${issue.description}`);
  });

  console.log(`\nP1 高优先级问题: ${p1Issues.length}`);
  p1Issues.forEach(issue => {
    console.log(`  - ${issue.category}: ${issue.description}`);
  });

  // Write detailed report
  const reportPath = path.join(__dirname, '..', 'docs', 'reports', 'deep-analysis-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: issues.length,
      p0: p0Issues.length,
      p1: p1Issues.length
    },
    issues
  }, null, 2), 'utf8');

  console.log(`\n详细报告已保存至: ${reportPath}`);

  process.exit(p0Issues.length > 0 ? 1 : 0);
}
