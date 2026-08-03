'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  collectActiveReferenceEvidence,
} = require('./lib/active-reference-evidence.cjs');
const {
  findUnusedDecisions,
  loadSemanticReviewDecisions,
  resolveSemanticReviewDecision,
} = require('./lib/semantic-reference-review-decisions.cjs');
const {
  loadProjectReferenceSemanticEvidence,
} = require('./lib/project-reference-semantic-evidence.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE_ROOT = path.join(ROOT, 'reference', 'project-reference');
const OUTPUT_ROOT = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'project-reference',
);
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const FRAGMENT_PATH = path.join(OUTPUT_ROOT, 'project-reference-coverage.fragment.json');
const PUBLIC_SYMBOL_MANIFEST_PATH = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'public-symbol-manifest.json',
);
const SEMANTIC_REVIEW_DECISIONS_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'semantic-review-decisions.json',
);
const PROJECT_SEMANTIC_EVIDENCE_PATH = path.join(
  OUTPUT_ROOT,
  'project-reference-semantic-evidence.json',
);
const CHECK_ONLY = process.argv.includes('--check');
const BUNDLE_TAG = Buffer.from('axiolune-reference-bundle-v1\0', 'utf8');
const REVIEWER_REF = 'urn:moonweave:reviewer:codex:project-reference-audit-v1';
const RECORD_PRODUCER_REF = 'tool:axiolune-project-reference-inventory/v1';
const RFC_REF = 'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md#523-reference-contract';
const MODULE_REFS = [
  'ontology/domain/finance/foundation/module.yaml',
  'ontology/domain/finance/instruments/module.yaml',
  'ontology/domain/finance/market-data/module.yaml',
  'ontology/domain/finance/market-rules/module.yaml',
  'ontology/domain/finance/market-structure/module.yaml',
  'ontology/domain/finance/orders-execution/module.yaml',
  'ontology/domain/finance/portfolio-positions/module.yaml',
  'ontology/domain/finance/post-trade-operations/module.yaml',
  'ontology/domain/finance/risk/module.yaml',
  'ontology/domain/finance/strategy-research/module.yaml',
];

const TEXT_MEDIA_BY_EXTENSION = new Map(Object.entries({
  '.bash': 'text/x-shellscript',
  '.bat': 'text/plain',
  '.capnp': 'text/plain',
  '.cfg': 'text/plain',
  '.config': 'text/plain',
  '.coveragerc': 'text/plain',
  '.cs': 'text/x-csharp',
  '.csproj': 'application/xml',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.csx': 'text/x-csharp',
  '.dockerfile': 'text/plain',
  '.example': 'text/plain',
  '.gitattributes': 'text/plain',
  '.gitignore': 'text/plain',
  '.h': 'text/x-c',
  '.html': 'text/html',
  '.in': 'text/plain',
  '.ini': 'text/plain',
  '.ipynb': 'application/json',
  '.j2': 'text/plain',
  '.java': 'text/x-java',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.lock': 'text/plain',
  '.map': 'application/json',
  '.md': 'text/markdown',
  '.mjs': 'text/javascript',
  '.nojekyll': 'text/plain',
  '.po': 'text/plain',
  '.pot': 'text/plain',
  '.properties': 'text/plain',
  '.ps1': 'text/plain',
  '.pxd': 'text/x-python',
  '.py': 'text/x-python',
  '.pyi': 'text/x-python',
  '.pylintrc': 'text/plain',
  '.pyx': 'text/x-python',
  '.rst': 'text/x-rst',
  '.rs': 'text/x-rust',
  '.sbe': 'application/xml',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.ts': 'text/typescript',
  '.txt': 'text/plain',
  '.typed': 'text/plain',
  '.vue': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}));

const BINARY_MEDIA_BY_EXTENSION = new Map(Object.entries({
  '.7z': 'application/x-7z-compressed',
  '.bz2': 'application/x-bzip2',
  '.dll': 'application/octet-stream',
  '.feather': 'application/vnd.apache.arrow.file',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.ico': 'image/vnd.microsoft.icon',
  '.jar': 'application/java-archive',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mo': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.npy': 'application/octet-stream',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.parquet': 'application/vnd.apache.parquet',
  '.pdf': 'application/pdf',
  '.pickle': 'application/octet-stream',
  '.pkl': 'application/octet-stream',
  '.png': 'image/png',
  '.pth': 'application/octet-stream',
  '.pyc': 'application/x-python-bytecode',
  '.so': 'application/octet-stream',
  '.webp': 'image/webp',
  '.whl': 'application/zip',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.zst': 'application/zstd',
}));

const SEMANTIC_RULES = [
  ['PIT', [
    /\bpoint[-_ ]in[-_ ]time\b/giu,
    /\bpit(?:d|ataset|provider|query)?\b/giu,
    /\blook[-_ ]?ahead\b/giu,
    /\bas[-_ ]?of\b/giu,
    /\bpublication[-_ ]?(?:date|time)\b/giu,
    /\brevision[-_ ]?(?:chain|time|date)\b/giu,
    /(?:未来函数|前视偏差|时间点数据|发布日期|修订链)/gu,
  ]],
  ['identity', [
    /\b(?:client|venue|exchange|instrument|order|trade|position|account)[-_ ]?id\b/giu,
    /\b(?:identifier|identity|ticker|symbol|isin|cusip|sedol|lei|mic)\b/giu,
    /(?:标的代码|证券代码|合约代码|订单编号|委托编号|成交编号|交易所代码)/gu,
  ]],
  ['instrument', [
    /\b(?:instrument|security|equity|stock|bond|future|futures|swap|fund|commodity|forex|crypto|asset[-_ ]?class)\b/giu,
    /\b(?:option[-_ ]?(?:chain|contract|instrument|market|position|price|symbol|type)|options[-_ ]?(?:data|market|trading))\b/giu,
    /(?:股票|期货|期权|基金|债券|证券|金融合约|交易品种)/gu,
  ]],
  ['market', [
    /\b(?:market[-_ ]?data|quote|bid|ask|tick|bar|candle|ohlcv|order[-_ ]?book|trade[-_ ]?tick|last[-_ ]?price|exchange|venue)\b/giu,
    /(?:行情|盘口|买一|卖一|成交价|K线|分时|报价)/gu,
  ]],
  ['marketRules', [
    /\b(?:price[-_ ]?limit|limit[-_ ]?(?:up|down)|tick[-_ ]?size|lot[-_ ]?size|trading[-_ ]?(?:calendar|session|hours)|circuit[-_ ]?breaker)\b/giu,
    /\b(?:close[-_ ]?today|closetoday|t\+1|stock[-_ ]?t1|short[-_ ]?sell|settlement[-_ ]?cycle)\b/giu,
    /(?:涨跌停|涨停|跌停|最小变动价位|交易时段|交易日历|平今|平昨)/gu,
  ]],
  ['order', [
    /\b(?:order|execution|fill|time[-_ ]?in[-_ ]?force|stop[-_ ]?limit|market[-_ ]?if[-_ ]?touched|pending[-_ ]?cancel|pending[-_ ]?update)\b/giu,
    /(?:委托|订单|成交|撤单|报单|撮合)/gu,
  ]],
  ['portfolio', [
    /\b(?:portfolio|position|holding|account|cash[-_ ]?balance|cost[-_ ]?basis|mark[-_ ]?to[-_ ]?market|valuation|pnl|profit[-_ ]?and[-_ ]?loss)\b/giu,
    /(?:持仓|仓位|账户|资金|盈亏|成本价|市值)/gu,
  ]],
  ['posttrade', [
    /\b(?:post[-_ ]?trade|settlement|clearing|custody|allocation|confirmation|reconciliation|corporate[-_ ]?action|dividend|trade[-_ ]?break)\b/giu,
    /(?:结算|清算|交割|对账|公司行动|分红|配股)/gu,
  ]],
  ['provenance', [
    /\b(?:provenance|lineage|source[-_ ]?data|data[-_ ]?source|dataset[-_ ]?version|model[-_ ]?version|audit[-_ ]?trail)\b/giu,
    /(?:数据来源|数据血缘|审计轨迹)/gu,
  ]],
  ['risk', [
    /\b(?:risk|value[-_ ]?at[-_ ]?risk|cvar|expected[-_ ]?shortfall|drawdown|exposure|leverage|margin|concentration|volatility|greeks|limit[-_ ]?breach)\b/giu,
    /(?:风险|保证金|敞口|杠杆|回撤|波动率)/gu,
  ]],
  ['strategy', [
    /\b(?:strategy|signal|factor|alpha|backtest|optimizer|optimization|performance[-_ ]?metric|sharpe|sortino|research)\b/giu,
    /(?:策略|信号|因子|回测|优化)/gu,
  ]],
  ['temporal', [
    /\b(?:event[-_ ]?time|knowledge[-_ ]?time|valid[-_ ]?(?:from|to|time)|available[-_ ]?(?:from|to|time)|timestamp|datetime|time[-_ ]?series)\b/giu,
    /(?:时间戳|生效时间|可用时间|知识时间|事件时间)/gu,
  ]],
];

