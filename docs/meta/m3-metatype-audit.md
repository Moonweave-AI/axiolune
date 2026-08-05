# M3 元类型核查工作底稿

> **用途**：M3 语义元模型（v0.6.0）的半人工核查底稿。
> **信息源**：本底稿由 `scripts/meta/generate-m3-audit.cjs` 直接读取 `ontology/meta/*.yaml`（四个元模型 YAML，权威源）生成，不凭记忆杜撰。
> **核查方式**：逐个元类型核对 IRI、定义、OWL 投影、字段清单。每项后附核查标记位 `[ ]`。
> **生成时间**：2026-08-04T02:23:57.906Z

---

## 总览

M3 是 Axiolune 的语义元模型，定义 M2 领域模块可实例化的元类型。M3 分四层，均为 v0.6.0：

| 层 | 文件 | 中文 | 元类型数 | 模块 IRI |
|---|---|---|---|---|
| Layer 1 | `core-meta-model.yaml` | 核心元模型 | 56 | `https://axiolune.ai/ontology/meta/core` |
| Layer 2 | `cross-domain-patterns.yaml` | 跨域模式 | 8 | `https://axiolune.ai/ontology/meta/patterns` |
| Layer 3 | `behavior-meta-model.yaml` | 行为元模型 | 6 | `https://axiolune.ai/ontology/meta/behavior` |
| Layer 4 | `data-binding-meta-model.yaml` | 数据绑定元模型 | 68 | `https://axiolune.ai/ontology/meta/data-binding` |

### 核查要点（通读前必看）

1. **元类型 IRI 与 OWL 投影**：自 v0.6.0 起，每个 M3 元类型 schema 顶层都带有规范 `iri:` 字段（形如 `https://axiolune.ai/ontology/meta/{layer}/{Name}`），并在投影 OWL 中由 `generate-owl.js` 的 R0 规则声明为 `owl:Class` 或 `owl:ObjectProperty`/`owl:DatatypeProperty`。底稿中「IRI」列应已填充；若仍为空，说明该 schema 缺少 `iri:` 字段，属需修补的漂移。
2. **定义规范**：每个元类型应有 ISO 704 属种差定义（genus + differentia）。核查定义是否完整、是否区分于相邻元类型。
3. **中文导读（cnNote）**：每个元类型 schema 顶层带 `cnNote:` 字段，提供通俗中文理解，辅助审查；导读非权威定义，权威定义仍以 YAML 英文原文为准。
4. **OWL 投影**：`owlProjection.kind` 决定该元类型如何投影为 OWL 构造（class / datatypeProperty / objectProperty / structuredValueClass 等）。核查投影是否与字段语义一致。
5. **字段完整性**：必填字段是否合理、类型引用是否指向已定义的元类型、枚举值是否穷尽。
6. **版本**：四个层均声明 v0.6.0；元类型 IRI 若存在应携带版本。

---

## Layer 1 · 核心元模型（MetaModel）

**文件**：`ontology/meta/core-meta-model.yaml`
**模块 IRI**：`https://axiolune.ai/ontology/meta/core`  ·  **版本**：0.6.0  ·  **前缀**：`ax-meta`
**层说明**：Semantic core meta-model defining ontology structure, types, and alignment
**元类型总数**：56

---

### OntologyModuleDefinition

> **中文导读**：本体的"容器"——一个有名字、版本、依赖关系的模块；M2 每个金融模块都是它的一个实例，靠 imports 锁定依赖版本与摘要。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/OntologyModuleDefinition` |
| **OWL 投影** | kind: ontology |
| **定义（YAML 原文）** | a named collection of ontology elements with versioning and dependency management |

> **注**：Updated in ADR-004 to support version-locked imports and symbol resolution

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `moduleIri` | 是 | `iri` | — | — | globally unique IRI for this module (identifies the module itself) |
| `baseIri` | 是 | `iri` | — | — | base IRI for concepts defined in this module (used for symbol resolution) |
| `preferredPrefix` | 是 | `string` | ^[a-z][a-z0-9-]*$ | — | short prefix for this module (used in prefix:localName references) |
| `version` | 是 | `string` | ^\d+\.\d+\.\d+$ | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `imports` | 否 | `list[ModuleImportDefinition]` | — | — | version-locked imports of other modules |
| `exports` | 否 | `list[iri]` | — | — | explicitly exported symbol IRIs (empty list = export all) |
| `status` | 否 | `enum` | draft/review/approved/deprecated | draft |  |
| `governance` | 否 | `GovernanceMetadata` | — | — | owner, approvers, change history |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ModuleImportDefinition

> **中文导读**：一次"带锁的导入"——锁定被导入模块的版本和文件摘要，保证符号解析可复现、不被对方的隐式升级破坏。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ModuleImportDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a version-locked import of another ontology module |

> **注**：Ensures deterministic symbol resolution and prevents breaking changes from implicit updates

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `moduleIri` | 是 | `iri` | — | — | IRI of the imported module |
| `version` | 是 | `string` | ^\d+\.\d+\.\d+$ | — | locked version of the imported module |
| `artifactDigest` | 是 | `string` | ^sha256:[0-9a-f]{64}$ | — | SHA-256 digest of the imported module file |
| `importMode` | 是 | `enum` | All/Selective | — | All = import all exported symbols; Selective = import only specified symbols |
| `importedSymbols` | 否 | `list[SymbolImportSpec]` | — | — | symbols to import (required if importMode=Selective) |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SymbolImportSpec

> **中文导读**：选择性导入时挑的一个符号，可起本地别名（如把 fibo:FinancialInstrument 别名为 Instrument），用于精确控制引入范围。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/SymbolImportSpec` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of a single imported symbol with optional local alias |

**字段清单**（共 2 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `symbolIri` | 是 | `iri` | — | — | complete IRI of the imported symbol |
| `localAlias` | 否 | `string` | — | — | optional non-empty Unicode NFC local alias for this symbol |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### LocalizedTextDefinition

> **中文导读**：多语言文本值对象——带语言标签的文本，投影为 rdf:langString；ChangeRecord 的 description 用它实现中英双语变更说明。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/LocalizedTextDefinition` |
| **OWL 投影** | kind: rdfLangString  ·  note: Projects to rdf:langString with @en, @zh, etc. language tags |
| **定义（YAML 原文）** | a value object for multi-language text with language tags |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `language` | 是 | `string` | ^[a-z]{2}(-[A-Z]{2})?$ | — | language tag (ISO 639-1, optional ISO 3166-1) |
| `text` | 是 | `string` | — | — | text content in the specified language |
| `defaultLanguage` | 否 | `string` | — | en | fallback language if requested language not available |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ValueType

> **中文导读**：原语类型清单（string/decimal/integer/boolean/date/instant/duration/uri），映射到 xsd；属性挂"纯标量"时用它，金融金额等复杂值要走 MoneyType/QuantityType 而非裸 decimal。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ValueType` |
| **OWL 投影** | kind: datatype |
| **定义（YAML 原文）** | a meta-classifier for primitive value types used in attributes |

> **注**：Domain-specific types (ISIN, MoneyTypeDefinition, QuantityTypeDefinition) defined as IdentifierTypeDefinition, MoneyTypeDefinition, QuantityTypeDefinition

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IdentifierTypeDefinition

> **中文导读**：带校验规则和发码机构的标准标识符类型（如 ISIN）；校验逻辑通过 validatorRef 指向一个 ConstraintDefinition，被 AttributeTypeDefinition.valueType 引用时投影为 DatatypeProperty。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/IdentifierTypeDefinition` |
| **OWL 投影** | kind: datatype |
| **定义（YAML 原文）** | a meta-classifier for standard identifiers with validation rules and issuing authorities |

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `baseType` | 是 | `ValueType` | — | string |  |
| `standard` | 是 | `string` | — | — | governing standard |
| `validatorRef` | 是 | `uri` | — | — | reference to ConstraintDefinition IRI |
| `issuingAuthority` | 否 | `string` | — | — | organization responsible for identifier issuance |
| `alignments` | 否 | `list[Alignment]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MoneyTypeDefinition

> **中文导读**：带币种和精度的"钱"——金融金额禁止用裸 decimal，必须用它；投影成 MonetaryAmount 类（含 amount/currency/scale），被属性引用时投影为 ObjectProperty。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/MoneyTypeDefinition` |
| **OWL 投影** | kind: structuredValueClass  ·  classIri: https://axiolune.ai/ontology/meta/core/values/MonetaryAmount |
| **定义（YAML 原文）** | a meta-classifier for monetary amounts with currency and scale |

> **注**：MUST NOT use generic number or decimal for financial amounts. Projected as a structured value class (not a simple datatype) to preserve currency, amount, and scale independence.

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### QuantityTypeDefinition

> **中文导读**：带单位和精度的"量"（如 100 股、5 桶）——投影成 QuantityValue 类（含 value/unit/precision/rounding），与 MoneyType 的区别是管一般量、不管币种；默认银行家舍入（half-even）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/QuantityTypeDefinition` |
| **OWL 投影** | kind: structuredValueClass  ·  classIri: https://axiolune.ai/ontology/meta/core/values/QuantityValue |
| **定义（YAML 原文）** | a meta-classifier for measurements with units and precision |

> **注**：Projected as a structured value class to preserve value, unit, precision, and rounding independently. Unit should be a URI reference to a unit ontology (e.g., QUDT) in production.

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### CodeListTypeDefinition

> **中文导读**：受控词表类型——带版本、维护方、证据锁的枚举（如 ISO 10383 交易所代码）；投影为 owl:Class，成员是 CodeValueDefinition，被属性引用时投影为 ObjectProperty。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/CodeListTypeDefinition` |
| **OWL 投影** | kind: class  ·  stereotype: enumeration |
| **定义（YAML 原文）** | a meta-classifier for controlled vocabularies with versioning and maintenance |

**字段清单**（共 11 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `vocabulary` | 是 | `string` | — | — | name of the code list |
| `version` | 是 | `string` | — | — |  |
| `maintainer` | 是 | `string` | — | — | organization maintaining the code list |
| `sourceEvidenceRef` | 是 | `uri` | — | — | absolute IRI of the uniquely locked reference record that governs this code-list |
| `values` | 否 | `list[CodeValueDefinition]` | — | — | enumerated values |
| `alignments` | 否 | `list[Alignment]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### CodeValueDefinition

> **中文导读**：词表里的一个稳定成员——有 IRI、规范记法（notation）、可标记弃用并指向替代者；投影为 namedIndividual，属于某个 CodeListTypeDefinition.values。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/CodeValueDefinition` |
| **OWL 投影** | kind: namedIndividual |
| **定义（YAML 原文）** | a stable member of one versioned CodeListTypeDefinition, identified by an IRI and canonical notation |

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `notation` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `deprecated` | 否 | `boolean` | — | false |  |
| `replacedBy` | 否 | `uri` | — | — |  |
| `sourceEvidenceRef` | 否 | `uri` | — | — | optional evidence narrowing within the containing code-list snapshot |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ObjectTypeDefinition

> **中文导读**：Layer 1 的核心枢纽——有同一性的领域实体类型（如 Equity、Order）；投影为 owl:Class，挂 attributeUses/patternBindings/constraints/superTypes，是 M2 所有实体的"语法母版"。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ObjectTypeDefinition` |
| **OWL 投影** | kind: class |
| **定义（YAML 原文）** | a meta-classifier that defines domain entity types with identity, properties, and constraints |

**字段清单**（共 12 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — | module namespace prefix |
| `localName` | 是 | `string` | — | — | name within namespace |
| `label` | 是 | `string` | — | — | human-readable name |
| `definition` | 是 | `string` | — | — |  |
| `superTypes` | 否 | `list[uri]` | — | — | semantic parent classes (multiple inheritance for true semantic subsumption) |
| `attributeUses` | 否 | `list[AttributeUse]` | — | — | attributes applied to this type with contextual constraints |
| `patternBindings` | 否 | `list[PatternBinding]` | — | — | cross-domain patterns bound to this type |
| `constraints` | 否 | `list[ConstraintBinding]` | — | — | validation rules applied to this type |
| `alignments` | 否 | `list[Alignment]` | — | — | mappings to external ontologies (FIBO, industry standards) |
| `governance` | 否 | `GovernanceMetadata` | — | — |  |
| `abstract` | 否 | `boolean` | — | false | true only for a non-instantiable semantic supertype; abstract types do not recei |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### AttributeTypeDefinition

