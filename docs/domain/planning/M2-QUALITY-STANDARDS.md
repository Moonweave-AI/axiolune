## 6. 质量标准与验收

### 6.1 validate-m2.js 验证规则

#### 检查1: M3语法合规性

**规则**: 所有类型定义必须使用M3定义的元类型

```javascript
function checkM3Syntax(yaml) {
  const allowedKinds = [
    'ObjectTypeDefinition',
    'AssociationTypeDefinition',
    'EnumTypeDefinition',
    'ValueTypeDefinition',
    'SemanticMappingDefinition'
  ];
  
  for (const [typeName, typeDef] of Object.entries(yaml)) {
    if (!typeDef.kind) {
      errors.push(`${typeName}: missing 'kind' field`);
    } else if (!allowedKinds.includes(typeDef.kind)) {
      errors.push(`${typeName}: invalid kind '${typeDef.kind}'`);
    }
  }
}
```

**验收标准**:
- ✅ 100% 类型定义有 `kind` 字段
- ✅ 所有 `kind` 值在允许列表内
- ❌ 零自定义元类型

#### 检查2: ADR-012三轴时间语义

**规则**: 时序数据类型必须显式绑定validTime/knowledgeTime/availabilityTime

```javascript
function checkTemporalSemantics(mappings) {
  const temporalTypes = identifyTemporalTypes(mappings);
  
  for (const mapping of temporalTypes) {
    if (!mapping.temporal) {
      errors.push(`${mapping.targetType}: missing temporal binding`);
    } else {
      const axes = mapping.temporal;
      if (!axes.validTime && !axes.knowledgeTime && !axes.availabilityTime) {
        errors.push(`${mapping.targetType}: no time axes bound`);
      }
      
      // 检查时序数据至少绑定validTime和knowledgeTime
      if (isHighFrequencyData(mapping) && (!axes.validTime || !axes.knowledgeTime)) {
        errors.push(`${mapping.targetType}: high-frequency data must bind validTime and knowledgeTime`);
      }
    }
  }
}

function isHighFrequencyData(mapping) {
  const highFreqTypes = ['QuoteTick', 'TradeTick', 'Bar', 'OrderEvent'];
  return highFreqTypes.some(t => mapping.targetType.includes(t));
}
```

**验收标准**:
- ✅ QuoteTick/TradeTick/Bar 100%绑定三轴
- ✅ OrderEvent/PositionEvent 100%绑定knowledgeTime
- ❌ 零CURRENT_TIMESTAMP使用

#### 检查3: FIBO对齐完整性

**规则**: 核心50个金融概念必须有FIBO对齐

```javascript
const CORE_CONCEPTS = [
  'ISIN', 'CUSIP', 'LEI', 'MIC', 'Currency',
  'Equity', 'Bond', 'Option', 'Future', 'Swap',
  'Issuer', 'Exchange', 'Broker',
  'Order', 'Position', 'VaR'
  // ... 共50个
];

function checkFIBOAlignment(types) {
  for (const conceptName of CORE_CONCEPTS) {
    const typeDef = types[conceptName];
    if (!typeDef) {
      errors.push(`Core concept ${conceptName} not defined`);
      continue;
    }
    
    if (!typeDef.alignments || typeDef.alignments.length === 0) {
      errors.push(`${conceptName}: missing FIBO alignment`);
    } else {
      const fiboAlignment = typeDef.alignments.find(a => a.vocabulary === 'FIBO');
      if (!fiboAlignment) {
        errors.push(`${conceptName}: missing FIBO alignment`);
      } else if (!fiboAlignment.targetIri) {
        errors.push(`${conceptName}: FIBO alignment missing targetIri`);
      } else if (!fiboAlignment.relation) {
        errors.push(`${conceptName}: FIBO alignment missing relation`);
      } else if (!fiboAlignment.verifiedBy || !fiboAlignment.verifiedDate) {
        warnings.push(`${conceptName}: FIBO alignment not verified`);
      }
    }
  }
}
```

**验收标准**:
- ✅ 核心50个概念100%有FIBO对齐
- ✅ 对齐关系指定(exactMatch/closeMatch等)
- ✅ targetIri有效且可解析
- ⚠️ 建议有verifiedBy和verifiedDate

#### 检查4: 模块依赖完整性

**规则**: imports声明的模块必须存在且可解析