const FORCED_USED_TAGS = new Map(Object.entries({
  'reference/project-reference/Lean/Common/Orders/OrderEvent.cs': ['identity', 'order', 'temporal'],
  'reference/project-reference/Lean/Common/Orders/OrderTypes.cs': ['order'],
  'reference/project-reference/nautilus_trader/crates/model/src/enums.rs': [
    'identity', 'instrument', 'market', 'marketRules', 'order', 'portfolio',
  ],
  'reference/project-reference/nautilus_trader/crates/model/src/events/order/any.rs': [
    'identity', 'order', 'provenance', 'temporal',
  ],
  'reference/project-reference/qlib/docs/advanced/PIT.rst': ['PIT', 'provenance', 'temporal'],
  'reference/project-reference/qlib/qlib/data/data.py': ['PIT', 'market', 'provenance', 'temporal'],
  'reference/project-reference/qlib/qlib/utils/__init__.py': ['PIT', 'provenance', 'temporal'],
  'reference/project-reference/rqalpha/rqalpha/mod/rqalpha_mod_sys_accounts/__init__.py': [
    'marketRules', 'order', 'portfolio',
  ],
  'reference/project-reference/rqalpha/rqalpha/portfolio/position.py': [
    'identity', 'marketRules', 'order', 'portfolio',
  ],
  'reference/project-reference/rqalpha/rqalpha/utils/price_limits.py': ['market', 'marketRules'],
  'reference/project-reference/vnpy/vnpy/trader/constant.py': [
    'instrument', 'market', 'marketRules', 'order', 'portfolio',
  ],
  'reference/project-reference/vnpy/vnpy/trader/converter.py': [
    'identity', 'marketRules', 'order', 'portfolio',
  ],
}));