> **中文导读**：挂在实体上的"字面值/结构化值"属性的全局定义（如 hasISIN）；按 valueType 决定 OWL 投影——原语/标识符走 DatatypeProperty，词表/结构化值走 ObjectProperty；与 AttributeUse 分离，后者管"在某类型上的具体使用"。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/AttributeTypeDefinition` |
| **OWL 投影** | note: Projection kind depends on valueType category: primitives and IdentifierTypeDefinition project to datatype properties; C |
| **定义（YAML 原文）** | a meta-classifier for typed properties that attach literal values or structured value objects to entities |

> **注**：Renamed from PropertyType to clarify it represents literal-valued attributes, not object relations. OWL projection is now conditional based on valueType complexity.

**字段清单**（共 12 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `valueType` | 是 | `string` | — | — | reference to ValueType, IdentifierTypeDefinition, MoneyTypeDefinition, QuantityT |
| `owlProjectionOverride` | 否 | `enum` | datatypeProperty/objectProperty/annotationProperty | — | explicit override of automatic OWL projection (use sparingly) |
| `defaultCardinality` | 否 | `` | — | — |  |
| `enumValues` | 否 | `list[string]` | — | — | allowed values for enum types |
| `pattern` | 否 | `string` | — | — | regex validation pattern |
| `unit` | 否 | `string` | — | — | physical or financial unit for numeric types |
| `alignments` | 否 | `list[Alignment]` | — | — | evidence-locked external mappings; every authored row must satisfy the complete  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### sourceEvidenceRef

> **中文导读**：注解属性：将本体资源链接到支持其权威含义的不可变证据资源。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/annotations/sourceEvidenceRef` |
| **OWL 投影** | override: annotationProperty |
| **定义（YAML 原文）** | annotation property that links an ontology resource to the immutable evidence resource supporting its authored meaning or controlled-vocabulary membership |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### AttributeUse

> **中文导读**：把全局 AttributeTypeDefinition 绑到具体类型上的"使用记录"，可在此上下文覆盖基数、加约束、改显示名；与 AttributeTypeDefinition 对称——一个管"定义"，一个管"在哪个类型上怎么用"。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/AttributeUse` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a binding of an AttributeTypeDefinition to an ObjectTypeDefinition with contextual constraints |

> **注**：Separates global attribute definition from context-specific usage

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `attribute` | 是 | `uri` | — | — | reference to global AttributeTypeDefinition |
| `minCount` | 否 | `integer` | — | — | override global minCount; 1 means required in this context |
| `maxCount` | 否 | `integer` | — | — | override global maxCount; null means unbounded |
| `label` | 否 | `string` | — | — | context-specific display label (does NOT change semantics) |
| `defaultValue` | 否 | `string` | — | — | default value when not provided |
| `constraints` | 否 | `list[ConstraintBinding]` | — | — | additional validation rules for this usage context |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### validFrom

> **中文导读**：业务有效期起点：事实在现实世界中开始为真的时刻（业务时间轴）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/validFrom` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time that marks the beginning of the business validity period during which a fact is considered true in the real world |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### validTo

> **中文导读**：业务有效期终点：事实在现实世界中停止为真的时刻，null 表示仍有效。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/validTo` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time that marks the end of the business validity period during which a fact is considered true in the real world, or null if the fact remains valid indefinitely |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### knowledgeFrom

> **中文导读**：知识期起点：平台开始断言该版本事实为真的系统时间（知识时间轴）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in system time when the platform began to assert a particular version of a fact as part of its knowledge base |

> **注**：Distinct from validFrom; knowledgeFrom tracks when WE learned about the fact, not when it became true in reality

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### knowledgeTo

> **中文导读**：知识期终点：平台停止断言该版本为当前的系统时间，null 表示当前版本。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeTo` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in system time when the platform ceased to assert a particular version of a fact as current, either due to supersession by a newer version or explicit retraction, or null if this version remains current |

> **注**：null value indicates current version; non-null indicates superseded or retracted

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### observedAt

> **中文导读**：观测时刻：测量/观测/行情读取被源系统原始捕获的时刻。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/observedAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when a measurement, observation, or market data reading was originally made or captured by the source system |

> **注**：Used for market data and sensor readings; semantically distinct from validFrom (observation instant vs validity period)

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### availableFrom

> **中文导读**：可用期起点：数据可被下游消费的起始时刻（含延迟/授权/禁运），PIT 防前视偏差关键。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time that marks the beginning of the availability period during which data may be consumed by a specific downstream subject, accounting for processing delays, authorization checks, and embargo periods |

> **注**：Canonical availability axis start (ADR-012); half-open interval [availableFrom, availableTo). Critical for look-ahead bias prevention in backtesting and compliance audits.

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### availableTo

> **中文导读**：可用期终点：数据可被消费的截止时刻，null 表示一旦到达起点即长期可用。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/availableTo` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time that marks the end of the availability period during which data may be consumed by a specific downstream subject, or null if the data remains available indefinitely |

> **注**：Canonical availability axis end (ADR-012); null = available indefinitely once availableFrom is reached.

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### publishedAt

> **中文导读**：发布时刻：数据提供方/源系统正式发布信息的时刻。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/publishedAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when the data provider or source system officially published or released the information |

> **注**：Source publication time; must be <= receivedAt if both present

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### receivedAt

> **中文导读**：接收时刻：平台摄取系统从外部源收到信息的时刻。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/receivedAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when the platform's ingestion system received the information from the external source |

> **注**：Platform reception time; must be >= publishedAt if both present

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### source

> **中文导读**：来源 URI：标示信息来源的权威数据提供方/系统/组织的 URI。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/source` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | uniform resource identifier that designates the authoritative data provider, system, or organization from which the information originated |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### sourceVersion

> **中文导读**：来源版本：标示来源系统/数据集版本或快照的字符串，用于可复现。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/sourceVersion` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | string identifier that denotes the version, snapshot, or release of the source system or dataset from which the information was obtained |

> **注**：Enables reproducibility by locking to specific source snapshots

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### confidence

> **中文导读**：置信度：[0.0, 1.0] 闭区间的小数，量化断言为真的可靠性。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/confidence` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | decimal number in the closed interval [0.0, 1.0] that quantifies the assessed reliability, certainty, or probability that the asserted fact is correct |

> **注**：0.0 = no confidence, 1.0 = complete certainty; constraint validation enforces [0.0, 1.0] range

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### revision

> **中文导读**：修订号：随事实每次更新单调递增的非负整数，用于变更跟踪。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/revision` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | non-negative integer that increments monotonically with each update or correction to a fact, enabling change tracking and audit history |

> **注**：Starts at 0 for initial version; increments by 1 for each revision

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### derivedFrom

> **中文导读**：派生来源：引用计算/变换/推断出该事实的源事实的 URI 列表（无界）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/derivedFrom` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | list of uniform resource identifiers that reference the source facts from which this fact was computed, transformed, or inferred, establishing lineage for derived data |

> **注**：Unbounded list; used for computed facts, aggregations, and transformations to trace back to original sources

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### recordedAt

> **中文导读**：记录时刻：观测被捕获并记入系统的时刻（TemporalObservation 用）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/recordedAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when an observation was captured and recorded into the system |

> **注**：Used by TemporalObservation pattern; distinct from knowledgeFrom which marks when platform became aware

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### evidenceType

> **中文导读**：证据类型：支持某断言的证据类别（document/measurement/testimony 等）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/evidenceType` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | categorical classification of the kind of evidence supporting a claim or assertion |

> **注**：Enumerated values: document, measurement, testimony, calculation, inference, etc.

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### evidenceRef

> **中文导读**：证据引用：指向支持断言的证据工件的 URI。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/evidenceRef` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | globally unique identifier or IRI pointing to the evidence artifact that supports a claim |

> **注**：Must be resolvable to the actual evidence document, dataset, or record

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### evidenceDigest

> **中文导读**：证据摘要：证据工件的加密哈希（sha256:... 等），保证完整性和防篡改。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/evidenceDigest` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | cryptographic hash of the evidence artifact ensuring integrity and enabling tamper detection |

> **注**：Format: algorithm:hexdigest (e.g., sha256:abc123...); validated by DigestFormat constraint

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### evidenceTimestamp

> **中文导读**：证据时间戳：证据被捕获或创建的时刻。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/evidenceTimestamp` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when the evidence was captured or created |

> **注**：Distinct from the timestamp of the claim itself; records provenance of supporting evidence

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### evidenceDescription

> **中文导读**：证据描述：解释证据性质和相关性的人类可读叙述。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/evidenceDescription` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | human-readable narrative explaining the nature and relevance of the evidence |

> **注**：Should describe what the evidence shows and why it supports the claim

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### lifecycleState

> **中文导读**：生命周期状态：实体/事实当前生命周期阶段（draft/active/deprecated 等）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/lifecycleState` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | enumerated value representing the current stage in the lifecycle of an entity or fact |

> **注**：Common states: draft, active, deprecated, superseded, retired

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### lifecycleVersion

> **中文导读**：生命周期版本：跟踪生命周期状态转换次数的非负整数。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/lifecycleVersion` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | non-negative integer tracking the number of lifecycle state transitions |

> **注**：Increments on each state change; enables audit trail of lifecycle evolution

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### createdAt

> **中文导读**：创建时刻：实体首次在系统中创建的时刻（不可变，区别于业务/知识时间）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/createdAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when an entity was first created in the system |

> **注**：Immutable; distinct from validFrom (business time) and knowledgeFrom (epistemology time)

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### updatedAt

> **中文导读**：更新时刻：实体最后修改的时刻（技术修改时间，非业务有效期）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/updatedAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when an entity was last modified |

> **注**：Updated on each mutation; tracks technical modification time, not business validity time

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### deprecatedAt

> **中文导读**：废弃时刻：实体被标记为废弃的时刻，null 表示未废弃。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/deprecatedAt` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | instant in time when an entity was marked as deprecated |

> **注**：Optional; null if entity is not deprecated

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### semanticVersion

> **中文导读**：语义版本：符合 MAJOR.MINOR.PATCH 的兼容性级别字符串。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/semanticVersion` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | string conforming to semantic versioning specification (MAJOR.MINOR.PATCH) indicating compatibility level |

> **注**：Pattern: ^\d+\.\d+\.\d+$; validated by SemanticVersionFormat constraint

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### versionedIri

> **中文导读**：版本化 IRI：含版本信息的全局唯一 IRI，精确标识版本化资源。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/versionedIri` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | globally unique IRI that includes version information, enabling precise identification of versioned resources |

> **注**：Typically baseIri + localName + version separator + semanticVersion

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### priorVersion

> **中文导读**：前一版本：该实体紧邻前一版本的 IRI，形成版本链。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/priorVersion` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | IRI reference to the immediately preceding version of this entity |

> **注**：Forms a linked version chain; null for initial version

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### incompatibleWith

> **中文导读**：不兼容版本：与本版本已知不兼容的版本 IRI，用于声明破坏性变更。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/attributes/incompatibleWith` |
| **OWL 投影** | override: datatypeProperty |
| **定义（YAML 原文）** | IRI reference to a version that this version is known to be incompatible with |

> **注**：Used to declare breaking changes; multiple incompatibilities expressed via cardinality > 1

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### RelationTypeDefinition

> **中文导读**：两个实体间的二元纯语义关系（如 isIssuedBy），投影为 owl:ObjectProperty；不带时间/上下文——要带就用 AssociationTypeDefinition；可声明 inverseOf 与 OWL 特性（functional/transitive 等）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/RelationTypeDefinition` |
| **OWL 投影** | kind: objectProperty |
| **定义（YAML 原文）** | a meta-classifier for binary semantic relationships between entity types |

> **注**：For pure semantic relations; use AssociationTypeDefinition for relations with context

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `domain` | 是 | `union[ObjectTypeDefinition,AssociationTypeDefinition]` | — | — | subject ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `range` | 是 | `union[ObjectTypeDefinition,AssociationTypeDefinition]` | — | — | object ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `inverseOf` | 否 | `uri` | — | — | inverse RelationTypeDefinition IRI for bidirectional relations |
| `characteristics` | 否 | `list[enum]` | functional/inverseFunctional/transitive/symmetric/asymmetric/reflexive/irreflexive | — | OWL property characteristics |
| `alignments` | 否 | `list[Alignment]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### RelationUse