```javascript
function checkDependencies(modules) {
  const moduleRegistry = buildModuleRegistry(modules);
  
  for (const module of modules) {
    if (!module.imports) continue;
    
    for (const imp of module.imports) {
      // 检查模块是否存在
      if (!moduleRegistry.has(imp.moduleIri)) {
        errors.push(`${module.moduleIri}: imports unknown module ${imp.moduleIri}`);
      }
      
      // 检查版本是否匹配
      const targetModule = moduleRegistry.get(imp.moduleIri);
      if (targetModule && imp.version && targetModule.version !== imp.version) {
        errors.push(`${module.moduleIri}: version mismatch for ${imp.moduleIri}`);
      }
      
      // 检查selective import的类型是否存在
      if (imp.importMode === 'Selective') {
        for (const typeName of imp.importedTypes || []) {
          if (!targetModule.types.includes(typeName)) {
            errors.push(`${module.moduleIri}: imports non-existent type ${typeName}`);
          }
        }
      }
    }
  }
  
  // 检查循环依赖
  const cycles = detectCycles(buildDependencyGraph(modules));
  if (cycles.length > 0) {
    errors.push(`Circular dependencies detected: ${cycles.join(', ')}`);
  }
}
```

**验收标准**:
- ✅ 所有imports可解析
- ✅ 版本精确匹配
- ✅ Selective导入的类型存在
- ❌ 零循环依赖

#### 检查5: 禁止design-draft引用

**规则**: 不得引用design-draft目录的任何概念

```javascript
function checkNoDesignDraft(modules) {
  const DESIGN_DRAFT_PATTERN = /design-draft/i;
  
  for (const module of modules) {
    // 检查imports
    for (const imp of module.imports || []) {
      if (DESIGN_DRAFT_PATTERN.test(imp.moduleIri)) {
        errors.push(`${module.moduleIri}: imports from design-draft (${imp.moduleIri})`);
      }
    }
    
    // 检查类型引用
    const yamlContent = JSON.stringify(module);
    if (DESIGN_DRAFT_PATTERN.test(yamlContent)) {
      errors.push(`${module.moduleIri}: contains 'design-draft' references`);
    }
    
    // 检查文档注释
    if (module.metadata?.description && DESIGN_DRAFT_PATTERN.test(module.metadata.description)) {
      warnings.push(`${module.moduleIri}: mentions 'design-draft' in documentation`);
    }
  }
}
```

**验收标准**:
- ✅ 零design-draft imports
- ✅ 零design-draft IRI引用
- ⚠️ 文档可提及但不得作为权威源

#### 检查6: 语义版本规范

**规则**: 版本号必须遵循semver规范

```javascript
function checkSemanticVersioning(modules) {
  const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;
  
  for (const module of modules) {
    if (!module.version) {
      errors.push(`${module.moduleIri}: missing version`);
    } else if (!SEMVER_PATTERN.test(module.version)) {
      errors.push(`${module.moduleIri}: invalid semver '${module.version}'`);
    }
  }
}
```

**验收标准**:
- ✅ 所有模块有version字段
- ✅ 版本号符合semver格式
- ✅ Week 1-9使用0.x.y，Week 10发布1.0.0

### 6.2 代码审查清单

#### 本体设计审查

**审查人**: 本体工程师 + 金融专家

- [ ] **定义质量** (ISO 704标准)
  - 定义清晰、无歧义
  - 包含必要和充分特征
  - 使用标准金融术语
  
- [ ] **继承层次合理**
  - 深度 ≤ 3层
  - 子类型是父类型的真子集
  - 无重复概念
  
- [ ] **属性完整性**
  - 必需属性标记required: true
  - 约束合理（pattern, range）
  - 类型选择恰当
  
- [ ] **关联正确性**
  - participantRoles语义清晰
  - 基数约束准确（cardinality）
  - 关联方向合理
  
- [ ] **不变式有效性**
  - 逻辑约束正确
  - 可验证
  - 不与其他约束冲突

#### 数据绑定审查

**审查人**: 数据工程师

- [ ] **ADR-011合规**
  - 单一SemanticMappingDefinition真值源
  - 无Field.semanticMapping
  - RowSetSpec清晰

- [ ] **ADR-012合规**
  - 三轴时间显式绑定
  - bindingType正确（directField/transformation/runtimeContext）
  - closePolicy合理

- [ ] **性能考虑**
  - 避免笛卡尔积（joins优化）
  - 过滤条件前置（filters）
  - 索引字段作为logicalKey