const SEMANTIC_MAPPINGS = new Map(Object.entries({
  'reference/project-reference/Lean/Common/Orders/OrderEvent.cs': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleEvent',
      rationale: 'OrderEvent binds order/event identifiers, UTC event time, status, direction, fill quantity/price/currency, and fee; it only partially overlaps the active OrderLifecycleEvent contract and does not supply Axiolune knowledge/availability axes, immutable stream identity, or the full provenance contract.',
      sourceSymbol: 'QuantConnect.Orders.OrderEvent',
    },
  ],
  'reference/project-reference/Lean/Common/Orders/OrderTypes.cs': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderType',
      rationale: 'Market, Limit, StopMarket, StopLimit, and LimitIfTouched overlap, while Lean adds market-on-open/close, exercise, combo, and trailing types and lacks MarketIfTouched; the value sets are not exact.',
      sourceSymbol: 'QuantConnect.Orders.OrderType',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderSide',
      rationale: 'Buy and Sell align, but Lean OrderDirection adds Hold as a sentinel; Axiolune OrderSide is the two-member semantic direction set.',
      sourceSymbol: 'QuantConnect.Orders.OrderDirection',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState',
      rationale: 'Submitted, PartiallyFilled, Filled, Canceled, CancelPending, and UpdateSubmitted overlap lifecycle concepts, but Lean New/None/Invalid and Axiolune accepted/rejected/expired/triggered semantics do not form an exact set.',
      sourceSymbol: 'QuantConnect.Orders.OrderStatus',
    },
  ],
  'reference/project-reference/nautilus_trader/crates/model/src/enums.rs': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
      rationale: 'Nautilus InstrumentClass classifies implementation instrument variants such as Bond, Future, Option, Swap, spot, spreads, forwards, CFD, warrant, sports betting, and binary option. It is useful implementation evidence for the active FinancialInstrument abstraction, but Axiolune does not adopt this implementation enum as a normative or exact controlled set.',
      sourceSymbol: 'nautilus_trader::model::enums::InstrumentClass',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderSide',
      rationale: 'Buy and Sell align, but Nautilus includes NoOrderSide sentinel; sentinel-bearing implementation enums are not exact ontology code lists.',
      sourceSymbol: 'nautilus_trader::model::enums::OrderSide',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState',
      rationale: 'The implementation supplies PendingUpdate/PendingCancel and a rich event lifecycle, but Initialized/Denied/Emulated/Released/Voided and Axiolune mappings require an explicit external-status normalization; direct value-set identity is not proven.',
      sourceSymbol: 'nautilus_trader::model::enums::OrderStatus',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderType',
      rationale: 'Market, Limit, StopLimit, MarketIfTouched, and LimitIfTouched overlap, but StopMarket naming and additional market-to-limit/trailing types make the sets non-exact.',
      sourceSymbol: 'nautilus_trader::model::enums::OrderType',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/portfolio-positions/positionQuantity',
      rationale: 'Nautilus PositionSide distinguishes Flat, Long, and Short plus a NoPositionSide sentinel. Axiolune represents direction through the sign and zero value of positionQuantity rather than a PositionSide code list, so the enum is only partial derivation evidence and is not value-set identity.',
      sourceSymbol: 'nautilus_trader::model::enums::PositionSide',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/market-data/PriceKind',
      rationale: 'Mid and Last overlap PriceKind; Bid/Ask are quote-side prices and Mark is absent from the current target set, while target OHLC/Settlement/VWAP/TWAP members are absent here.',
      sourceSymbol: 'nautilus_trader::model::enums::PriceType',
    },
    {
      assessment: 'exact',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/TimeInForce',
      rationale: 'After case normalization, both sets contain exactly GTC, IOC, FOK, GTD, DAY, AtTheOpen, and AtTheClose; numeric ordinals are implementation details and are not adopted.',
      sourceSymbol: 'nautilus_trader::model::enums::TimeInForce',
    },
  ],
  'reference/project-reference/nautilus_trader/crates/model/src/events/order/any.rs': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleEvent',
      rationale: 'The tagged event union and common trader/client/venue/account/instrument/strategy identifiers support the active OrderLifecycleEvent identity and lifecycle design, but the file does not establish Axiolune immutable stream identity, three-axis time, or complete evidence provenance.',
      sourceSymbol: 'nautilus_trader::model::events::order::OrderEventAny',
    },
  ],
  'reference/project-reference/qlib/docs/advanced/PIT.rst': [
    {
      assessment: 'conflict',
      m2Target: 'https://axiolune.ai/ontology/finance/strategy-research/FactorObservation',
      rationale: 'Qlib PIT models publication date, financial period, value, and a storage _next pointer for fundamental revisions. This informs factor revision handling but is not equivalent to Axiolune valid/knowledge/availability axes; exact PIT alignment is pending.',
      sourceSymbol: 'Qlib PIT file record(date, period, value, _next)',
    },
  ],
  'reference/project-reference/qlib/qlib/data/data.py': [
    {
      assessment: 'conflict',
      m2Target: 'https://axiolune.ai/ontology/finance/strategy-research/FactorObservation',
      rationale: 'PITProvider enforces no future query and exposes revision records, but its cur_time/period/_next model does not encode the Axiolune three-axis temporal contract; use is implementation evidence only.',
      sourceSymbol: 'qlib.data.data.PITProvider / LocalPITProvider',
    },
  ],
  'reference/project-reference/qlib/qlib/utils/__init__.py': [
    {
      assessment: 'conflict',
      m2Target: 'https://axiolune.ai/ontology/finance/strategy-research/FactorObservation',
      rationale: 'The date/period/value/_next linked-record traversal is a storage-level revision chain, not an exact valid/knowledge/availability-time semantic mapping.',
      sourceSymbol: 'qlib.utils.get_period_list / PIT binary record traversal',
    },
  ],
  'reference/project-reference/rqalpha/rqalpha/mod/rqalpha_mod_sys_accounts/__init__.py': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/market-rules/RuleApplicability',
      rationale: 'stock_t1 is an implementation configuration switch demonstrating a T+1 trading restriction, but it lacks target instrument/venue scope, effective interval, provenance, and rule identity.',
      sourceSymbol: 'rqalpha_mod_sys_accounts.stock_t1',
    },
  ],
  'reference/project-reference/rqalpha/rqalpha/portfolio/position.py': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/portfolio-positions/PositionLot',
      rationale: 'order_book_id, direction, quantity, average price, prior close, and old/today quantities provide position and lot-like implementation semantics, but stable ontology identity and three-axis snapshot provenance are absent.',
      sourceSymbol: 'rqalpha.portfolio.position.Position',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/market-rules/RuleApplicability',
      rationale: 'CLOSE_TODAY and today_closable behavior supports scoped close-today rules, but the runtime calculation is not an explicit versioned rule applicability fact.',
      sourceSymbol: 'rqalpha.portfolio.position.Position.today_closable',
    },
  ],
  'reference/project-reference/rqalpha/rqalpha/utils/price_limits.py': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/market-rules/RuleApplicability',
      rationale: 'Limit-up/down checks use side, board limit, tick size, and tolerance, supporting price-limit behavior; effective dates, venue/instrument-class scope, rule identity, and provenance are not encoded.',
      sourceSymbol: 'rqalpha.utils.price_limits.reaches_limit',
    },
  ],
  'reference/project-reference/vnpy/vnpy/trader/constant.py': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/market-rules/RuleType',
      rationale: 'Offset.CLOSETODAY directly supports the CloseTodayOffset rule concept, but the broader Offset enum is an order instruction set rather than an exact RuleType code list.',
      sourceSymbol: 'vnpy.trader.constant.Offset',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState',
      rationale: 'Submitting, not traded, part traded, all traded, cancelled, and rejected overlap order lifecycle concepts, but names and state granularity require an explicit mapping.',
      sourceSymbol: 'vnpy.trader.constant.Status',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/orders-execution/OrderType',
      rationale: 'LIMIT, MARKET, STOP, and FOK overlap target concepts; FAK, RFQ, and ETF plus target touched/stop-limit members prevent exact equivalence.',
      sourceSymbol: 'vnpy.trader.constant.OrderType',
    },
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
      rationale: 'Product enumerates Equity, Futures, Option, Bond, Fund, Swap, and implementation-specific products. It supports the active FinancialInstrument abstraction only as implementation classification evidence and is not an exact Axiolune controlled set.',
      sourceSymbol: 'vnpy.trader.constant.Product',
    },
    {
      assessment: 'pending',
      m2Target: 'https://axiolune.ai/ontology/finance/market-structure/registryMICValue',
      rationale: 'Exchange includes exchange acronyms and smart-router labels. It may inform the registryMICValue relation, but this file does not prove that every member resolves to an accepted ISO 10383 MICRegistryEntry, so exact identity alignment remains pending.',
      sourceSymbol: 'vnpy.trader.constant.Exchange',
    },
  ],
  'reference/project-reference/vnpy/vnpy/trader/converter.py': [
    {
      assessment: 'partial',
      m2Target: 'https://axiolune.ai/ontology/finance/market-rules/RuleApplicability',
      rationale: 'SHFE/INE-specific splitting of CLOSE, CLOSETODAY, and CLOSEYESTERDAY demonstrates venue-scoped close-today behavior, but the runtime branch has no explicit versioned effective interval or provenance record.',
      sourceSymbol: 'vnpy.trader.converter.PositionHolding.convert_order_request_shfe',
    },
  ],
}));