> **中文导读**：RelationType 在具体上下文里的基数约束——基数是上下文相关的（子类可能有不同约束），所以不放在全局关系定义里；与 AttributeUse 对称，管"关系在某类型间怎么用"。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/RelationUse` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a contextual application of a RelationTypeDefinition with specific cardinality constraints |

> **注**：Cardinality is contextual, not global, because subclasses may have different constraints

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `relation` | 是 | `uri` | — | — | reference to RelationTypeDefinition |
| `subjectType` | 是 | `union[ObjectTypeDefinition,AssociationTypeDefinition]` | — | — | subject ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `objectType` | 是 | `union[ObjectTypeDefinition,AssociationTypeDefinition]` | — | — | object ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `outboundCardinality` | 否 | `` | — | — | how many targets one subject can have |
| `inboundCardinality` | 否 | `` | — | — | how many subjects can point to one target |
| `constraints` | 否 | `list[ConstraintBinding]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### AssociationTypeDefinition

> **中文导读**：可具名的 n-元关系——带同一性、上下文、生命周期（如 PriceObservation、Holding）；投影为 owl:Class，至少 2 个 ParticipantRole，常绑 TemporalFact/ProvenancedFact；与 RelationTypeDefinition 的区别是"边本身也是实体"。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/AssociationTypeDefinition` |
| **OWL 投影** | kind: class  ·  stereotype: association |
| **定义（YAML 原文）** | a meta-classifier for reifiable n-ary relations with identity, context, and lifecycle |

> **注**：Use for relations that need timestamp, source, confidence, quantity, or state (e.g., PriceObservation, Holding, Execution)

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `participantRoles` | 是 | `list[ParticipantRole]` | — | — | typed participants in this association |
| `attributeUses` | 否 | `list[AttributeUse]` | — | — | attributes of the association itself |
| `patternBindings` | 否 | `list[PatternBinding]` | — | — | cross-domain patterns (Temporal, Provenance) bound to this association |
| `projectedRelations` | 否 | `list[uri]` | — | — | convenience binary edges derived from this association (e.g., hasLatestPrice) |
| `alignments` | 否 | `list[Alignment]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ParticipantRole

> **中文导读**：Association 里的一个有类型参与槽（如 observedInstrument、venue），指定 range 指向哪个 ObjectType/Association；关联至少要 2 个角色，是 Association 的"参与者规格"。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ParticipantRole` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a typed slot in an AssociationTypeDefinition specifying the role and type of a participant |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `id` | 是 | `string` | — | — | role identifier |
| `range` | 是 | `union[ObjectTypeDefinition,AssociationTypeDefinition]` | — | — | participant ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `minCount` | 是 | `integer` | — | 0 | minimum number of participants in this role |
| `maxCount` | 是 | `integer` | — | — | maximum number of participants in this role (null = unbounded) |
| `label` | 否 | `string` | — | — |  |
| `definition` | 否 | `string` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PatternBinding

> **中文导读**：声明某 ObjectType/AssociationType 遵循某个 Layer 2 跨域模式（如 TemporalFact）；绑了就自动获得模式注入的属性和约束，是"跨域模式落到具体类型"的接缝，pattern 指向 Layer 2 的 PatternDefinition IRI。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/PatternBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a declaration that an ObjectTypeDefinition or AssociationTypeDefinition adheres to a cross-domain pattern |

> **注**：Patterns from Layer 2 (Temporal, Provenance, Evidence) inject attribute requirements and constraints

**字段清单**（共 2 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `pattern` | 是 | `uri` | — | — | reference to cross-domain pattern IRI |
| `parameters` | 否 | `dict` | — | — | pattern-specific configuration |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### Alignment

> **中文导读**：本地概念到外部标准（FIBO 等）的有据映射——不是写个链接，而是"版本锁 + 字节定位 + 理由 + 审核"的完整契约；sourceLocator 强制指向 Layer 4 的 SourceLocator，proposed 不等于 approved。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/Alignment` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a documented mapping between a local ontology element and an external standard |

> **注**：Supports audit, version control, and semantic interoperability without requiring exactMatch for all concepts

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `vocabulary` | 是 | `string` | — | — | external vocabulary name |
| `targetIri` | 是 | `uri` | — | — | IRI of the external concept (without version query parameters) |
| `relation` | 是 | `enum` | skos:exactMatch/skos:closeMatch/skos:broadMatch/skos:narrowMatch/rdfs:subClassOf/rdfs:subPropertyOf/owl:equivalentClass/owl:equivalentProperty | — | type of alignment relationship |
| `sourceRelease` | 是 | `` | — | — | mandatory version lock for the exact external vocabulary bytes |
| `sourceLocator` | 是 | `Layer4:SourceLocator` | — | — | mandatory closed media-aware selector from the active M3 profile; plain path or  |
| `rationale` | 是 | `string` | — | — | mandatory justification covering local and target meaning, entity kind, and rela |
| `verification` | 是 | `` | — | — | mandatory review state; proposed is not approval |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ConstraintDefinition

> **中文导读**：可复用的语义校验规则（如 ISIN 校验位），投影为 owl:Class；带 expression（SHACL/SPARQL/Regex 等）、severity、message；通过 ConstraintBinding 绑到具体元素，"定义"与"绑定"分离使一条规则可复用多次。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ConstraintDefinition` |
| **OWL 投影** | kind: class  ·  stereotype: constraint |
| **定义（YAML 原文）** | a meta-classifier for semantic validation rules that can be applied to types, attributes, relations, or associations |

**字段清单**（共 15 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — | globally unique IRI for this constraint |
| `namespace` | 是 | `string` | — | — | module namespace prefix |
| `localName` | 是 | `string` | — | — | constraint name within namespace |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `constraintType` | 是 | `enum` | Cardinality/ValueRange/Pattern/Custom/Logical/Uniqueness/Dependency | — | category of constraint |
| `scope` | 是 | `enum` | Attribute/Identifier/CodeList/Relation/Object/Association/Pattern/Module | — | what kind of element this constraint applies to |
| `expression` | 是 | `ConstraintExpression` | — | — | formal expression of the constraint |
| `severity` | 是 | `enum` | Error/Warning/Info | Error |  |
| `message` | 是 | `string` | — | — | human-readable violation message template |
| `targetElement` | 否 | `uri` | — | — | IRI of the primary element this constraint validates (pattern extension; used by |
| `note` | 否 | `string` | — | — | explanatory note for this constraint |
| `parameters` | 否 | `list[ConstraintParameter]` | — | — | parameterized constraints |
| `dependencies` | 否 | `list[uri]` | — | — | other constraints that must be satisfied first |
| `alignments` | 否 | `list[Alignment]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ConstraintExpression

> **中文导读**：约束的"表达式本身"——声明语言（SHACL/SPARQL/JSONSchema/Regex/Custom）和表达式串，可带 expressionDigest 防篡改；属于 ConstraintDefinition.expression。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ConstraintExpression` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | the formal expression of a constraint rule |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `language` | 是 | `enum` | SHACL/SPARQL/JSONSchema/Regex/Custom | — | constraint expression language |
| `expression` | 是 | `string` | — | — | the actual constraint expression |
| `expressionDigest` | 否 | `string` | — | — | SHA256 hash of expression for versioning |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ConstraintParameter

> **中文导读**：参数化约束的参数定义（如 NoFutureKnowledge 的 $referenceTime）；注意运行时参数化约束由 PIT 校验器绑定，静态 SHACL 绑不了运行时参数。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ConstraintParameter` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a parameter for parameterized constraints |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `string` | — | — |  |
| `type` | 是 | `string` | — | — | parameter value type |
| `required` | 否 | `boolean` | — | true |  |
| `defaultValue` | 否 | `any` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ConstraintBinding