#### FIBO对齐审查

**审查人**: 金融专家

- [ ] **对齐关系正确**
  - exactMatch: 概念完全等价
  - closeMatch: 高度相似但有差异
  - broadMatch/narrowMatch: 层次关系正确
  
- [ ] **对齐文档完整**
  - rationale充分说明
  - verifiedBy和verifiedDate存在
  - targetIri可访问

- [ ] **覆盖率达标**
  - 核心50个概念100%对齐
  - 重要概念建议对齐

### 6.3 测试标准

#### 单元测试

**核心类型必须有单元测试** (至少20个类型):

```javascript
// 示例: ISIN验证测试
describe('ISIN', () => {
  test('valid ISIN passes validation', () => {
    const isin = 'US0378331005'; // Apple Inc.
    expect(validateISIN(isin)).toBe(true);
  });
  
  test('invalid checksum fails', () => {
    const isin = 'US0378331006'; // wrong checksum
    expect(validateISIN(isin)).toBe(false);
  });
  
  test('invalid format fails', () => {
    const isin = '12INVALID34';
    expect(validateISIN(isin)).toBe(false);
  });
});
```

**测试覆盖类型**:
- 标识符: ISIN, CUSIP, LEI, MIC
- 工具: Equity, Option, Future
- 订单: Order状态转换
- 持仓: T1Position不变式
- 风险: VaR计算

#### 集成测试

**数据绑定端到端测试** (至少5个):

```javascript
describe('QuoteTick Materialization', () => {
  test('CSV to QuoteTick with three-axis temporal', async () => {
    const csvData = `symbol,bid,ask,timestamp,received_at
AAPL,195.20,195.25,2026-07-30T14:30:00Z,2026-07-30T14:30:00.123Z`;
    
    const result = await materialize('QuoteTickMapping', csvData);
    
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].bidPrice).toBe(195.20);
    expect(result.entities[0].validTime).toBe('2026-07-30T14:30:00Z');
    expect(result.entities[0].knowledgeTime).toBe('2026-07-30T14:30:00.123Z');
    expect(result.entities[0].availabilityTime).toBeDefined();
  });
});
```

#### 性能测试

**PIT查询性能要求**:

```javascript
describe('Point-in-Time Query Performance', () => {
  test('query 1000 positions as-of specific time < 100ms', async () => {
    const asOfTime = '2026-07-30T00:00:00Z';
    
    const start = Date.now();
    const positions = await queryPIT('Position', { asOfTime, limit: 1000 });
    const duration = Date.now() - start;
    
    expect(positions).toHaveLength(1000);
    expect(duration).toBeLessThan(100); // < 100ms
  });
});
```

**性能基准**:
- PIT查询1000条记录: < 100ms
- 订单状态转换验证: < 10ms
- FIBO对齐查询: < 50ms

### 6.4 文档标准

#### 每个模块必需文档

**1. README.md** (模块根目录)
```markdown
# [模块名称] Module

## 概述
[模块用途1-2段]

## 核心概念
- **TypeName**: [简短说明]
- **AnotherType**: [简短说明]

## 依赖关系
- 依赖: [列出imports]
- 被依赖: [列出哪些模块依赖本模块]

## 使用示例
[代码示例]

## FIBO对齐
[核心概念的FIBO对齐状态]

## 版本历史
- 0.1.0: 初始版本
```

**2. 类型定义文档** (每个YAML文件)
- ISO 704规范的definition
- 属性说明
- 不变式解释
- 使用场景

**3. 数据绑定示例** (examples/bindings/)
- 真实数据源示例
- 三轴时间绑定
- 注释说明

### 6.5 最终验收门禁

**必须全部通过才能发布1.0.0**:

#### 自动化检查 (零错误)
- [ ] validate-m2.js所有检查通过
- [ ] 单元测试100%通过
- [ ] 集成测试100%通过
- [ ] 性能测试达标

#### 人工审查 (全部Approved)
- [ ] 本体工程师代码审查
- [ ] 金融专家领域审查
- [ ] 数据工程师绑定审查
- [ ] FIBO对齐专家审查

#### 文档完整性
- [ ] 8个模块README
- [ ] 15个数据绑定示例
- [ ] ADR-013/014/015 Accepted
- [ ] FIBO对齐文档

#### 生产就绪
- [ ] 安全审查通过
- [ ] 性能测试达标
- [ ] 语义版本1.0.0
- [ ] 部署文档完整

---