const PROJECT_ASSESSMENTS = new Map(Object.entries({
  finrl: {
    primaryTags: ['market', 'portfolio', 'risk', 'strategy'],
    projectScopeAssessment: 'Reinforcement-learning environments, data processors, and portfolio/trading examples expose strategy, observation, action, reward, holdings, and transaction-cost implementation concepts.',
    selectionDecision: 'No file is selected by the current lock; decoded files remain pendingSemanticReview until digest-bound decisions are independently authored.',
  },
  'finrl-trading': {
    primaryTags: ['market', 'portfolio', 'risk', 'strategy', 'temporal'],
    projectScopeAssessment: 'Live/research trading orchestration, data fetching/storage, backtesting, and ML stock-selection workflows carry strategy and portfolio implementation semantics.',
    selectionDecision: 'No file is selected by the current lock; the project is implementation context only.',
  },
  freqtrade: {
    primaryTags: ['identity', 'market', 'order', 'risk', 'strategy'],
    projectScopeAssessment: 'Crypto exchange adapters, order lifecycle, wallets, risk protections, strategy callbacks, and backtesting are semantically rich but exchange- and engine-specific.',
    selectionDecision: 'No file is selected by the current lock; no implementation symbol is promoted to normative authority.',
  },
  lean: {
    primaryTags: ['identity', 'instrument', 'market', 'order', 'portfolio'],
    projectScopeAssessment: 'The broad algorithmic-trading engine covers securities, subscriptions, orders, fills, holdings, brokerage, and event processing; candidate mappings require exact file-level review before use.',
    selectionDecision: 'No Lean file is selected by a current machine-readable authority candidate or required evidence profile; prior mapping candidates remain reviewedRejected.',
  },
  lumibot: {
    primaryTags: ['instrument', 'market', 'order', 'portfolio', 'strategy'],
    projectScopeAssessment: 'Broker abstractions, assets, orders, positions, backtesting data sources, and strategy lifecycle supply implementation semantics across several M2 modules.',
    selectionDecision: 'No file is selected by the current lock; binary resources receive metadata-only inspection.',
  },
  'nautilus-trader': {
    primaryTags: ['identity', 'instrument', 'market', 'order', 'portfolio', 'temporal'],
    projectScopeAssessment: 'The typed event-driven trading model exposes identifiers, instruments, market data, order events/statuses, accounts, positions, and event timestamps.',
    selectionDecision: 'Only enums.rs and events/order/any.rs are usedImplementation; controlled-set and event mappings are explicitly exact/partial rather than assumed.',
  },
  pyfolio: {
    primaryTags: ['portfolio', 'risk', 'strategy', 'temporal'],
    projectScopeAssessment: 'Portfolio tear sheets, return/risk statistics, positions, transactions, performance attribution, and capacity analysis are analytical implementation context.',
    selectionDecision: 'No file is selected by the current lock; malformed legacy notebooks are explicitly reviewedRejected after lexical review.',
  },
  qlib: {
    primaryTags: ['PIT', 'provenance', 'strategy', 'temporal'],
    projectScopeAssessment: 'Factor research, datasets, backtesting, and the publication-date/period/value/_next PIT revision chain inform research and temporal semantics.',
    selectionDecision: 'The three PIT mapping candidates are reviewedRejected: their temporal divergence remains recorded, but no current downstream authority candidate selects them.',
  },
  quantstats: {
    primaryTags: ['portfolio', 'risk', 'strategy', 'temporal'],
    projectScopeAssessment: 'Performance reports and risk/return statistics cover drawdown, volatility, Sharpe/Sortino, and time-series portfolio analytics.',
    selectionDecision: 'No file is selected by the current lock; analytical formulas are not treated as ontology authority.',
  },
  'rd-agent': {
    primaryTags: ['provenance', 'strategy', 'temporal'],
    projectScopeAssessment: 'Research-agent workflows, experiment configuration, Qlib scenarios, factor/model generation, and benchmark artifacts provide orchestration and lineage context.',
    selectionDecision: 'No file is selected by the current lock; generated prompts and agent behaviors are not semantic authorities.',
  },
  rqalpha: {
    primaryTags: ['identity', 'marketRules', 'order', 'portfolio'],
    projectScopeAssessment: 'China-market account rules, T+1 switches, price-limit behavior, position quantities, close-today handling, and order-book identifiers provide scoped implementation evidence.',
    selectionDecision: 'The three RuleApplicability/PositionLot mapping candidates are reviewedRejected because no current downstream authority candidate selects them.',
  },
  ta4j: {
    primaryTags: ['market', 'risk', 'strategy', 'temporal'],
    projectScopeAssessment: 'Bar series, indicators, rules, criteria, positions, and backtesting form a technical-analysis and strategy implementation library.',
    selectionDecision: 'No file is selected by the current lock; indicator/rule APIs remain reviewed context.',
  },
  vectorbt: {
    primaryTags: ['market', 'order', 'portfolio', 'risk', 'strategy', 'temporal'],
    projectScopeAssessment: 'Vectorized signals, portfolio simulation, orders, records, drawdowns, returns, and parameterized backtesting provide research implementation semantics.',
    selectionDecision: 'No file is selected by the current lock; notebooks and interactive assets are not promoted to ontology evidence.',
  },
  vnpy: {
    primaryTags: ['identity', 'instrument', 'marketRules', 'order', 'portfolio'],
    projectScopeAssessment: 'Trading constants and the SHFE/INE offset converter expose product/exchange enums, order lifecycle, and close-today/close-yesterday venue behavior.',
    selectionDecision: 'constant.py and converter.py remain reviewedRejected mapping candidates; no current downstream authority candidate selects them and exact ISO MIC/value-set identity is not proven.',
  },
}));

const REVIEW_FILE_KEYS = [
  'artifactDigest',
  'byteLength',
  'contentKind',
  'disposition',
  'inspection',
  'matchedTerms',
  'mediaType',
  'path',
  'rationale',
  'reviewMethod',
  'reviewerRef',
  'semanticMappings',
  'semanticTags',
];
const COVERAGE_FILE_KEYS = [
  'artifactDigest',
  'disposition',
  'mediaType',
  'path',
  'rationale',
  'reviewMethod',
  'reviewRecordDigest',
  'reviewRecordRef',
  'reviewerRef',
];
const REVIEW_ROOT_KEYS = [
  'checkout',
  'files',
  'projectDigest',
  'projectId',
  'projectAssessment',
  'recordKind',
  'reviewPolicy',
  'reviewedAgainst',
  'reviewerRef',
  'rootPath',
  'schemaVersion',
];

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function posix(value) {
  return value.replace(/\\/gu, '/');
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function writeOrCheck(filePath, bytes) {
  if (!CHECK_ONLY) {
    fs.writeFileSync(filePath, bytes);
    return;
  }
  if (!fs.existsSync(filePath)) throw new Error(`missing generated review artifact: ${posix(path.relative(ROOT, filePath))}`);
  const actual = fs.readFileSync(filePath);
  if (!actual.equals(bytes)) throw new Error(`generated review drift: ${posix(path.relative(ROOT, filePath))}`);
}

function slug(name) {
  return name.normalize('NFC').replace(/_/gu, '-').toLowerCase();
}

function closedObject(value, keys, at) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${at}: expected object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${at}: closed fields mismatch; got ${actual.join(',')}`);
  }
}

function walkFiles(directory) {
  const result = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not reviewable: ${posix(path.relative(ROOT, absolute))}`);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) result.push(absolute);
      else throw new Error(`non-regular reference entry: ${posix(path.relative(ROOT, absolute))}`);
    }
  }
  walk(directory);
  return result.sort((a, b) => compareUtf8(posix(path.relative(ROOT, a)), posix(path.relative(ROOT, b))));
}

function readLock() {
  const document = YAML.parseDocument(fs.readFileSync(LOCK_PATH, 'utf8'), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('\n'));
  const lock = document.toJS({ maxAliasCount: 0 });
  const activeEvidence = collectActiveReferenceEvidence(ROOT, lock);
  const byRoot = new Map();
  for (const reference of lock.references || []) {
    if (typeof reference.localPath !== 'string' || !reference.localPath.startsWith('reference/project-reference/')) {
      continue;
    }
    const rootPath = reference.localPath.replace(/\/+$/u, '');
    const existing = byRoot.get(rootPath) || [];
    existing.push({
      locatorPaths: (reference.locators || []).map(
        (locator) => `${rootPath}/${locator.path}`,
      ).sort(compareUtf8),
      id: reference.id,
      releaseOrCommit: reference.releaseOrCommit,
    });
    byRoot.set(rootPath, existing);
  }
  return {
    byRoot,
    usedPaths: activeEvidence.usedPaths,
  };
}

function exactGitCheckout(projectRoot, lockRows) {
  const dotGit = path.join(projectRoot, '.git');
  if (!fs.existsSync(dotGit)) {
    return {
      clean: null,
      commit: null,
      lockPins: lockRows.map((row) => `${row.id}:${row.releaseOrCommit || 'missing'}`).sort(compareUtf8),
      pinAssessment: lockRows.length
        ? 'missingGitMetadataAndGenericLockPin'
        : 'missingGitMetadataAndNotLocked',
      state: 'missingGitMetadata',
    };
  }
  // Keep ownership trust local to the exact checked-in reference root.  This
  // makes evidence generation reproducible under CI/sandbox service accounts
  // without mutating global safe.directory state or trusting a wildcard.
  const gitPrefix = ['-c', `safe.directory=${projectRoot}`, '-C', projectRoot];
  const head = spawnSync('git', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
    shell: false,
  });
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(head.stdout.trim())) {
    return {
      clean: null,
      commit: null,
      lockPins: lockRows.map((row) => `${row.id}:${row.releaseOrCommit || 'missing'}`).sort(compareUtf8),
      pinAssessment: 'gitMetadataPresentButHeadUnreadable',
      state: 'unreadableGitCheckout',
    };
  }
  const status = spawnSync('git', [...gitPrefix, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    shell: false,
  });
  const dirty = status.status === 0
    ? status.stdout.split(/\r?\n/gu).filter(Boolean)
    : ['git status failed'];
  const lockPins = lockRows.map((row) => `${row.id}:${row.releaseOrCommit || 'missing'}`).sort(compareUtf8);
  const commit = head.stdout.trim();
  const exactPin = lockRows.some((row) => row.releaseOrCommit === commit);
  return {
    clean: dirty.length === 0,
    commit,
    lockPins,
    pinAssessment: lockRows.length === 0
      ? 'exactObservedCommitButProjectNotLocked'
      : (exactPin ? 'exactObservedCommitMatchesLock' : 'exactObservedCommitButLockUsesNonCommitPin'),
    state: dirty.length === 0 ? 'exactGitCheckout' : 'dirtyGitCheckout',
  };
}