> **中文导读**：把一个 ConstraintDefinition 应用到具体元素上，带参数值和执行级别（Mandatory/Advisory/Disabled）与执行时机（Write/Read/Query/Import/Export）；是约束"定义"与"使用"之间的桥梁。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ConstraintBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | the application of a ConstraintDefinition to a specific ontology element with parameter values |

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `constraintRef` | 是 | `uri` | — | — | IRI reference to ConstraintDefinition |
| `targetElement` | 是 | `uri` | — | — | IRI of the element being constrained (ObjectTypeDefinition, AttributeUse, Relati |
| `parameters` | 否 | `dict` | — | — | parameter values for this constraint binding |
| `enforcementLevel` | 否 | `enum` | Mandatory/Advisory/Disabled | Mandatory | whether this constraint must be enforced |
| `enforcementContext` | 否 | `enum` | Write/Read/Query/Import/Export | — | when to enforce this constraint |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ChangeRecord

> **中文导读**：对本体元素一次变更的审计记录——含变更类型（增/改/弃/删/恢复）、是否破坏性、改前改后值、批准人；description 用 LocalizedTextDefinition 支持多语言，被 GovernanceMetadata.changeHistory 引用。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/ChangeRecord` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a record of a change to an ontology element for audit and version control |

**字段清单**（共 11 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `changeId` | 是 | `string` | — | — | unique identifier for this change |
| `timestamp` | 是 | `instant` | — | — | when this change was made |
| `author` | 是 | `string` | — | — | who made this change |
| `changeType` | 是 | `enum` | Addition/Modification/Deprecation/Deletion/Restoration | — | type of change |
| `affectedElement` | 是 | `uri` | — | — | IRI of the element that was changed |
| `description` | 是 | `LocalizedTextDefinition` | — | — | human-readable description of the change |
| `breakingChange` | 否 | `boolean` | — | false | whether this change breaks backward compatibility |
| `previousValue` | 否 | `any` | — | — | the value before the change (for Modification) |
| `newValue` | 否 | `any` | — | — | the value after the change (for Modification, Addition) |
| `approvedBy` | 否 | `string` | — | — | who approved this change |
| `relatedChanges` | 否 | `list[string]` | — | — | IDs of related changes |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### GovernanceMetadata

> **中文导读**：挂在任何元素上的"谁负责、谁批、为什么、变更历史"——含 ownerRef/approvedBy/status/rationale/changeHistory，changeHistory 指向 ChangeRecord IRI，是本体治理的标配。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/core/GovernanceMetadata` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | ownership, approval, and change tracking metadata for ontology elements |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `ownerRef` | 否 | `string` | — | — | team or role responsible for this element |
| `approvedBy` | 否 | `string` | — | — |  |
| `approvedAt` | 否 | `instant` | — | — |  |
| `status` | 否 | `enum` | draft/review/approved/deprecated | — |  |
| `rationale` | 否 | `string` | — | — | business justification |
| `changeHistory` | 否 | `list[uri]` | — | — | references to ChangeRecord IRIs |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### constraints

> **中文导读**：内建约束集合：该元类型下声明的预定义约束实例（如 ExactVersionReference、LogicalReference）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | ⚠️ 无（元类型本身未声明 IRI） |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | ⚠️ 无定义 |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

## Layer 2 · 跨域模式（CrossDomainPatterns）

**文件**：`ontology/meta/cross-domain-patterns.yaml`
**模块 IRI**：`https://axiolune.ai/ontology/meta/patterns`  ·  **版本**：0.6.0  ·  **前缀**：`ax-pattern`
**层说明**：Reusable patterns for identity, time, provenance, evidence, and lifecycle that apply across domain objects
**元类型总数**：8

---

### PatternDefinition

> **中文导读**：Layer 2 的核心元类型——可复用跨域语义模式的"语法母版"，把 Temporal/Provenance/Evidence 形式化为一等本体元素；每个具体模式（TemporalFact 等）是它的实例，投影为 owl:Class，通过 PatternBinding 绑到 ObjectType/AssociationType。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/PatternDefinition` |
| **OWL 投影** | kind: class  ·  note: Every concrete PatternDefinition IRI is an owl:Class; instance-level owlProjection describes additional axioms contribut |
| **定义（YAML 原文）** | a meta-classifier for reusable cross-domain semantic patterns that can be bound to ObjectTypes and AssociationTypes |

**字段清单**（共 17 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — | globally unique IRI for this pattern |
| `namespace` | 是 | `string` | — | — | module namespace prefix |
| `localName` | 是 | `string` | — | — | pattern name within namespace |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `version` | 是 | `string` | ^\d+\.\d+\.\d+$ | — |  |
| `appliesTo` | 是 | `list[enum]` | ObjectTypeDefinition/AssociationTypeDefinition/AttributeTypeDefinition/RelationTypeDefinition | — | which meta-types this pattern can be bound to |
| `injectedAttributes` | 是 | `list[AttributeUse]` | — | — | attributes that will be added to types using this pattern |
| `parameters` | 否 | `list[PatternParameter]` | — | — | parameterized configuration options |
| `dependencies` | 否 | `list[uri]` | — | — | other patterns that must also be bound |
| `conflicts` | 否 | `list[uri]` | — | — | patterns that cannot be bound simultaneously |
| `injectedRelations` | 否 | `list[RelationUse]` | — | — | relations that will be added to types using this pattern |
| `constraintsAdded` | 否 | `list[ConstraintBinding]` | — | — | validation rules enforced by this pattern |
| `owlProjection` | 否 | `PatternOWLProjection` | — | — | how this pattern projects to OWL ontology |
| `shaclShape` | 否 | `PatternSHACLShape` | — | — | SHACL shape for validating pattern conformance |
| `alignments` | 否 | `list[Alignment]` | — | — | mappings to external standards (FIBO, PROV-O, etc.) |
| `examples` | 否 | `list[PatternExample]` | — | — | example usages of this pattern |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PatternParameter

> **中文导读**：模式的配置参数（如 TemporalFact 的 timeGranularity），可声明默认值和允许值；属于 PatternDefinition.parameters，让同一个模式在不同类型上有不同精度。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/PatternParameter` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a configuration parameter for customizing pattern behavior |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `string` | — | — |  |
| `type` | 是 | `string` | — | — | parameter value type |
| `required` | 否 | `boolean` | — | false |  |
| `defaultValue` | 否 | `any` | — | — |  |
| `allowedValues` | 否 | `list[any]` | — | — |  |
| `description` | 否 | `string` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PatternOWLProjection

> **中文导读**：模式到 OWL 构造的映射规格——声明投影策略（mixin/restriction/unionOf/propertyChain）、附加类、属性限制；描述"模式绑定时贡献哪些 OWL 公理"，属于 PatternDefinition.owlProjection。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/PatternOWLProjection` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of how a pattern maps to OWL constructs |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `kind` | 否 | `enum` | mixin/restriction/unionOf/propertyChain | — | OWL projection strategy |
| `additionalClasses` | 否 | `list[uri]` | — | — | OWL classes to add to types using this pattern |
| `propertyRestrictions` | 否 | `list[OWLRestriction]` | — | — | OWL property restrictions |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### OWLRestriction

> **中文导读**：模式投影到绑定类型时发出的闭 OWL 限制——声明 onProperty、限制类型（someValuesFrom/allValuesFrom/hasValue/基数）、值；是 PatternOWLProjection.propertyRestrictions 的元素，把模式语义固化为可推理的 OWL 公理。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/OWLRestriction` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed OWL restriction emitted when a pattern is projected onto a bound domain type |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `onProperty` | 是 | `uri` | — | — |  |
| `restrictionKind` | 是 | `enum` | someValuesFrom/allValuesFrom/hasValue/minCardinality/maxCardinality/exactCardinality | — |  |
| `value` | 是 | `union[uri,nonNegativeSafeInteger]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PatternSHACLShape

> **中文导读**：模式贡献的 SHACL 形状——含 shapeIri、targetClass、propertyShapes，用于校验使用该模式的实例；属于 PatternDefinition.shaclShape，是模式"可机器校验"的一面。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/PatternSHACLShape` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | SHACL shape for validating instances that use this pattern |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `shapeIri` | 否 | `uri` | — | — | IRI of the SHACL shape |
| `targetClass` | 否 | `uri` | — | — | target class for this shape |
| `propertyShapes` | 否 | `list[SHACLPropertyShape]` | — | — | property-level constraints |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SHACLPropertyShape

> **中文导读**：跨域模式贡献的属性级 SHACL 投影——声明 path 及 minCount/maxCount/datatype/pattern 等约束；是 PatternSHACLShape.propertyShapes 的元素，把模式注入属性的基数与类型约束固化为可校验形状。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/SHACLPropertyShape` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed property-level SHACL projection contributed by one cross-domain pattern |

**字段清单**（共 9 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `path` | 是 | `uri` | — | — |  |
| `minCount` | 否 | `nonNegativeSafeInteger` | — | — |  |
| `maxCount` | 否 | `nonNegativeSafeInteger` | — | — |  |
| `datatype` | 否 | `uri` | — | — |  |
| `class` | 否 | `uri` | — | — |  |
| `nodeKind` | 否 | `uri` | — | — |  |
| `pattern` | 否 | `string` | — | — |  |
| `in` | 否 | `list[any]` | — | — |  |
| `hasValue` | 否 | `any` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PatternExample

> **中文导读**：模式使用方式的示例——描述、绑到哪个类型、参数值、注入了哪些属性；属于 PatternDefinition.examples，帮助理解模式如何落到具体类型上。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/patterns/PatternExample` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | an example of how this pattern is used |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `description` | 否 | `string` | — | — |  |
| `boundToType` | 否 | `uri` | — | — | ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `parameterValues` | 否 | `dict` | — | — | parameter values for this binding |
| `resultingAttributes` | 否 | `list[string]` | — | — | attributes added to the type |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### constraints

> **中文导读**：内建约束集合：该元类型下声明的预定义约束实例（如 ExactVersionReference、LogicalReference）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | ⚠️ 无（元类型本身未声明 IRI） |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | ⚠️ 无定义 |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

## Layer 3 · 行为元模型（PlatformBehavior）

**文件**：`ontology/meta/behavior-meta-model.yaml`
**模块 IRI**：`https://axiolune.ai/ontology/meta/behavior`  ·  **版本**：0.6.0  ·  **前缀**：`ax-behavior`
**层说明**：Meta-model for platform capabilities: queries, functions, actions, and policies
**元类型总数**：6

---

### CallableParameterDefinition

> **中文导读**：查询/函数/动作共用的参数定义结构——避免在三类可调用元类型里重复定义参数；带 semanticRole（Subject/Temporal/Idempotency 等）标注参数在操作中的语义角色，被 Query/Function/Action 的 parameters 复用。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/behavior/CallableParameterDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for parameters used by queries, functions, and actions |

> **注**：Replaces locally-scoped ParameterDefinition; used by QueryTypeDefinition, FunctionTypeDefinition, and ActionTypeDefinition

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `string` | — | — | parameter name |
| `type` | 是 | `string` | — | — | ValueType, ObjectTypeDefinition, or collection reference |
| `required` | 否 | `boolean` | — | true | whether this parameter must be provided |
| `defaultValue` | 否 | `any` | — | — | default value expression when not provided (MUST NOT use non-reproducible now()/ |
| `description` | 否 | `string` | — | — | human-readable parameter description |
| `constraints` | 否 | `list[ConstraintBinding]` | — | — | validation rules for this parameter |
| `semanticRole` | 否 | `enum` | Subject/Predicate/Object/Context/Temporal/Provenance/Idempotency | — | semantic role of this parameter in the operation |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### QueryTypeDefinition

> **中文导读**：只读查询操作——带类型化参数和返回值、无副作用；PIT 查询必须显式传 asOfKnowledge/asOfValid/asOfAvailable 三轴，禁止隐式 now()（ADR-012）；可声明实现（SPARQL/SQL）和授权策略。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/behavior/QueryTypeDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for read-only data access operations with typed parameters and return values |

**字段清单**（共 14 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `targetType` | 是 | `uri` | — | — | ObjectTypeDefinition or AssociationTypeDefinition this query operates on |
| `parameters` | 是 | `list[CallableParameterDefinition]` | — | — | typed input parameters |
| `returnType` | 是 | `string` | — | — | return value type (ValueType, ObjectTypeDefinition, AssociationTypeDefinition, o |
| `returnCardinality` | 否 | `enum` | single/optional/list | single | single=exactly one, optional=zero or one, list=zero or more |
| `implementation` | 否 | `` | — | — |  |
| `authorization` | 否 | `list[PolicyType]` | — | — | access control policies required to execute this query |
| `performance` | 否 | `` | — | — |  |
| `examples` | 否 | `list[QueryExample]` | — | — |  |
| `applicableToTypes` | 否 | `list[uri]` | — | — | ObjectTypeDefinition IRIs this query can operate on (replaces Layer 1 interfaces |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### FunctionTypeDefinition

> **中文导读**：无副作用的纯计算操作（如算 YTM、组合估值）——声明 purity（pure/observationallyPure/impure）、实现语言与测试套件；与 Query 的区别是它算"值"而非取"数"，常被组合进查询和动作。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/behavior/FunctionTypeDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for side-effect-free computational operations |

> **注**：Functions are deterministic, referentially transparent, and idempotent

**字段清单**（共 11 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `parameters` | 是 | `list[CallableParameterDefinition]` | — | — | typed input parameters |
| `returnType` | 是 | `string` | — | — | output type |
| `purity` | 否 | `enum` | pure/observationallyPure/impure | pure | pure: no side effects, deterministic
observationallyPure: may use memoization/ca |
| `implementation` | 否 | `` | — | — |  |
| `testSuite` | 否 | `list[FunctionTest]` | — | — |  |
| `applicableToTypes` | 否 | `list[uri]` | — | — | ObjectTypeDefinition IRIs this function can operate on (replaces Layer 1 interfa |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ActionTypeDefinition

> **中文导读**：有副作用的动作（如 SubmitOrder）——声明 effects/effectDomain、幂等性、补偿动作、审批、前后置条件、commandReceipt、风险分级；金融动作的幂等/补偿/审批被强制写进元模型；每次执行产生 ExecutionRecordDefinition 记录。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/behavior/ActionTypeDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for stateful operations that modify system state or interact with external systems |

> **注**：Actions require authorization, preconditions, audit trails, and compensation/rollback semantics

**字段清单**（共 24 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `effectDomain` | 是 | `enum` | internal/external/distributed | — | scope of action effects |
| `parameters` | 是 | `list[CallableParameterDefinition]` | — | — | typed input parameters |
| `effects` | 是 | `list[EffectSpecification]` | — | — | declared state changes or external interactions |
| `commandReceipt` | 是 | `CommandReceiptSchema` | — | — | structure of the execution receipt that must be returned |
| `irreversible` | 否 | `boolean` | — | false | true = this action cannot be rolled back once executed (e.g., order partially fi |
| `idempotencyKeyFieldRequired` | 否 | `boolean` | — | false | whether an idempotency key field must be provided |
| `idempotencyWindow` | 否 | `duration` | — | — | time window for idempotency key uniqueness enforcement |
| `unknownResultReconciliation` | 否 | `enum` | ManualReview/QueryExternal/AssumeSuccess/AssumeFailed/HoldAndAlert | — | strategy when action result is unknown (e.g., timeout) |
| `authorization` | 否 | `list[AuthorizationRequirement]` | — | — | required permissions, roles, or policies |
| `approval` | 否 | `ApprovalWorkflow` | — | — | approval workflow requirements |
| `preconditions` | 否 | `list[Precondition]` | — | — | conditions that must hold before execution |
| `postconditions` | 否 | `list[Postcondition]` | — | — | conditions guaranteed after successful execution |
| `idempotency` | 否 | `enum` | idempotent/conditionallyIdempotent/nonIdempotent | nonIdempotent | idempotent: safe to retry; duplicate calls have no additional effect
conditional |
| `idempotencyKeyField` | 否 | `string` | — | — | parameter name for idempotency key (required when conditionallyIdempotent and id |
| `compensatingActions` | 否 | `list[CompensatingActionRef]` | — | — | actions that can compensate for this action's effects (not rollback) |
| `auditRequirements` | 否 | `` | — | — |  |
| `riskAssessment` | 否 | `` | — | — |  |
| `implementation` | 否 | `` | — | — |  |
| `examples` | 否 | `list[ActionExample]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ExecutionRecordDefinition

> **中文导读**：动作执行的持久记录（ADR-008）——每次动作执行都留一条不可变记录，含 status（Pending/Running/Success/Failure/Unknown），Unknown 必须触发对账；是 append-only 账本，用于审计、恢复、外部对账。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/behavior/ExecutionRecordDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for durable records of action execution attempts |

> **注**：Every action execution creates an ExecutionRecord for safety and traceability

**字段清单**（共 15 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `executionId` | 是 | `uri` | — | — | globally unique identifier for this execution attempt |
| `actionType` | 是 | `uri` | — | — | IRI of ActionTypeDefinition being executed |
| `targetEntity` | 是 | `uri` | — | — | IRI of entity being acted upon |
| `parameters` | 是 | `map[string,string]` | — | — | serialized action parameters |
| `status` | 是 | `enum` | Pending/Running/Success/Failure/Unknown | — | execution lifecycle status |
| `startedAt` | 是 | `datetime` | — | — | when execution started |
| `completedAt` | 否 | `datetime` | — | — | when execution finished (success, failure, or deemed unknown) |
| `outcome` | 否 | `string` | — | — | success message or error details |
| `externalRequestId` | 否 | `string` | — | — | client-generated request ID sent to external system for reconciliation |
| `externalOrderId` | 否 | `string` | — | — | external system's ID (e.g., broker order ID) |
| `externalStatus` | 否 | `string` | — | — | status from external system |
| `retryCount` | 否 | `integer` | — | 0 | number of retry attempts |
| `lastReconciledAt` | 否 | `datetime` | — | — | last time reconciliation was attempted for Unknown status |
| `reconciledBy` | 否 | `string` | — | — | system or user that reconciled this execution |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PolicyType

> **中文导读**：授权/风险限额/合规/工作流策略——定义访问控制、风险限额、合规约束、审批工作流；enforcement.mode 可为 blocking（阻断）/auditing（记录）/advisory（提示），挂在 ActionType 执行管道上。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/behavior/PolicyType` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for authorization, compliance, and governance rules |

**字段清单**（共 13 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `policyType` | 是 | `enum` | authorization/riskLimit/compliance/workflow/dataGovernance | — |  |
| `scope` | 是 | `enum` | global/module/type/instance | — | where this policy applies |
| `applicability` | 否 | `` | — | — |  |
| `rules` | 否 | `list[PolicyRule]` | — | — | individual policy rules |
| `enforcement` | 否 | `` | — | — |  |
| `owner` | 否 | `string` | — | — | team or role responsible for this policy |
| `effectiveDate` | 否 | `instant` | — | — |  |
| `expirationDate` | 否 | `instant` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

## Layer 4 · 数据绑定元模型（DataBinding）

**文件**：`ontology/meta/data-binding-meta-model.yaml`
**模块 IRI**：`https://axiolune.ai/ontology/meta/data-binding`  ·  **版本**：0.6.0  ·  **前缀**：`ax-binding`
**层说明**：Meta-model for mapping physical data sources to ontology concepts (ADR-011, ADR-012 compliant)
**元类型总数**：68

---

### ArtifactRef

> **中文导读**：闭工件引用——指向一个绝对工件 IRI 或某构建根（sourceTree/buildEvidence/payload/adoptionEvidence）下的一条相对路径，是 Layer 4 全部证据锁定的基本引用单元。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ArtifactRef` |
| **OWL 投影** | kind: structuredValueClass  ·  classIri: https://axiolune.ai/ontology/meta/data-binding/structures/ArtifactRef |
| **定义（YAML 原文）** | closed reference to either an absolute artifact IRI or one path below an explicitly named build root |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SourceLocator

> **中文导读**：闭媒体感知选择器——在锁定的源工件内精确选定一段非空字节（wholeFile/textLineRange/pdfPageRange/jsonPointer 等），带 extractorProfile 与 selectionDigest，保证"证据来自哪几个字节"可复现。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/SourceLocator` |
| **OWL 投影** | kind: structuredValueClass  ·  classIri: https://axiolune.ai/ontology/meta/data-binding/structures/SourceLocator |
| **定义（YAML 原文）** | closed media-aware selector for one canonical non-empty byte selection inside a locked source artifact |

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `path` | 是 | `posixRelativePath` | — | — |  |
| `mediaType` | 是 | `ianaMediaType` | — | — |  |
| `extractorProfileRef` | 是 | `ArtifactRef` | — | — |  |
| `extractorProfileDigest` | 是 | `digest` | — | — |  |
| `selectionDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### sourceArtifactRef

> **中文导读**：源工件引用：指向锁定源工件的对象属性。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed artifact reference that identifies the immutable source artifact supporting a materialized claim |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### sourceArtifactDigest

> **中文导读**：源工件摘要：源工件的加密摘要，保证完整性与可复现。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | SHA-256 digest that authenticates the exact immutable source artifact supporting a materialized claim |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### sourceLocator

> **中文导读**：来源定位器属性：将绑定结构链接到 SourceLocator 的对象属性。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed media-aware source selector whose locked extraction identifies the exact supporting bytes |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SemanticValueDefinition

> **中文导读**：语义值定位器——描述一个可见的本体值（属性用法/参与者角色/关系用法/模式字段/派生），供身份组件或派生引用，是身份契约与派生的语义输入。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/SemanticValueDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed semantic locator for one visible ontology value used by an identity component or derivation |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IdentityComponentDefinition

> **中文导读**：身份组件——逻辑身份或版本身份的一个有序语义分量，含 semanticValue、termContract、normalizationRule，是构成 IRI 的砖块。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IdentityComponentDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one ordered semantic component of a target logical or version identity |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `asciiIdentifier` | — | — |  |
| `semanticValue` | 是 | `SemanticValueDefinition` | — | — |  |
| `termContractRef` | 是 | `uri` | — | — |  |
| `termContractDigest` | 是 | `digest` | — | — |  |
| `normalizationRuleRef` | 是 | `uri` | — | — |  |
| `normalizationRuleDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IdentityTermContractDefinition

> **中文导读**：身份术语契约——版本化的闭 RDF-term 契约（事实引用/受控 IRI/字面量），规定身份组件如何成帧为规范 RDF 项，保证身份可复现。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IdentityTermContractDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | versioned closed RDF-term contract used by identity components |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `termContract` | 是 | `IdentityTermContract` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IdentityNormalizationRuleDefinition

> **中文导读**：身份规范化规则——成帧前施加的确定性规范化（带算法版本、实现与测试向量），把输入 term 契约转成输出 term 契约。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IdentityNormalizationRuleDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | versioned deterministic normalization rule applied before identity-term framing |

**字段清单**（共 15 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `inputTermContractRef` | 是 | `uri` | — | — |  |
| `inputTermContractDigest` | 是 | `digest` | — | — |  |
| `outputTermContractRef` | 是 | `uri` | — | — |  |
| `outputTermContractDigest` | 是 | `digest` | — | — |  |
| `algorithmId` | 是 | `asciiIdentifier` | — | — |  |
| `algorithmVersion` | 是 | `semver` | — | — |  |
| `specificationRef` | 是 | `ArtifactRef` | — | — |  |
| `specificationDigest` | 是 | `digest` | — | — |  |
| `implementationRef` | 是 | `ArtifactRef` | — | — |  |
| `implementationDigest` | 是 | `digest` | — | — |  |
| `testVectorsRef` | 是 | `ArtifactRef` | — | — |  |
| `testVectorsDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IdentityDerivationDefinition

> **中文导读**：身份派生——从声明的语义输入确定性派生一个或多个命名身份输出，带表达式/实现/测试向量，是如何由语义算出 IRI 的闭规则。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IdentityDerivationDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | versioned deterministic derivation from declared semantic inputs to one or more named identity outputs |

**字段清单**（共 11 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `inputSemanticValues` | 是 | `list[SemanticValueDefinition]` | — | — |  |
| `outputs` | 是 | `list[IdentityDerivationOutput]` | — | — |  |
| `expressionRef` | 是 | `ArtifactRef` | — | — |  |
| `expressionDigest` | 是 | `digest` | — | — |  |
| `implementationRef` | 是 | `ArtifactRef` | — | — |  |
| `implementationDigest` | 是 | `digest` | — | — |  |
| `testVectorsRef` | 是 | `ArtifactRef` | — | — |  |
| `testVectorsDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ControlledIriSetDefinition

> **中文导读**：受控 IRI 集合——版本化的非空规范 IRI 集合（codeList 或 reviewedIriInventory），用于受控身份组件，成员带证据锁。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ControlledIriSetDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | versioned non-empty canonical set of IRIs authorized for controlled identity components |

**字段清单**（共 9 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `setKind` | 是 | `enum` | codeList/reviewedIriInventory | — |  |
| `sourceDefinitionRef` | 是 | `uri` | — | — |  |
| `sourceEvidenceRef` | 是 | `uri` | — | — |  |
| `sourceEvidenceDigest` | 是 | `digest` | — | — |  |
| `sourceLocator` | 是 | `SourceLocator` | — | — |  |
| `members` | 是 | `list[uri]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### TargetIdentityContractDefinition

> **中文导读**：目标身份契约——为某物化目标类型决定稳定逻辑身份与不可变版本身份的静态契约，含 logicalComponents 与 versionComponents，是 IdentitySpec 的依据。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/TargetIdentityContractDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | static contract that determines stable logical and immutable version identity for one materialized target type |

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `targetType` | 是 | `union[ObjectTypeDefinition,AssociationTypeDefinition]` | — | — |  |
| `identityBaseIri` | 是 | `uri` | — | — |  |
| `logicalComponents` | 是 | `list[IdentityComponentDefinition]` | — | — |  |
| `versionComponents` | 是 | `list[IdentityComponentDefinition]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ReferenceIdentityBinding

> **中文导读**：引用身份绑定——通过已接受的身份契约解析被引用目标，声明 referenceMode（logical 或 version）与 keyBindings，是引用走哪条身份的规格。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ReferenceIdentityBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | mapping binding that resolves a referenced target through its accepted identity contract |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `bindingType` | 是 | `const` | — | — |  |
| `targetMappingRef` | 是 | `uri` | — | — |  |
| `referenceMode` | 是 | `enum` | logical/version | — |  |
| `keyBindings` | 是 | `map[string,ValueBinding]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### FactIdentity

> **中文导读**：事实身份——一个版本化物化对象/关联的稳定逻辑身份锚，FactVersion 通过 versionOf 指向它，是同一个事实跨版本的锚点。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/FactIdentity` |
| **OWL 投影** | kind: class  ·  classIri: https://axiolune.ai/ontology/meta/data-binding/FactIdentity |
| **定义（YAML 原文）** | generic stable logical identity anchor for one versioned materialized object or association |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### FactVersion

> **中文导读**：事实版本——一个不可变物化事实版本的标记类，是实际的数据载体，通过 supersedes 形成版本链。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/FactVersion` |
| **OWL 投影** | kind: class  ·  classIri: https://axiolune.ai/ontology/meta/data-binding/FactVersion |
| **定义（YAML 原文）** | generic marker class for one immutable materialized fact version |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### FactClosureAssertion

> **中文导读**：事实闭包断言——不修改旧版本即可关闭其知识期/可用期的不可变证据，支持超时不改写只追加闭包的语义。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/FactClosureAssertion` |
| **OWL 投影** | kind: class  ·  classIri: https://axiolune.ai/ontology/meta/data-binding/FactClosureAssertion |
| **定义（YAML 原文）** | immutable evidence that closes one knowledge-time or availability-time interval without mutating the older fact version |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### versionOf

> **中文导读**：版本归属：将 FactVersion 链接到其 FactIdentity 的对象属性（函数式）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | ⚠️ 无（元类型本身未声明 IRI） |
| **OWL 投影** | kind: objectProperty |
| **定义（YAML 原文）** | functional relation from one immutable FactVersion to its stable FactIdentity anchor |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### supersedes

> **中文导读**：取代：声明某版本取代前一版本的对象属性。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | ⚠️ 无（元类型本身未声明 IRI） |
| **OWL 投影** | kind: objectProperty |
| **定义（YAML 原文）** | relation from one immutable FactVersion to its direct previous version with the same FactIdentity anchor |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### generatingContextRef

> **中文导读**：生成上下文引用：生成该产物的物化运行 IRI（v0.6.0 由规范映射产出，非适配器注入）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/generatingContextRef` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | reference to the immutable MaterializationRun or MaterializationBatchRun that generated this fact version |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### inputContextRef

> **中文导读**：输入上下文引用：该物化所依据的上游运行 IRI。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRef` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | reference to the immutable resolved input-context record used to generate this fact version |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### inputContextRecordDigest

> **中文导读**：输入上下文记录摘要：上游运行记录的摘要，锁定输入。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRecordDigest` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | SHA-256 digest of the immutable resolved input-context record used to generate this fact version |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### pitRequestRef

> **中文导读**：PIT 请求引用：触发该物化的 PIT 校验请求 IRI。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/pitRequestRef` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | reference to the exact immutable PITValidationRequest authorizing point-in-time consumption |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### pitRequestRecordDigest

> **中文导读**：PIT 请求记录摘要：PIT 请求记录的摘要。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/attributes/pitRequestRecordDigest` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | SHA-256 digest of the exact immutable PITValidationRequest authorizing point-in-time consumption |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### DataSource

> **中文导读**：数据源——外部或内部数据提供方，含连接与认证元数据（凭证走 credentialsRef 不入库），是数据来自哪里的定义。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/DataSource` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for external or internal data providers with connection and authentication metadata |

**字段清单**（共 15 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `sourceType` | 是 | `enum` | relationalDatabase/documentDatabase/timeSeriesDatabase/objectStorage/fileSystem/restAPI/graphQL/grpc/streamingKafka/streamingKinesis/dataWarehouse | — |  |
| `connection` | 是 | `ConnectionSpec` | — | — | connection parameters (sensitive fields should reference secrets manager) |
| `vendor` | 否 | `string` | — | — |  |
| `version` | 否 | `string` | — | — |  |
| `updateFrequency` | 否 | `enum` | realtime/intraday/daily/weekly/monthly/onDemand/static | — |  |
| `latency` | 否 | `` | — | — |  |
| `reliability` | 否 | `` | — | — |  |
| `costModel` | 否 | `string` | — | — | pricing structure |
| `dataGovernance` | 否 | `` | — | — |  |
| `provenance` | 否 | `Layer2:ProvenancedFact` | — | — | source metadata binding |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### DatasetDefinition

> **中文导读**：数据集定义——数据源内的逻辑数据集合（表/集合/主题/文件），含物理标识、schema、分区、更新模式、时态覆盖，是物理数据的逻辑视图。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/DatasetDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for logical collections of data within a data source |

**字段清单**（共 13 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `namespace` | 是 | `string` | — | — |  |
| `localName` | 是 | `string` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `dataSource` | 是 | `uri` | — | — | reference to DataSource IRI |
| `physicalIdentifier` | 是 | `string` | — | — | actual table name, file path, topic, or collection name |
| `schema` | 否 | `DatasetSchema` | — | — | physical schema definition |
| `partitioning` | 否 | `PartitioningSpec` | — | — | how dataset is partitioned (for performance and temporal queries) |
| `updatePattern` | 否 | `enum` | append/upsert/snapshot/cdc/eventSourcing | — | how data is updated |
| `temporalCoverage` | 否 | `` | — | — |  |
| `volumetrics` | 否 | `` | — | — |  |
| `qualityMetrics` | 否 | `` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### FieldDefinition

> **中文导读**：字段定义——物理数据集 schema 里的字段，含原生类型、可空、主外键；ADR-011 规定字段不含语义注解，语义全部由 SemanticMappingDefinition 表达。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/FieldDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for physical field definitions in dataset schemas |

**字段清单**（共 8 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `string` | — | — | field name in the physical schema |
| `dataType` | 是 | `string` | — | — | native data type in source system |
| `nullable` | 否 | `boolean` | — | true |  |
| `primaryKey` | 否 | `boolean` | — | false |  |
| `foreignKey` | 否 | `ForeignKeyReference` | — | — |  |
| `defaultValue` | 否 | `any` | — | — |  |
| `constraints` | 否 | `list[uri]` | — | — | references to ConstraintDefinition IRIs |
| `description` | 否 | `string` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IndexDefinition

> **中文导读**：索引定义——物理数据集的索引结构（BTree/Hash/GIN/BRIN 等），含字段、唯一性、部分索引谓词，用于查询性能优化。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IndexDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for physical index structures in datasets |

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `string` | — | — | index name |
| `fields` | 是 | `list[string]` | — | — | field names included in this index |
| `unique` | 否 | `boolean` | — | false | whether this is a unique index |
| `indexType` | 否 | `enum` | BTree/Hash/GiST/GIN/BRIN | BTree | physical index structure type |
| `partial` | 否 | `string` | — | — | partial index predicate expression |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SourceBinding

> **中文导读**：来源绑定——语义映射的物理数据源与行集操作（多表 join/filter/分组聚合），在 slot 映射之前施加，是从哪些表如何取行的规格。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/SourceBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of physical data sources and row-set operations for semantic mapping according to genus-differentia form |

**字段清单**（共 2 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `datasets` | 是 | `list[DatasetReference]` | — | — | physical datasets to read from |
| `rowSet` | 否 | `RowSetSpec` | — | — | row-level operations applied before mapping to slots |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### RowSetSpec

> **中文导读**：行集规格——在 slot 映射前施加的行级操作（filter/join/grouping），表达字段级映射无法表达的多表与聚合逻辑。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/RowSetSpec` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | row-level operations applied to source datasets before slot mapping according to genus-differentia form |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `filters` | 否 | `list[FilterExpression]` | — | — | row filtering conditions |
| `joins` | 否 | `list[JoinExpression]` | — | — | multi-table join specifications |
| `grouping` | 否 | `GroupingSpec` | — | — | aggregation specification for derived entities |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IdentitySpec

> **中文导读**：身份规格——把物理值映射到某 TargetIdentityContractDefinition 的有序组件，防止不同映射各自发明不兼容的逻辑键/版本键/IRI 模板，强制走契约。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IdentitySpec` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | contract-bound specification that maps physical values to the ordered components of one accepted TargetIdentityContractDefinition |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `contractRef` | 是 | `uri` | — | — | TargetIdentityContractDefinition IRI registered for the mapping target |
| `logicalKeyBindings` | 是 | `map[string,ValueBinding]` | — | — | exact one-to-one bindings for all ordered logical components |
| `versionKeyBindings` | 是 | `map[string,ValueBinding]` | — | — | exact one-to-one bindings for all ordered version components |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ValueBinding

> **中文导读**：值绑定——槽取值的计算规格，区分 directField/transformation/literal/runtimeContext/referenceIdentity，是这个槽怎么填值的闭联合类型。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ValueBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of value computation for slot population according to genus-differentia form |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SlotMapping

> **中文导读**：槽映射——把源数据映射到本体槽（属性/参与者角色/关系/模式字段），v0.5.0 从 fieldMappings 改名以支持非属性槽，含 target 与 value。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/SlotMapping` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of target slot population according to genus-differentia form |

**字段清单**（共 2 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `target` | 是 | `TargetSlot` | — | — | slot to populate |
| `value` | 是 | `ValueBinding` | — | — | value computation specification |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### TransformationDefinition

> **中文导读**：变换定义——版本化的可复用变换逻辑，带类型化输入/输出、版本、实现摘要、测试用例，保证变换可复现、可审计。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/TransformationDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | versioned reusable transformation logic for data mapping according to genus-differentia form |

**字段清单**（共 9 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `definition` | 是 | `string` | — | — | clear definition of transformation purpose and behavior |
| `kind` | 是 | `enum` | LookupTransformation/MappingTransformation/ExpressionTransformation/ScriptTransformation | — | type of transformation |
| `inputs` | 是 | `map[string, TypeReference]` | — | — | named input parameters with explicit types |
| `outputs` | 是 | `TypeReference` | — | — | output type specification |
| `version` | 是 | `string` | — | — | semantic version (MAJOR.MINOR.PATCH) |
| `implementationDigest` | 是 | `string` | — | — | SHA-256 digest of implementation artifact for reproducibility |
| `testCases` | 是 | `list[TransformationTestCase]` | — | — | test cases demonstrating correct behavior |
| `implementation` | 否 | `TransformationImplementation` | — | — | implementation details specific to transformation kind |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### TargetSlot

> **中文导读**：目标槽——映射目标的闭联合类型（attribute/participantRole/relation/patternField），让 SemanticMappingDefinition 不仅能映射属性还能映射角色/关系/模式字段。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/TargetSlot` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a union type representing different kinds of mapping targets (attributes, participant roles, relations, or pattern fields) |

> **注**：Replaces simple targetAttribute: IRI with a discriminated union to support all mapping target types

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### TimeAxisBinding

> **中文导读**：时间轴绑定——一个时间轴（from/to 区间）的绑定规格，含 closePolicy（如何关闭旧版本的 knowledgeTo），是 TemporalMappingSpec 的三轴之一。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/TimeAxisBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | binding specification for one temporal axis (from/to intervals) according to genus-differentia form |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `from` | 是 | `ValueBinding` | — | — | start of time interval (inclusive) |
| `to` | 否 | `ValueBinding` | — | — | end of time interval (exclusive); null means unbounded |
| `closePolicy` | 否 | `enum` | closePreviousVersion/explicitOnly | closePreviousVersion | how to set knowledgeTo for superseded versions (knowledgeTime axis only) |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ProvenanceBinding

> **中文导读**：溯源绑定——把物理字段映射到 Layer 2 来源模式字段（sourceSystem/acquisitionTime/responsibleAgent/confidence），捕获来源元数据。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ProvenanceBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of data provenance metadata capture according to genus-differentia form |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `sourceSystem` | 否 | `ValueBinding` | — | — | identifier of originating system |
| `acquisitionTime` | 否 | `ValueBinding` | — | — | when data was acquired from source |
| `responsibleAgent` | 否 | `ValueBinding` | — | — | agent responsible for data acquisition |
| `confidence` | 否 | `ValueBinding` | — | — | confidence score or quality metric |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### TemporalMappingSpec

> **中文导读**：时序映射规格——ADR-012 三轴时间模型（validTime/knowledgeTime/availabilityTime）的显式源绑定，三轴必须齐全，防前视偏差。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/TemporalMappingSpec` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | specification of three-axis temporal semantics mapping according to genus-differentia form and ADR-012 |

> **注**：This spec is the three-axis (TemporalFact) temporal mapping. All three axes
(validTime, knowledgeTime, availabilityTime) are REQUIRED so a TemporalFact
mapping cannot silently omit an axis (ADR-012). 

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `patternRef` | 是 | `uri` | — | — | temporal pattern IRI (e.g., ax-pattern:TemporalFact) |
| `validTime` | 是 | `TimeAxisBinding` | — | — | when fact holds true in reality (business time) — required for three-axis comple |
| `knowledgeTime` | 是 | `TimeAxisBinding` | — | — | when platform knows/retracts this version (transaction time) — required; SHOULD  |
| `availabilityTime` | 是 | `TimeAxisBinding` | — | — | when consumers can use this data (regulatory/access control time) — required; pr |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### SemanticMappingDefinition

> **中文导读**：语义映射定义——ADR-011 单一真相源，唯一的语义映射结构，含 SourceBinding/IdentitySpec/SlotMapping/TemporalMappingSpec/ProvenanceBinding，是物理到本体的权威映射。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/SemanticMappingDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | canonical specification of mapping between physical data and ontology concepts according to genus-differentia form |

> **注**：Replaces all field-level, dataset-level, and inline mappings with unified structure

**字段清单**（共 13 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `source` | 是 | `SourceBinding` | — | — | physical data sources with row-set operations |
| `targetType` | 是 | `uri` | — | — | ObjectTypeDefinition or AssociationTypeDefinition IRI |
| `mappingType` | 是 | `enum` | directTable/joinedTables/aggregation/transformation/view/denormalized | — |  |
| `identity` | 是 | `IdentitySpec` | — | — | contract-bound logical and version identity; mandatory for every concrete materi |
| `slotMappings` | 否 | `list[SlotMapping]` | — | — | mappings to attributes, participant roles, relations, and pattern fields |
| `temporal` | 否 | `TemporalMappingSpec` | — | — | three-axis temporal semantics per ADR-012 |
| `provenance` | 否 | `ProvenanceBinding` | — | — | provenance metadata capture specification |
| `validationRules` | 否 | `list[ValidationRule]` | — | — | data quality checks applied during materialization |
| `priority` | 否 | `integer` | — | 0 | when multiple mappings provide same attribute, higher priority wins |
| `effectiveDate` | 否 | `instant` | — | — | when this mapping became active |
| `expirationDate` | 否 | `instant` | — | — | when this mapping should no longer be used |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MaterializationBatchDefinition

> **中文导读**：物化批次定义——多个模块作用域 MaterializationPlanDefinition 在一个源快照与时间上下文上的原子组合，要求事务一致性。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MaterializationBatchDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | static atomic composition of multiple module-scoped MaterializationPlanDefinitions over one source snapshot and one temporal context |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — |  |
| `plans` | 是 | `list[uri]` | — | — |  |
| `targetDataset` | 是 | `uri` | — | — |  |
| `consistencyRequirement` | 是 | `const` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MaterializationRun

> **中文导读**：物化运行——一个完成或失败的模块作用域物化的不可变独立控制记录，含 assertionTime/referenceTime 等显式时间，为可复现查询提供 referenceTime 上下文。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MaterializationRun` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable standalone control record for one completed or failed module-scoped materialization |

**字段清单**（共 27 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `recordType` | 是 | `const` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `runId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `planRef` | 是 | `uri` | — | — |  |
| `planSourceDigest` | 是 | `digest` | — | — |  |
| `sourceSchemaClosureDigest` | 是 | `digest` | — | — |  |
| `sourceSnapshotRootDigest` | 是 | `digest` | — | — |  |
| `inputDatasets` | 是 | `list[InputDatasetSnapshot]` | — | — |  |
| `mappingClosure` | 是 | `list[MappingClosureEntry]` | — | — |  |
| `mappingClosureDigest` | 是 | `digest` | — | — |  |
| `ontologyClosureRef` | 是 | `ArtifactRef` | — | — |  |
| `ontologyClosureDigest` | 是 | `digest` | — | — |  |
| `referenceLockRef` | 是 | `ArtifactRef` | — | — |  |
| `referenceLockDigest` | 是 | `digest` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `compilerDigest` | 是 | `digest` | — | — |  |
| `validatorDigest` | 是 | `digest` | — | — |  |
| `executorDigest` | 是 | `digest` | — | — |  |
| `outputRdfCanonicalization` | 是 | `const` | — | — |  |
| `assertionTime` | 是 | `instant` | — | — |  |
| `referenceTime` | 是 | `instant` | — | — |  |
| `result` | 是 | `MaterializationResult` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MaterializationPlanDefinition

> **中文导读**：物化计划定义——声明式规格，定义物化什么、数据如何映射到本体（仅静态配置），运行时状态移到 MaterializationRun，编排移到外部。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MaterializationPlanDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | declarative specification of ontology instance materialization from physical data sources according to genus-differentia form |

> **注**：Runtime state moved to MaterializationRun per ADR-011; orchestration moved to external layer

**字段清单**（共 13 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `definition` | 是 | `string` | — | — | purpose and scope of this materialization plan |
| `sourceDatasets` | 是 | `list[uri]` | — | — | DatasetDefinition IRIs to be materialized |
| `targetOntologyModule` | 是 | `uri` | — | — | OntologyModuleDefinition IRI where instances will be created |
| `semanticMappings` | 是 | `list[uri]` | — | — | SemanticMappingDefinition IRIs that define how data maps to ontology |
| `materializationMode` | 是 | `enum` | Incremental/Full/CDC/EventSourcing | — | how materialization handles updates |
| `consistencyRequirement` | 否 | `enum` | Eventual/Snapshot/Transactional | Eventual | consistency level required for materialized instances |
| `validationRules` | 否 | `list[ConstraintBinding]` | — | — | validation rules applied during materialization |
| `conflictResolution` | 否 | `ConflictResolutionStrategy` | — | — | how to handle conflicts when multiple sources provide same data |
| `incrementalKey` | 否 | `string` | — | — | field name for incremental updates (e.g., updated_at timestamp) |
| `targetGraphUri` | 否 | `uri` | — | — | named graph URI where RDF triples will be stored |
| `owner` | 否 | `string` | — | — | team or role responsible for this plan |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### DataLineage

> **中文导读**：数据血缘——跟踪数据从源经变换到本体实例的流向，含上下游数据集与变换链，用于影响分析与调试。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/DataLineage` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for tracking data flow and transformation chains |

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `sourceDatasets` | 是 | `list[uri]` | — | — | upstream DatasetDefinition IRIs |
| `targetDatasets` | 是 | `list[uri]` | — | — | downstream DatasetDefinition IRIs or ontology instances |
| `transformations` | 是 | `list[uri]` | — | — | Transformation IRIs applied |
| `lineageGraph` | 否 | `string` | — | — | serialized graph representation (e.g., DOT, JSON-LD) |
| `updateFrequency` | 否 | `duration` | — | — |  |
| `lastRun` | 否 | `` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### PITValidationRequest

> **中文导读**：PIT 校验请求——绑定物化证据、RDF 字节、显式三轴枢轴与锁定校验器的不可变独立请求，授权点-in-time 消费，绑定 queryTime 给 AvailabilityBeforeUse。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/PITValidationRequest` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable standalone request that binds exact materialization evidence, RDF bytes, explicit three-axis pivots, and a locked PIT validator |

**字段清单**（共 16 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `requestId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `recordType` | 是 | `const` | — | — |  |
| `targetRdfCanonicalization` | 是 | `const` | — | — |  |
| `asOfValid` | 是 | `instant` | — | — |  |
| `asOfKnowledge` | 是 | `instant` | — | — |  |
| `asOfAvailable` | 是 | `instant` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `validatorRef` | 是 | `ArtifactRef` | — | — |  |
| `validatorDigest` | 是 | `digest` | — | — |  |
| `materializationContext` | 是 | `MaterializationContext` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MaterializationBatchRun

> **中文导读**：物化批次运行——一个完成或失败的原子物化批次的不可变独立控制记录，含成员运行清单与输出数据集摘要。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MaterializationBatchRun` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable standalone control record for one completed or failed atomic materialization batch |

**字段清单**（共 24 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `recordType` | 是 | `const` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `runId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `batchRef` | 是 | `uri` | — | — |  |
| `batchSourceDigest` | 是 | `digest` | — | — |  |
| `sourceSnapshotRootDigest` | 是 | `digest` | — | — |  |
| `ontologyClosureRef` | 是 | `ArtifactRef` | — | — |  |
| `ontologyClosureDigest` | 是 | `digest` | — | — |  |
| `referenceLockRef` | 是 | `ArtifactRef` | — | — |  |
| `referenceLockDigest` | 是 | `digest` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `compilerDigest` | 是 | `digest` | — | — |  |
| `validatorDigest` | 是 | `digest` | — | — |  |
| `executorDigest` | 是 | `digest` | — | — |  |
| `outputRdfCanonicalization` | 是 | `const` | — | — |  |
| `assertionTime` | 是 | `instant` | — | — |  |
| `referenceTime` | 是 | `instant` | — | — |  |
| `targetDataset` | 是 | `uri` | — | — |  |
| `result` | 是 | `MaterializationBatchResult` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ValidationReport

> **中文导读**：校验报告——一次实际执行的校验门的不可变机器证据信封，含 profile/gateId/criterionRefs/counts/result，RDFC-1.0 规范化加 digest 锁定。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ValidationReport` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable common machine-evidence envelope for one actually executed validation gate |

**字段清单**（共 38 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `reportId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `recordType` | 是 | `const` | — | — |  |
| `profileRef` | 是 | `uri` | — | — |  |
| `gateId` | 是 | `asciiIdentifier` | — | — |  |
| `reportKind` | 是 | `asciiIdentifier` | — | — |  |
| `criterionRefs` | 是 | `list[uri]` | — | — |  |
| `subjectRef` | 是 | `ArtifactRef` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `inputs` | 是 | `list[ArtifactBinding]` | — | — |  |
| `toolId` | 是 | `asciiIdentifier` | — | — |  |
| `capabilityId` | 是 | `asciiIdentifier` | — | — |  |
| `capabilityRef` | 是 | `ArtifactRef` | — | — |  |
| `capabilityDigest` | 是 | `digest` | — | — |  |
| `entrypointRef` | 是 | `ArtifactRef` | — | — |  |
| `entrypointDigest` | 是 | `digest` | — | — |  |
| `discoveryContractRef` | 是 | `ArtifactRef` | — | — |  |
| `discoveryContractDigest` | 是 | `digest` | — | — |  |
| `subjectInventoryRef` | 是 | `ArtifactRef` | — | — |  |
| `subjectInventoryDigest` | 是 | `digest` | — | — |  |
| `kindEvidence` | 是 | `KindEvidenceBinding` | — | — |  |
| `counts` | 是 | `GateCounts` | — | — |  |
| `result` | 是 | `GateResult` | — | — |  |
| `requestRef` | 否 | `uri` | — | — |  |
| `requestRecordDigest` | 否 | `digest` | — | — |  |
| `contextRef` | 否 | `uri` | — | — |  |
| `contextRecordDigest` | 否 | `digest` | — | — |  |
| `recomputedTargetDigest` | 否 | `digest` | — | — |  |
| `asOfValid` | 否 | `instant` | — | — |  |
| `asOfKnowledge` | 否 | `instant` | — | — |  |
| `asOfAvailable` | 否 | `instant` | — | — |  |
| `memberRunRecordDigests` | 否 | `list[digest]` | — | — |  |
| `outputDatasetDigest` | 否 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### FailureReport

> **中文导读**：失败报告——一个失败执行阶段的不可变独立证据记录，含失败阶段、输入、错误清单。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/FailureReport` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable standalone evidence record for a failed execution stage |

**字段清单**（共 13 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `reportId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `recordType` | 是 | `const` | — | — |  |
| `subjectRef` | 是 | `ArtifactRef` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `failureStage` | 是 | `asciiIdentifier` | — | — |  |
| `inputs` | 是 | `list[ArtifactBinding]` | — | — |  |
| `errors` | 是 | `list[ExecutionError]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ReplayReport

> **中文导读**：重放报告——原始与重放语义产物的不可变比对，验证确定性可复现，含原始/重放摘要与 identical/mismatch 判定。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ReplayReport` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable standalone comparison of original and replayed semantic artifacts |

**字段清单**（共 19 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `reportId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `recordType` | 是 | `const` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `originalContextRef` | 是 | `uri` | — | — |  |
| `originalContextRecordDigest` | 是 | `digest` | — | — |  |
| `originalTargetRef` | 是 | `ArtifactRef` | — | — |  |
| `originalTargetDigest` | 是 | `digest` | — | — |  |
| `replaySourceSnapshotRootDigest` | 是 | `digest` | — | — |  |
| `replayMappingClosureDigest` | 是 | `digest` | — | — |  |
| `replayOntologyClosureDigest` | 是 | `digest` | — | — |  |
| `replayReferenceLockDigest` | 是 | `digest` | — | — |  |
| `replayToolLockDigest` | 是 | `digest` | — | — |  |
| `result` | 是 | `ReplayResult` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### EvidenceLedger

> **中文导读**：证据账本——索引除自身外所有已定稿独立控制记录的不可变根，含 slotSelections 与 entries，是整套证据体系的目录。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/EvidenceLedger` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | detached immutable root that indexes every finalized standalone control record except itself |

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaVersion` | 是 | `const` | — | — |  |
| `slotId` | 是 | `recordId` | — | — |  |
| `ledgerId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `plannedInputDigest` | 是 | `digest` | — | — |  |
| `resolvedInputDigest` | 是 | `digest` | — | — |  |
| `iri` | 是 | `uri` | — | — |  |
| `build` | 是 | `BuildEvidenceBinding` | — | — |  |
| `slotSelections` | 是 | `list[EvidenceSlotSelection]` | — | — |  |
| `entries` | 是 | `list[EvidenceLedgerEntry]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### BuildEvidenceBinding

> **中文导读**：构建证据绑定——每个控制记录共享的精确构建身份与不可变控制面绑定（buildId/sourceTreeDigest/toolLock 等）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/BuildEvidenceBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | exact build identity and immutable control-plan bindings shared by every control record |

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `buildId` | 是 | `digest` | — | — |  |
| `sourceTreeDigest` | 是 | `digest` | — | — |  |
| `toolLockRef` | 是 | `ArtifactRef` | — | — |  |
| `toolLockDigest` | 是 | `digest` | — | — |  |
| `buildInputsRef` | 是 | `ArtifactRef` | — | — |  |
| `buildInputsDigest` | 是 | `digest` | — | — |  |
| `controlRecordSchemaManifestRef` | 是 | `ArtifactRef` | — | — |  |
| `controlRecordSchemaManifestDigest` | 是 | `digest` | — | — |  |
| `controlRecordPlanRef` | 是 | `ArtifactRef` | — | — |  |
| `controlRecordPlanDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ArtifactBinding

> **中文导读**：工件绑定——命名的不可变工件输入，带 mediaType 与 digest，是校验报告等的输入清单元素。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ArtifactBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | named immutable artifact input with explicit media type and digest |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `asciiIdentifier` | — | — |  |
| `artifactRef` | 是 | `ArtifactRef` | — | — |  |
| `mediaType` | 是 | `ianaMediaType` | — | — |  |
| `artifactDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MappingClosureEntry

> **中文导读**：映射闭包条目——物化运行内一个语义映射及其完整变换闭包，带映射摘要与变换闭包摘要。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MappingClosureEntry` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one semantic mapping and its complete transformation closure inside a materialization run |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `mappingRef` | 是 | `uri` | — | — |  |
| `mappingSourceDigest` | 是 | `digest` | — | — |  |
| `transformationClosureRef` | 是 | `ArtifactRef` | — | — |  |
| `transformationClosureDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MaterializationResult

> **中文导读**：物化结果——一个不可变 MaterializationRun 的闭最终结果（completed 或 failed），编排状态不算证据。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MaterializationResult` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed final outcome of one immutable MaterializationRun; orchestration states are not evidence |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### CompletedBatchMember

> **中文导读**：已完成批次成员——原子物化批次中一个完成的计划/运行/图成员，带运行摘要与输出图摘要。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/CompletedBatchMember` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one completed plan/run/graph member of an atomic materialization batch |

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `planRef` | 是 | `uri` | — | — |  |
| `runRef` | 是 | `uri` | — | — |  |
| `runRecordDigest` | 是 | `digest` | — | — |  |
| `outputGraph` | 是 | `uri` | — | — |  |
| `outputGraphDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### AttemptedBatchMember

> **中文导读**：已尝试批次成员——失败物化批次中记录的一个已尝试计划成员，runRef 与 runRecordDigest 要么都有要么都无。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/AttemptedBatchMember` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one attempted plan member recorded by a failed materialization batch |

**字段清单**（共 3 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `planRef` | 是 | `uri` | — | — |  |
| `runRef` | 否 | `uri` | — | — |  |
| `runRecordDigest` | 否 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### MaterializationContext

> **中文导读**：物化上下文——到一个完成物化图或完成批数据集的闭 PIT 绑定，区分 materializationRun 与 materializationBatchRun 两种。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/MaterializationContext` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed PIT binding to either one completed materialization graph or one completed batch dataset |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### KindEvidenceBinding

> **中文导读**：Kind 证据绑定——门禁种类特定的严格 schema 与机器结果工件，含 schema 与 artifact 摘要。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/KindEvidenceBinding` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | gate-kind-specific strict schema and machine result artifact |

**字段清单**（共 4 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `schemaRef` | 是 | `ArtifactRef` | — | — |  |
| `schemaDigest` | 是 | `digest` | — | — |  |
| `artifactRef` | 是 | `ArtifactRef` | — | — |  |
| `artifactDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### GateCounts

> **中文导读**：门禁计数——在完整门禁主体清单与结果上重算的非负计数（discovered/executed/passed/failed/skipped/pending/warnings）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/GateCounts` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | recomputed non-negative counts over the complete gate subject inventory and result |

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `discovered` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `executed` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `passed` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `failed` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `skipped` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `pending` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `warnings` | 是 | `nonNegativeSafeInteger` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### GateCheck

> **中文导读**：门禁检查——对一个独立发现的语义主体实际执行的一次能力检查，带输入/输出/证据摘要与 passed/failed 状态。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/GateCheck` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one actually executed capability check for one independently discovered semantic subject |

**字段清单**（共 16 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `checkId` | 是 | `asciiIdentifier` | — | — |  |
| `subjectId` | 是 | `digest` | — | — |  |
| `subjectRef` | 是 | `ArtifactRef` | — | — |  |
| `subjectDigest` | 是 | `digest` | — | — |  |
| `toolId` | 是 | `asciiIdentifier` | — | — |  |
| `capabilityId` | 是 | `asciiIdentifier` | — | — |  |
| `capabilityRef` | 是 | `ArtifactRef` | — | — |  |
| `capabilityDigest` | 是 | `digest` | — | — |  |
| `entrypointRef` | 是 | `ArtifactRef` | — | — |  |
| `entrypointDigest` | 是 | `digest` | — | — |  |
| `inputDigests` | 是 | `list[digest]` | — | — |  |
| `outputDigests` | 是 | `list[digest]` | — | — |  |
| `evidenceRef` | 是 | `ArtifactRef` | — | — |  |
| `evidenceDigest` | 是 | `digest` | — | — |  |
| `status` | 是 | `enum` | passed/failed | — |  |
| `diagnosticCode` | 否 | `asciiIdentifier` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### GateViolation

> **中文导读**：门禁违规——失败门禁检查产生的一条可确定性排序的语义违规，带 severity/message/path/constraintRef 等。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/GateViolation` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one deterministically sortable semantic violation produced by a failed gate check |

**字段清单**（共 10 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `checkId` | 是 | `asciiIdentifier` | — | — |  |
| `subjectId` | 是 | `digest` | — | — |  |
| `diagnosticCode` | 是 | `asciiIdentifier` | — | — |  |
| `subjectRef` | 是 | `ArtifactRef` | — | — |  |
| `severity` | 是 | `enum` | error/warning/info | — |  |
| `message` | 是 | `nfcString` | — | — |  |
| `path` | 否 | `union[posixRelativePath,uri]` | — | — |  |
| `constraintRef` | 否 | `uri` | — | — |  |
| `focusNode` | 否 | `canonicalNTriplesTerm` | — | — |  |
| `component` | 否 | `union[uri,asciiIdentifier]` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### GateResult

> **中文导读**：门禁结果——一次机器执行的校验门的闭最终结果（passed/failed/engineFailure），含检查与违规清单。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/GateResult` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed final result of one machine-executed validation gate |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ReplayComparison

> **中文导读**：重放比对——一次命名的原始对重放工件摘要比对，含 originalDigest/replayDigest/equal。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ReplayComparison` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | one named original-versus-replay artifact digest comparison |

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `name` | 是 | `asciiIdentifier` | — | — |  |
| `artifactRef` | 是 | `ArtifactRef` | — | — |  |
| `originalDigest` | 是 | `digest` | — | — |  |
| `replayDigest` | 是 | `digest` | — | — |  |
| `equal` | 是 | `boolean` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ReplayResult

> **中文导读**：重放结果——确定性重放比对的闭最终结果（identical/mismatch/engineFailure），含比对清单。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ReplayResult` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | closed final result of deterministic replay comparison |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### EvidenceSlotSelection

> **中文导读**：证据槽选择——为证据账本一个槽位选中的那个活跃控制记录替代，含 recordType/recordId/recordIri。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/EvidenceSlotSelection` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | the one active control-record alternative selected for an evidence-ledger slot |

**字段清单**（共 5 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `slotId` | 是 | `recordId` | — | — |  |
| `recordType` | 是 | `enum` | materializationRun/materializationBatchRun/pitRequest/validationReport/failureReport/replayReport | — |  |
| `recordId` | 是 | `recordId` | — | — |  |
| `attemptId` | 是 | `recordId` | — | — |  |
| `recordIri` | 是 | `uri` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### EvidenceLedgerEntry

> **中文导读**：证据账本条目——一条已定稿独立控制记录的内容寻址索引项，含 mediaType/canonicalization/byteLength/recordDigest。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/EvidenceLedgerEntry` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | content-addressed index entry for one finalized standalone control record |

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `slotId` | 是 | `recordId` | — | — |  |
| `recordIri` | 是 | `uri` | — | — |  |
| `recordType` | 是 | `enum` | materializationRun/materializationBatchRun/pitRequest/validationReport/failureReport/replayReport | — |  |
| `mediaType` | 是 | `const` | — | — |  |
| `canonicalization` | 是 | `const` | — | — |  |
| `byteLength` | 是 | `nonNegativeSafeInteger` | — | — |  |
| `recordDigest` | 是 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### ExecutionError

> **中文导读**：执行错误——嵌入失败控制记录的可确定性排序执行失败诊断，含 code/stage/message。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/ExecutionError` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | deterministically sortable execution failure diagnostic embedded in a failed control record |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `code` | 是 | `asciiIdentifier` | — | — |  |
| `stage` | 是 | `asciiIdentifier` | — | — |  |
| `message` | 是 | `nfcString` | — | — |  |
| `sourcePath` | 否 | `posixRelativePath` | — | — |  |
| `constraintRef` | 否 | `uri` | — | — |  |
| `causeDigest` | 否 | `digest` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### InputDatasetSnapshot

> **中文导读**：输入数据集快照——物化输入数据集的不可变嵌入绑定，含 snapshotRef/schemaDigest/snapshotTime，用于可复现。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/InputDatasetSnapshot` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | immutable embedded binding of one input dataset to exact snapshot bytes |

**字段清单**（共 6 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `dataset` | 是 | `uri` | — | — |  |
| `snapshotRef` | 是 | `ArtifactRef` | — | — |  |
| `artifactDigest` | 是 | `digest` | — | — |  |
| `schemaDigest` | 是 | `digest` | — | — |  |
| `snapshotTime` | 是 | `instant` | — | — |  |
| `rowCount` | 否 | `nonNegativeSafeInteger` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### IngestionPipelineDefinition

> **中文导读**：摄取管线定义——v0.3.0 起已弃用，混合了声明式映射与运行时编排违反 Layer 4 边界；改用 MaterializationPlanDefinition 加外部编排工具。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | `https://axiolune.ai/ontology/meta/data-binding/IngestionPipelineDefinition` |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | a meta-classifier for ETL/ELT workflows that materialize ontology instances from data sources |

**字段清单**（共 7 个）：

| 字段名 | 必填 | 类型 | 约束/枚举 | 默认值 | 说明 |
|---|---|---|---|---|---|
| `iri` | 是 | `uri` | — | — |  |
| `label` | 是 | `string` | — | — |  |
| `stages` | 是 | `list[PipelineStage]` | — | — | ordered stages in the pipeline |
| `schedule` | 是 | `ScheduleSpec` | — | — | when and how often to run |
| `errorHandling` | 否 | `` | — | — |  |
| `monitoring` | 否 | `MonitoringSpec` | — | — |  |
| `owner` | 否 | `string` | — | — |  |

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

### Examples

> **中文导读**：示例：该元类型下声明的使用示例集合（结构辅助键，非独立元类型）。
>
> *导读为辅助中文审查的解释性文字，非权威定义；权威定义以 YAML 英文原文为准（见下表）。*

| 属性 | 值 |
|---|---|
| **IRI** | ⚠️ 无（元类型本身未声明 IRI） |
| **OWL 投影** | ⚠️ 未声明 |
| **定义（YAML 原文）** | ⚠️ 无定义 |

**字段清单**（共 0 个）：

（无字段声明）

**核查**：[ ] IRI  ·  [ ] 定义  ·  [ ] cnNote  ·  [ ] OWL 投影  ·  [ ] 字段完整性  ·  [ ] 与相邻元类型区分度

---

## 附录：预定义属性与模式实例

以下不属元类型定义，但作为核查参考列出（来自 YAML 源）：

### Layer 1 预定义属性（`pattern:` 命名空间）

这些属性在 `core-meta-model.yaml` 中以扁平键声明，投影为 `owl:DatatypeProperty`，供 Layer 2 模式注入。

详见 `ontology/meta/core-meta-model.yaml` 第 546–980 行区段（validFrom / validTo / knowledgeFrom / knowledgeTo / observedAt / availableFrom / availableTo / publishedAt / receivedAt / source / sourceVersion / confidence / revision / derivedFrom / recordedAt / evidenceType / evidenceRef / evidenceDigest / evidenceTimestamp / evidenceDescription / lifecycleState / lifecycleVersion / createdAt / updatedAt / deprecatedAt / semanticVersion / versionedIri / priorVersion / incompatibleWith / sourceEvidenceRef）。

### Layer 2 模式实例

7 个具体模式（均投影为 `owl:Class`）：PublicationTiming、TemporalFact、TemporalObservation、ProvenancedFact、Evidence、Lifecycle、Versioning。详见 `cross-domain-patterns.yaml` 的 `patterns:` 列表。

### Layer 2 预定义约束（9 个）

PublishBeforeReceive、ValidIntervalConsistency、KnowledgeIntervalConsistency、NoFutureKnowledge、ObservationBeforeRecording、ConfidenceRange、DigestFormat、SemanticVersionFormat、AvailabilityBeforeUse、AvailabilityIntervalConsistency。详见 `cross-domain-patterns.yaml` 的 `constraints:` 区段。