function extensionOf(filePath) {
  const base = path.basename(filePath);
  if (base === 'Dockerfile') return '.dockerfile';
  if (base.startsWith('.') && !base.includes('.', 1)) return base.toLowerCase();
  return path.extname(base).toLowerCase();
}

function mediaTypeFor(filePath, bytes) {
  const extension = extensionOf(filePath);
  if (BINARY_MEDIA_BY_EXTENSION.has(extension)) {
    return { contentKind: 'binary', mediaType: BINARY_MEDIA_BY_EXTENSION.get(extension) };
  }
  if (TEXT_MEDIA_BY_EXTENSION.has(extension)) {
    return { contentKind: 'text', mediaType: TEXT_MEDIA_BY_EXTENSION.get(extension) };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { contentKind: 'text', mediaType: 'text/plain' };
  } catch {
    return { contentKind: 'binary', mediaType: 'application/octet-stream' };
  }
}

function sanitizeTerm(value) {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, 120);
}

function semanticScan(text) {
  const tags = [];
  const matchedTerms = {};
  for (const [tag, patterns] of SEMANTIC_RULES) {
    const matches = new Set();
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match && matches.size < 8; match = pattern.exec(text)) {
        matches.add(sanitizeTerm(match[0]).toLowerCase());
      }
    }
    if (matches.size > 0) {
      tags.push(tag);
      matchedTerms[tag] = [...matches].sort(compareUtf8);
    }
  }
  return { matchedTerms, tags: tags.sort(compareUtf8) };
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function inspectText(filePath, bytes, mediaType) {
  const extension = extensionOf(filePath);
  let text = decodeText(bytes);
  let parser = 'utf8-full-text';
  let structuredItemCount = 0;
  if (extension === '.ipynb') {
    const notebook = JSON.parse(text);
    if (!Array.isArray(notebook.cells)) throw new Error('notebook cells is not an array');
    text = notebook.cells.map((cell) => (
      Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')
    )).join('\n');
    parser = 'json-notebook-cells';
    structuredItemCount = notebook.cells.length;
  } else if (mediaType === 'application/json' && extension !== '.jsonc') {
    const parsed = JSON.parse(text);
    parser = 'json-parse-and-full-text';
    structuredItemCount = Array.isArray(parsed)
      ? parsed.length
      : (parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 1);
  } else if (mediaType === 'application/x-ndjson') {
    const rows = text.split(/\r?\n/gu).filter((row) => row.trim() !== '');
    for (const row of rows) JSON.parse(row);
    parser = 'ndjson-row-parse-and-full-text';
    structuredItemCount = rows.length;
  } else if (mediaType === 'application/yaml') {
    const parsed = YAML.parseAllDocuments(text, { prettyErrors: true, uniqueKeys: true });
    const errors = parsed.flatMap((document) => document.errors);
    if (errors.length) throw new Error(errors.map((error) => error.message).join('; '));
    parser = 'yaml-parse-and-full-text';
    structuredItemCount = parsed.length;
  } else if (mediaType === 'text/csv') {
    const rows = text.split(/\r?\n/gu);
    parser = 'delimited-full-text-with-header-inventory';
    structuredItemCount = Math.max(0, rows.length - (rows.at(-1) === '' ? 2 : 1));
  } else if (mediaType === 'application/xml' || mediaType === 'image/svg+xml') {
    const opens = (text.match(/<([A-Za-z_][\w:.-]*)(?:\s|>|\/>)/gu) || []).length;
    const closes = (text.match(/<\/([A-Za-z_][\w:.-]*)\s*>/gu) || []).length;
    if (!text.includes('<') || opens === 0) throw new Error('XML lexical structure not found');
    parser = 'xml-lexical-element-inventory-and-full-text';
    structuredItemCount = opens + closes;
  } else if (mediaType === 'text/html') {
    parser = 'html-lexical-element-inventory-and-full-text';
    structuredItemCount = (text.match(/<[A-Za-z][^>]*>/gu) || []).length;
  } else if (['.toml', '.ini', '.cfg', '.properties'].includes(extension)) {
    parser = 'key-value-line-parse-and-full-text';
    structuredItemCount = text.split(/\r?\n/gu).filter((line) => (
      /^\s*[A-Za-z0-9_.-]+\s*[=:]/u.test(line)
    )).length;
  } else if (['.md', '.rst'].includes(extension)) {
    parser = 'documentation-heading-inventory-and-full-text';
    structuredItemCount = text.split(/\r?\n/gu).filter((line) => (
      /^\s{0,3}#{1,6}\s+\S/u.test(line) || /^[=-]{3,}\s*$/u.test(line)
    )).length;
  } else if ([
    '.bash', '.bat', '.cs', '.csx', '.h', '.java', '.js', '.mjs', '.ps1',
    '.pxd', '.py', '.pyi', '.pyx', '.rs', '.sh', '.sql', '.ts', '.vue',
  ].includes(extension)) {
    parser = `language-aware-full-lexical-scan:${extension.slice(1)}`;
    structuredItemCount = (text.match(/\b(?:class|struct|enum|interface|trait|def|fn|function|record)\s+[A-Za-z_]\w*/gu) || []).length;
  }
  const semantics = semanticScan(text);
  return {
    inspection: {
      decodedBytes: bytes.length,
      lineCount: text === '' ? 0 : text.split(/\r?\n/gu).length,
      parser,
      structuredItemCount,
    },
    matchedTerms: semantics.matchedTerms,
    semanticTags: semantics.tags,
  };
}

function readUInt32BE(bytes, offset) {
  return bytes.length >= offset + 4 ? bytes.readUInt32BE(offset) : null;
}

function readUInt32LE(bytes, offset) {
  return bytes.length >= offset + 4 ? bytes.readUInt32LE(offset) : null;
}

function zipEntryInventory(bytes) {
  let offset = 0;
  let count = 0;
  const names = [];
  while (offset + 30 <= bytes.length && count < 100000) {
    const signature = readUInt32LE(bytes, offset);
    if (signature !== 0x04034b50) break;
    const compressedSize = readUInt32LE(bytes, offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (compressedSize === null || offset + 30 + nameLength + extraLength > bytes.length) break;
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (names.length < 12) names.push(name.normalize('NFC'));
    count += 1;
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return { entryCountLowerBound: count, entryNameSample: names.sort(compareUtf8) };
}

function inspectBinary(bytes, mediaType) {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 16)).toString('hex');
  let formatAssessment = 'opaque-binary-prefix-recorded';
  let metadata = {};
  if (mediaType === 'application/zip'
    || mediaType === 'application/java-archive'
    || mediaType.includes('openxmlformats')
    || mediaType.includes('oasis.opendocument')) {
    formatAssessment = prefix.startsWith('504b') ? 'zip-signature-observed' : 'zip-signature-missing';
    metadata = zipEntryInventory(bytes);
  } else if (mediaType === 'image/png') {
    formatAssessment = prefix.startsWith('89504e470d0a1a0a') ? 'png-signature-observed' : 'png-signature-missing';
    metadata = bytes.length >= 24
      ? { height: readUInt32BE(bytes, 20), width: readUInt32BE(bytes, 16) }
      : {};
  } else if (mediaType === 'image/gif') {
    formatAssessment = prefix.startsWith('47494638') ? 'gif-signature-observed' : 'gif-signature-missing';
    metadata = bytes.length >= 10 ? { height: bytes.readUInt16LE(8), width: bytes.readUInt16LE(6) } : {};
  } else if (mediaType === 'image/jpeg') {
    formatAssessment = prefix.startsWith('ffd8ff') ? 'jpeg-signature-observed' : 'jpeg-signature-missing';
  } else if (mediaType === 'application/pdf') {
    formatAssessment = prefix.startsWith('25504446') ? 'pdf-signature-observed' : 'pdf-signature-missing';
  } else if (mediaType === 'application/vnd.apache.parquet') {
    formatAssessment = prefix.startsWith('50415231') && bytes.subarray(-4).toString('hex') === '50415231'
      ? 'parquet-boundary-signatures-observed'
      : 'parquet-boundary-signature-missing';
  } else if (mediaType === 'application/vnd.apache.arrow.file') {
    formatAssessment = prefix.startsWith('4152524f5731') ? 'arrow-signature-observed' : 'arrow-signature-unconfirmed';
  } else if (mediaType === 'application/gzip') {
    formatAssessment = prefix.startsWith('1f8b') ? 'gzip-signature-observed' : 'gzip-signature-missing';
  } else if (mediaType === 'application/x-7z-compressed') {
    formatAssessment = prefix.startsWith('377abcaf271c') ? '7z-signature-observed' : '7z-signature-missing';
  } else if (mediaType === 'application/zstd') {
    formatAssessment = prefix.startsWith('28b52ffd') ? 'zstd-signature-observed' : 'zstd-signature-unconfirmed';
  }
  return {
    formatAssessment,
    metadata,
    prefixHex: prefix,
  };
}

function categoryFromPath(repoPath) {
  const lower = repoPath.toLowerCase();
  if (/(?:^|\/)(?:tests?|fixtures?|test[_-]?data|mock[_-]?data)(?:\/|$)/u.test(lower)) {
    return 'test-or-fixture';
  }
  if (/(?:^|\/)(?:docs?|documentation|examples?|tutorials?|notebooks?)(?:\/|$)/u.test(lower)) return 'documentation-or-example';
  if (/(?:^|\/)(?:vendor|third_party|node_modules|target|dist|build)(?:\/|$)/u.test(lower)) return 'generated-or-vendor';
  const base = path.posix.basename(lower);
  if (/^(?:license|copying|notice|authors?|contributors?|changelog|history)(?:[-_.].*)?$/u.test(base)) {
    return 'project-metadata';
  }
  if (/\.(?:toml|ya?ml|jsonc?|ini|cfg|config|csproj|lock|dockerfile|gitignore|gitattributes)$/u.test(lower)) return 'configuration';
  return 'implementation-or-documentation';
}

function reviewRationale(repoPath, disposition, semanticTags, category, decision = null) {
  if (disposition === 'usedImplementation') {
    return `Selected by an exact current machine-readable downstream implementation citation with detected M2 tags ${semanticTags.join(', ')}; this selection does not make project code normative authority or prove semantic equivalence.`;
  }
  if (disposition === 'binaryInspected') {
    return 'Exact bytes, digest, size, media signature, and available container/image metadata were inspected; binary payload was not semantically decoded and is not used as M2 ontology evidence.';
  }
  if (decision && ['reviewedNoBearing', 'reviewedRejected'].includes(disposition)) {
    return decision.rationale;
  }
  if (disposition === 'reviewedRejected') {
    const mappings = SEMANTIC_MAPPINGS.get(repoPath) || [];
    if (mappings.length > 0) {
      const assessments = mappings.map((mapping) => (
        `${mapping.sourceSymbol} -> ${mapping.m2Target} [${mapping.assessment}]: ${mapping.rationale}`
      )).join(' ');
      return `Explicit file-specific semantic mapping assessment: ${assessments} `
        + 'The project implementation remains contextual/implementation evidence and is not normative authority.';
    }
    throw new Error(
      `${repoPath}: reviewedRejected requires a digest-bound file-specific semantic decision`,
    );
  }
  if (disposition === 'pendingSemanticReview') {
    return semanticTags.length > 0
      ? `Digest-bound per-file semantic review is missing for detected M2 signal(s): ${semanticTags.join(', ')}. Automated token discovery is not a reviewedNoBearing decision.`
      : 'Digest-bound file-specific semantic review is missing. Absence of a token match does not establish that source code or documentation has no M2 bearing.';
  }
  if (semanticTags.length > 0) {
    throw new Error(`${repoPath}: semantic tags cannot be auto-classified as reviewedNoBearing`);
  }
  throw new Error(
    `${repoPath}: ${category} content has no independently authored semantic decision`,
  );
}

function inspectFile(
  filePath,
  usedPaths,
  semanticDecisions,
  usedSemanticDecisionPaths,
  projectSemanticEvidence,
  usedProjectSemanticEvidencePaths,
) {
  const repoPath = posix(path.relative(ROOT, filePath)).normalize('NFC');
  const bytes = fs.readFileSync(filePath);
  const artifactDigest = digest(bytes);
  const decision = resolveSemanticReviewDecision(semanticDecisions, repoPath, artifactDigest);
  if (decision) usedSemanticDecisionPaths.add(repoPath);
  const projectEvidence = projectSemanticEvidence.byPath.get(repoPath) || null;
  if (projectEvidence) {
    if (projectEvidence.artifactDigest !== artifactDigest) {
      throw new Error(`${repoPath}: project triage candidate digest does not match current bytes`);
    }
    usedProjectSemanticEvidencePaths.add(repoPath);
  }
  const media = mediaTypeFor(filePath, bytes);
  let detail;
  let reviewMethod;
  let disposition;
  if (media.contentKind === 'binary') {
    detail = {
      inspection: inspectBinary(bytes, media.mediaType),
      matchedTerms: {},
      semanticTags: [],
    };
    disposition = 'binaryInspected';
    reviewMethod = 'binary metadata inspection: exact-byte hash, size, prefix signature, and format-specific metadata where supported';
  } else {
    try {
      detail = inspectText(filePath, bytes, media.mediaType);
    } catch (error) {
      let text;
      try {
        text = decodeText(bytes);
      } catch {
        media.contentKind = 'binary';
        media.mediaType = 'application/octet-stream';
        detail = {
          inspection: inspectBinary(bytes, media.mediaType),
          matchedTerms: {},
          semanticTags: [],
        };
        disposition = 'binaryInspected';
        reviewMethod = 'binary metadata inspection after strict UTF-8 decode failure: exact-byte hash, size, and prefix signature';
      }
      if (text !== undefined) {
        const semantics = semanticScan(text);
        detail = {
          inspection: {
            decodedBytes: bytes.length,
            lineCount: text === '' ? 0 : text.split(/\r?\n/gu).length,
            parseError: String(error.message).slice(0, 500),
            parser: 'structured-parse-failed-full-lexical-review',
            structuredItemCount: 0,
          },
          matchedTerms: semantics.matchedTerms,
          semanticTags: semantics.tags,
        };
        disposition = usedPaths.has(repoPath)
          ? 'usedImplementation'
          : (SEMANTIC_MAPPINGS.has(repoPath) ? 'reviewedRejected' : undefined);
        reviewMethod = 'full UTF-8 lexical review after explicit structured-parser failure; parse error retained in inspection';
      }
    }
    if (media.contentKind === 'text') {
      const forced = FORCED_USED_TAGS.get(repoPath) || [];
      detail.semanticTags = [...new Set([
        ...detail.semanticTags,
        ...(projectEvidence?.semanticTags || []),
        ...forced,
      ])].sort(compareUtf8);
      for (const tag of forced) {
        if (!(tag in detail.matchedTerms)) detail.matchedTerms[tag] = ['lock-evidence-semantic-review'];
      }
      if (disposition === undefined) {
        if (usedPaths.has(repoPath)) disposition = 'usedImplementation';
        else if (SEMANTIC_MAPPINGS.has(repoPath)) disposition = 'reviewedRejected';
        else if (decision) disposition = decision.disposition;
        else disposition = 'pendingSemanticReview';
      }
      if (reviewMethod === undefined) {
        reviewMethod = decision
          ? decision.reviewMethod
          : `${projectEvidence?.reviewMethod || `deterministic UTF-8 parse and token classification: ${detail.inspection.parser}`}; pending an independently authored digest-bound semantic decision`;
      }
    }
  }
  if (disposition === 'usedImplementation' && detail.semanticTags.length === 0) {
    throw new Error(`${repoPath}: usedImplementation requires concrete semantic tags`);
  }
  if (decision && (usedPaths.has(repoPath) || SEMANTIC_MAPPINGS.has(repoPath))) {
    throw new Error(
      `${repoPath}: semantic review decision conflicts with active use or an explicit mapping assessment`,
    );
  }
  if (media.contentKind === 'binary' && decision) {
    throw new Error(`${repoPath}: semantic review decision cannot override binary metadata-only inspection`);
  }
  const category = categoryFromPath(repoPath);
  return {
    artifactDigest,
    byteLength: bytes.length,
    contentKind: media.contentKind,
    disposition,
    inspection: detail.inspection,
    matchedTerms: detail.matchedTerms,
    mediaType: media.mediaType,
    path: repoPath,
    rationale: reviewRationale(repoPath, disposition, detail.semanticTags, category, decision),
    reviewMethod,
    reviewerRef: disposition === 'pendingSemanticReview'
      ? null : (decision?.reviewerRef || REVIEWER_REF),
    semanticMappings: SEMANTIC_MAPPINGS.get(repoPath) || [],
    semanticTags: detail.semanticTags,
  };
}

function projectDigest(projectRoot, files) {
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relative = posix(path.relative(projectRoot, path.resolve(ROOT, file.path))).normalize('NFC');
    const pathBytes = Buffer.from(relative, 'utf8');
    hash.update(u64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(u64be(file.byteLength));
    const bytes = fs.readFileSync(path.resolve(ROOT, file.path));
    if (digest(bytes) !== file.artifactDigest) throw new Error(`${file.path}: changed during review`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateReviewRecord(record, activePublicIris) {
  closedObject(record, REVIEW_ROOT_KEYS, record.projectId);
  if (record.schemaVersion !== '1.0' || record.recordKind !== 'projectReferenceReview') {
    throw new Error(`${record.projectId}: invalid review record discriminator`);
  }
  closedObject(
    record.checkout,
    ['clean', 'commit', 'lockPins', 'pinAssessment', 'state'],
    `${record.projectId}.checkout`,
  );
  closedObject(
    record.projectAssessment,
    ['authorityBoundary', 'primaryTags', 'projectScopeAssessment', 'selectionDecision'],
    `${record.projectId}.projectAssessment`,
  );
  closedObject(
    record.reviewPolicy,
    ['binaryScope', 'dispositionPolicy', 'parseFailurePolicy', 'semanticRuleSet'],
    `${record.projectId}.reviewPolicy`,
  );
  closedObject(
    record.reviewedAgainst,
    ['moduleRefs', 'rfcReferenceContractRef'],
    `${record.projectId}.reviewedAgainst`,
  );
  let previous = null;
  for (const [index, file] of record.files.entries()) {
    closedObject(file, REVIEW_FILE_KEYS, `${record.projectId}.files[${index}]`);
    if (previous !== null && compareUtf8(previous, file.path) >= 0) {
      throw new Error(`${record.projectId}: file rows are not strictly UTF-8 path sorted`);
    }
    previous = file.path;
    if (!file.reviewMethod.trim() || !file.rationale.trim()) throw new Error(`${file.path}: empty review evidence`);
    if (![
      'binaryInspected',
      'pendingSemanticReview',
      'reviewedNoBearing',
      'reviewedRejected',
      'usedImplementation',
    ].includes(file.disposition)) {
      throw new Error(`${file.path}: unresolved or invalid review disposition ${file.disposition}`);
    }
    if (file.disposition === 'usedImplementation' && file.semanticTags.length === 0) {
      throw new Error(`${file.path}: used implementation file lacks semantic tags`);
    }
    if (file.disposition === 'pendingSemanticReview') {
      if (file.reviewerRef !== null) {
        throw new Error(`${file.path}: pending semantic review must not claim a reviewer`);
      }
    } else if (typeof file.reviewerRef !== 'string' || file.reviewerRef.trim() === '') {
      throw new Error(`${file.path}: resolved disposition requires a non-empty reviewerRef`);
    }
    for (const mapping of file.semanticMappings) {
      closedObject(
        mapping,
        ['assessment', 'm2Target', 'rationale', 'sourceSymbol'],
        `${file.path}.semanticMappings`,
      );
      if (!['exact', 'partial', 'conflict', 'pending'].includes(mapping.assessment)) {
        throw new Error(`${file.path}: invalid semantic mapping assessment`);
      }
      if (!['usedImplementation', 'reviewedRejected'].includes(file.disposition)) {
        throw new Error(`${file.path}: semantic mapping must be usedImplementation or reviewedRejected`);
      }
      if (!activePublicIris.has(mapping.m2Target)) {
        throw new Error(
          `${file.path}: semantic mapping target is not an active M2 public IRI: ${mapping.m2Target}`,
        );
      }
    }
    if (file.contentKind === 'binary' && file.disposition !== 'binaryInspected') {
      throw new Error(`${file.path}: binary file has non-binary disposition`);
    }
  }
}

function artifactRef(repoPath) {
  return { kind: 'path', path: repoPath, root: 'sourceTree' };
}

function loadActivePublicIris() {
  if (!fs.existsSync(PUBLIC_SYMBOL_MANIFEST_PATH)) {
    throw new Error('public-symbol-manifest.json is required before project-reference review');
  }
  const manifest = JSON.parse(fs.readFileSync(PUBLIC_SYMBOL_MANIFEST_PATH, 'utf8'));
  if (manifest?.schemaVersion !== '1.0'
      || manifest?.profileRef !== 'https://axiolune.ai/conformance/m2/0.3.0'
      || !Array.isArray(manifest.symbols)
      || manifest.symbols.length === 0) {
    throw new Error('public-symbol-manifest.json is not the active M2 v0.3 manifest');
  }
  const active = new Set();
  for (const [index, symbol] of manifest.symbols.entries()) {
    if (typeof symbol?.publicIri !== 'string' || active.has(symbol.publicIri)) {
      throw new Error(`public-symbol-manifest.json.symbols[${index}] is invalid or duplicated`);
    }
    active.add(symbol.publicIri);
  }
  return active;
}

function validateSemanticMappingTargets(activePublicIris) {
  for (const [sourcePath, mappings] of SEMANTIC_MAPPINGS.entries()) {
    const keys = new Set();
    for (const [index, mapping] of mappings.entries()) {
      if (!activePublicIris.has(mapping.m2Target)) {
        throw new Error(
          `${sourcePath}.semanticMappings[${index}] targets inactive M2 IRI ${mapping.m2Target}`,
        );
      }
      const key = `${mapping.sourceSymbol}\0${mapping.m2Target}`;
      if (keys.has(key)) {
        throw new Error(`${sourcePath}: duplicate semantic mapping ${key.replace('\0', ' -> ')}`);
      }
      keys.add(key);
    }
  }
}

function generate() {
  const activePublicIris = loadActivePublicIris();
  validateSemanticMappingTargets(activePublicIris);
  const lock = readLock();
  const semanticDecisions = loadSemanticReviewDecisions({
    manifestPath: SEMANTIC_REVIEW_DECISIONS_PATH,
    rootDir: ROOT,
  });
  const projectSemanticEvidence = loadProjectReferenceSemanticEvidence({
    evidencePath: PROJECT_SEMANTIC_EVIDENCE_PATH,
    rootDir: ROOT,
  });
  const usedSemanticDecisionPaths = new Set();
  const usedProjectSemanticEvidencePaths = new Set();
  const projectEntries = fs.readdirSync(REFERENCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => compareUtf8(slug(a.name), slug(b.name)));
  const inspectedProjects = projectEntries.map((projectEntry) => {
    const projectRoot = path.join(REFERENCE_ROOT, projectEntry.name);
    const rootPath = posix(path.relative(ROOT, projectRoot));
    const projectId = slug(projectEntry.name);
    const lockRows = lock.byRoot.get(rootPath) || [];
    const checkout = exactGitCheckout(projectRoot, lockRows);
    const files = walkFiles(projectRoot).map((filePath) => inspectFile(
      filePath,
      lock.usedPaths,
      semanticDecisions,
      usedSemanticDecisionPaths,
      projectSemanticEvidence,
      usedProjectSemanticEvidencePaths,
    ));
    return {
      checkout,
      files,
      projectId,
      projectRoot,
      rootPath,
    };
  });
  const pendingSemanticReviewCount = inspectedProjects.reduce((total, project) => (
    total + project.files.filter((file) => file.disposition === 'pendingSemanticReview').length
  ), 0);
  const unusedSemanticDecisions = findUnusedDecisions(
    semanticDecisions,
    usedSemanticDecisionPaths,
    'reference/project-reference',
  );
  const unusedProjectSemanticEvidence = [...projectSemanticEvidence.byPath.keys()]
    .filter((filePath) => !usedProjectSemanticEvidencePaths.has(filePath))
    .sort(compareUtf8);
  if (unusedSemanticDecisions.length > 0
      || unusedProjectSemanticEvidence.length > 0) {
    const samples = [
      ...unusedSemanticDecisions.slice(0, 50).map((entry) => `orphan ${entry}`),
      ...unusedProjectSemanticEvidence.slice(0, 50).map((entry) => `orphan-evidence ${entry}`),
    ];
    throw new Error(
      `project-reference review inventory is invalid: `
      + `${unusedSemanticDecisions.length} orphan decision(s), `
      + `${unusedProjectSemanticEvidence.length} orphan evidence record(s)`
      + `${samples.length > 0 ? `; ${samples.join('; ')}` : ''}`,
    );
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const coverageProjects = [];
  const summaries = [];
  for (const inspectedProject of inspectedProjects) {
    const {
      checkout,
      files,
      projectId,
      projectRoot,
      rootPath,
    } = inspectedProject;
    const record = {
      checkout,
      files,
      projectDigest: projectDigest(projectRoot, files),
      projectId,
      projectAssessment: {
        authorityBoundary: 'Project implementation may support implementation alignment only and is not normative financial authority.',
        ...PROJECT_ASSESSMENTS.get(projectId),
      },
      recordKind: 'projectReferenceReview',
      reviewPolicy: {
        binaryScope: 'metadataOnlyNoSemanticDecode',
        dispositionPolicy: 'Only exact locators selected by current machine-readable authority candidates or required profiles are usedImplementation; explicit mapping candidates are reviewedRejected; every other decoded file remains pendingSemanticReview until an independently authored digest-bound decision exists; automated triage cannot produce reviewedNoBearing/reviewedRejected; binaries are binaryInspected metadata-only.',
        parseFailurePolicy: 'fatalAndUnreviewedNotEmitted',
        semanticRuleSet: SEMANTIC_RULES.map(([tag]) => tag).sort(compareUtf8),
      },
      reviewedAgainst: {
        moduleRefs: MODULE_REFS,
        rfcReferenceContractRef: RFC_REF,
      },
      reviewerRef: RECORD_PRODUCER_REF,
      rootPath,
      schemaVersion: '1.0',
    };
    validateReviewRecord(record, activePublicIris);
    const recordName = `${projectId}.review.json`;
    const recordPath = path.join(OUTPUT_ROOT, recordName);
    const recordBytes = Buffer.from(canonicalJcs(record), 'utf8');
    writeOrCheck(recordPath, recordBytes);
    const reviewRecordDigest = digest(recordBytes);
    const reviewRecordRef = artifactRef(posix(path.relative(ROOT, recordPath)));
    const coverageProject = {
      files: files.map((file) => ({
        artifactDigest: file.artifactDigest,
        disposition: file.disposition,
        mediaType: file.mediaType,
        path: file.path,
        rationale: file.rationale,
        reviewMethod: file.reviewMethod,
        reviewRecordDigest,
        reviewRecordRef,
        reviewerRef: file.reviewerRef,
      })),
      projectDigest: record.projectDigest,
      projectId,
      rootPath,
    };
    if (checkout.state === 'exactGitCheckout') coverageProject.releaseOrCommit = checkout.commit;
    coverageProjects.push(coverageProject);
    const dispositionCounts = Object.fromEntries([...new Set(files.map((file) => file.disposition))]
      .sort(compareUtf8)
      .map((disposition) => [disposition, files.filter((file) => file.disposition === disposition).length]));
    const tagCounts = Object.fromEntries(SEMANTIC_RULES.map(([tag]) => [
      tag,
      files.filter((file) => file.semanticTags.includes(tag)).length,
    ]).filter(([, count]) => count > 0));
    summaries.push({
      checkout,
      dispositionCounts,
      fileCount: files.length,
      projectId,
      tagCounts,
    });
  }
  coverageProjects.sort((a, b) => compareUtf8(a.projectId, b.projectId));
  const fragment = {
    category: 'project-reference',
    projects: coverageProjects,
    schemaVersion: '1.0',
  };
  const fragmentBytes = Buffer.from(canonicalJcs(fragment), 'utf8');
  writeOrCheck(FRAGMENT_PATH, fragmentBytes);

  for (const project of fragment.projects) {
    let previous = null;
    for (const [index, row] of project.files.entries()) {
      closedObject(row, COVERAGE_FILE_KEYS, `${project.projectId}.coverage.files[${index}]`);
      if (previous !== null && compareUtf8(previous, row.path) >= 0) {
        throw new Error(`${project.projectId}: coverage rows not strictly sorted`);
      }
      previous = row.path;
      const reviewPath = path.resolve(ROOT, row.reviewRecordRef.path);
      if (digest(fs.readFileSync(reviewPath)) !== row.reviewRecordDigest) {
        throw new Error(`${row.path}: review record digest join failed`);
      }
    }
  }
  if (fs.readFileSync(FRAGMENT_PATH, 'utf8') !== canonicalJcs(JSON.parse(fs.readFileSync(FRAGMENT_PATH, 'utf8')))) {
    throw new Error('coverage fragment is not exact JCS');
  }
  for (const summary of summaries) process.stdout.write(`${JSON.stringify(summary)}\n`);
  const verb = CHECK_ONLY ? 'Verified' : 'Wrote';
  process.stdout.write(`${verb} ${coverageProjects.length} review inventories and ${coverageProjects.reduce((n, p) => n + p.files.length, 0)} coverage rows; pendingSemanticReview=${pendingSemanticReviewCount}.\n`);
}

if (require.main === module) generate();

module.exports = {
  PROJECT_ASSESSMENTS,
  SEMANTIC_MAPPINGS,
  SEMANTIC_RULES,
  categoryFromPath,
  compareUtf8,
  digest,
  extensionOf,
  inspectText,
  mediaTypeFor,
  posix,
  reviewRationale,
  semanticScan,
  walkFiles,
};
